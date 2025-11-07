// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/manager/AccessManaged.sol";

interface IVaultEpochSource {
    function currentEpochId() external view returns (uint256);
}

// @title Tranche with epoch-based umbrella unstake and optional POL/Junior mode
// @notice Users request unstake -> shares stay on tranche under umbrella -> after N epochs admin finalizes -> users claim.
contract Tranche is ERC4626, AccessManaged, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS = 10_000;

    address public immutable vault;
    uint256 public immutable trancheId;

    uint256 public unstakeDelayEpochs;

    bool public depositLimitEnabled;
    uint256 public maxDepositCap;
    uint256 public maxDepositTvlBps;

    mapping(uint256 => uint256) public umbrellaSharesByEpoch;

    mapping(address => mapping(uint256 => uint256)) public userSharesByEpoch;

    struct FinalizedEpoch {
        uint256 totalShares;
        uint256 totalAssets;
        bool isFinalized;
    }
    mapping(uint256 => FinalizedEpoch) public finalizedEpochs;

    bool public isPolJunior;
    address public polPayout;

    event UnstakeRequested(
        address indexed user,
        uint256 shares,
        uint256 requestEpoch,
        uint256 targetEpoch
    );
    event EpochFinalized(
        uint256 indexed epochId,
        uint256 sharesBurned,
        uint256 assetsFinal
    );
    event UnstakeDelayUpdated(uint256 newDelayEpochs);
    event DepositLimitUpdated(bool enabled, uint256 cap, uint256 tvlBps);
    event PolJuniorUpdated(bool enabled, address payout);
    event PolPayout(uint256 amount);
    event WithdrawalClaimed(address indexed user, uint256 indexed epochId, uint256 assets);

    error InvalidAmount();
    error DepositLimitExceeded(uint256 attempted, uint256 limit);
    error NothingToFinalize();
    error EpochNotPassed();
    error NotFinalized();
    error NothingToClaim();
    error ZeroAddress();

    constructor(
        IERC20 assetToken,
        address vaultAddress,
        uint256 trancheIdentifier,
        uint256 initialUnstakeDelayEpochs,
        string memory name_,
        string memory symbol_,
        address accessManager,
        bool polJuniorMode,
        address polPayoutAddress
    )
        ERC20(name_, symbol_)
        ERC4626(assetToken)
        AccessManaged(accessManager)
    {
        if (vaultAddress == address(0) || polPayoutAddress == address(0) || accessManager == address(0)) revert ZeroAddress();
        vault = vaultAddress;
        trancheId = trancheIdentifier;
        unstakeDelayEpochs = initialUnstakeDelayEpochs;
        isPolJunior = polJuniorMode;
        polPayout = polPayoutAddress;
    }

    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
        _unpause();
    }

    function sweepPol() external restricted {
        if (!isPolJunior) revert InvalidAmount();
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        IERC20(asset()).safeTransfer(polPayout, balance);
        emit PolPayout(balance);
    }

    function setPolJuniorMode(bool enabled, address payout) external restricted {
        if (enabled || payout == address(0)) revert ZeroAddress();
        isPolJunior = enabled;
        polPayout = payout;
        emit PolJuniorUpdated(enabled, payout);
    }

    function deposit(
        uint256 assets,
        address receiver
    ) public override whenNotPaused nonReentrant returns (uint256 shares) {
        if (isPolJunior) revert InvalidAmount();
        _checkDepositLimit(assets);
        shares = super.deposit(assets, receiver);
    }

    function requestWithdrawal(
        uint256 shares
    ) external whenNotPaused nonReentrant {
        if (isPolJunior) revert InvalidAmount();
        if (shares == 0 || balanceOf(msg.sender) < shares) revert InvalidAmount();

        uint256 currentVaultEpoch = IVaultEpochSource(vault).currentEpochId();
        uint256 targetEpoch = currentVaultEpoch + unstakeDelayEpochs;

        umbrellaSharesByEpoch[targetEpoch] += shares;
        userSharesByEpoch[msg.sender][targetEpoch] += shares;

        _transfer(msg.sender, address(this), shares);

        emit UnstakeRequested(msg.sender, shares, currentVaultEpoch, targetEpoch);
    }

    function finalizeEpoch(uint256 epochId)
        external
        nonReentrant
        whenNotPaused
        restricted
    {
        uint256 currentVaultEpoch = IVaultEpochSource(vault).currentEpochId();
        if (currentVaultEpoch <= epochId) revert EpochNotPassed();

        uint256 sharesToFinalize = umbrellaSharesByEpoch[epochId];
        if (sharesToFinalize == 0) revert NothingToFinalize();

        umbrellaSharesByEpoch[epochId] = 0;

        uint256 assetsToCredit = convertToAssets(sharesToFinalize);

        finalizedEpochs[epochId] = FinalizedEpoch({
            totalShares: sharesToFinalize,
            totalAssets: assetsToCredit,
            isFinalized: true
        });

        _burn(address(this), sharesToFinalize);

        emit EpochFinalized(epochId, sharesToFinalize, assetsToCredit);
    }

    function claim(uint256 epochId) external nonReentrant whenNotPaused {
        uint256 userShares = userSharesByEpoch[msg.sender][epochId];
        if (userShares == 0) revert NothingToClaim();

        FinalizedEpoch memory finalizedData = finalizedEpochs[epochId];
        if (!finalizedData.isFinalized) revert NotFinalized();

        // user keeps tranche exposure until this moment because shares stayed on tranche
        // assets are stored on this contract and only transferred out on claim
        uint256 userAssets = (userShares * finalizedData.totalAssets) / finalizedData.totalShares;

        userSharesByEpoch[msg.sender][epochId] = 0;

        IERC20(asset()).safeTransfer(msg.sender, userAssets);

        emit WithdrawalClaimed(msg.sender, epochId, userAssets);
    }

    function setUnstakeDelayEpochs(uint256 epochsDelay) external restricted {
        unstakeDelayEpochs = epochsDelay;
        emit UnstakeDelayUpdated(epochsDelay);
    }

    function setDepositLimits(
        bool enabled,
        uint256 cap,
        uint256 tvlBps
    ) external restricted {
        if (tvlBps > BASIS_POINTS) revert InvalidAmount();
        depositLimitEnabled = enabled;
        maxDepositCap = cap;
        maxDepositTvlBps = tvlBps;
        emit DepositLimitUpdated(enabled, cap, tvlBps);
    }

    function pricePerShare() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    function _checkDepositLimit(uint256 amount) internal view {
        if (!depositLimitEnabled) return;

        uint256 totalVaultAssets = totalAssets();
        uint256 limitByTvl = totalVaultAssets == 0
            ? type(uint256).max
            : (totalVaultAssets * maxDepositTvlBps) / BASIS_POINTS;

        uint256 finalLimit = limitByTvl;
        if (maxDepositCap != 0 && maxDepositCap < finalLimit) {
            finalLimit = maxDepositCap;
        }

        if (amount > finalLimit) {
            revert DepositLimitExceeded(amount, finalLimit);
        }
    }
}