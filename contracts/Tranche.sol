// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IVaultEpochSource {
    function currentEpochId() external view returns (uint256);
    function minEpochDuration() external view returns (uint256);
}

// @title Tranche with epoch-based umbrella unstake and optional POL/Junior mode
// @notice Users request unstake -> shares stay on tranche under umbrella -> after N epochs admin finalizes -> users claim.
// @dev Added linear yield streaming: vault sends yield in a lump sum, tranche streams it linearly in NAV.
contract Tranche is
    Initializable,
    ERC4626Upgradeable,
    AccessManagedUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS = 10_000;

    address public vault;
    uint256 public trancheId;

    uint256 public unstakeDelayEpochs;

    bool public depositLimitEnabled;
    uint256 public maxDepositCap;
    uint256 public maxDepositTvlBps;

    // umbrella withdrawals
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

    // ======== YIELD STREAMING (linear distribution over epoch) ========

    /// @notice Amount of yield (MZUSD) that is being streamed linearly into NAV.
    /// @dev These tokens are already on the tranche balance, but not yet fully reflected in price per share.
    uint256 public yieldStreamingAmount;

    /// @notice Timestamp when current yield streaming started.
    uint256 public yieldStreamStart;

    /// @notice Timestamp when current yield streaming should finish (all yield accrued).
    uint256 public yieldStreamEnd;

    // ======== Events ========

    event UnstakeRequested(
        address indexed user,
        uint256 shares,
        uint256 requestEpoch,
        uint256 targetEpoch
    );
    event EpochFinalized(uint256 indexed epochId, uint256 sharesBurned, uint256 assetsFinal);
    event UnstakeDelayUpdated(uint256 newDelayEpochs);
    event DepositLimitUpdated(bool enabled, uint256 cap, uint256 tvlBps);
    event PolJuniorUpdated(bool enabled, address payout);
    event PolPayout(uint256 amount);
    event WithdrawalClaimed(address indexed user, uint256 indexed epochId, uint256 assets);

    /// @notice Emitted when new yield is registered for linear streaming.
    /// @dev `yieldAmount` must correspond to MZUSD already transferred to this tranche.
    event YieldNotified(
        uint256 indexed epochId,
        uint256 yieldAmount,
        uint256 streamStart,
        uint256 streamEnd
    );

    // ======== Errors ========

    error InvalidAmount();
    error DepositLimitExceeded(uint256 attempted, uint256 limit);
    error NothingToFinalize();
    error EpochNotPassed();
    error NotFinalized();
    error NothingToClaim();
    error ZeroAddress();
    error YieldStreamActive(); // cannot override active yield stream

    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 assetToken,
        address vaultAddress,
        uint256 trancheIdentifier,
        uint256 initialUnstakeDelayEpochs,
        string memory name_,
        string memory symbol_,
        address accessManager,
        bool polJuniorMode,
        address polPayoutAddress
    ) external initializer {
        if (
            vaultAddress == address(0) ||
            polPayoutAddress == address(0) ||
            accessManager == address(0)
        ) {
            revert ZeroAddress();
        }

        __ERC20_init(name_, symbol_);
        __ERC4626_init(assetToken);
        __AccessManaged_init(accessManager);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        vault = vaultAddress;
        trancheId = trancheIdentifier;
        unstakeDelayEpochs = initialUnstakeDelayEpochs;
        isPolJunior = polJuniorMode;
        polPayout = polPayoutAddress;
    }

    // ==================== Admin / POL ====================

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

    // ==================== Linear yield streaming ====================

    /// @notice Registers `yieldAmount` of MZUSD as yield to be streamed linearly over next epoch.
    /// @dev Assumes `yieldAmount` tokens are already transferred to this contract (from Vault).
    ///      This does NOT transfer tokens, it only affects accounting (virtual NAV).
    /// @param yieldAmount Amount of yield (MZUSD, 18d) to stream.
    function notifyYield(uint256 yieldAmount) external restricted {
        if (yieldAmount == 0) revert InvalidAmount();

        // Do not allow overriding active stream (optional — можно снять, если хочешь перезапись)
        if (yieldStreamingAmount != 0 && block.timestamp < yieldStreamEnd) {
            revert YieldStreamActive();
        }

        uint256 duration = IVaultEpochSource(vault).minEpochDuration();
        if (duration == 0) revert InvalidAmount();

        yieldStreamingAmount = yieldAmount;
        yieldStreamStart = block.timestamp;
        yieldStreamEnd = block.timestamp + duration;

        uint256 epochId = IVaultEpochSource(vault).currentEpochId();
        emit YieldNotified(epochId, yieldAmount, yieldStreamStart, yieldStreamEnd);
    }

    /// @notice Returns how much of current yield is still not accrued into NAV.
    /// @dev This is what we subtract from raw balance in totalAssets().
    function _unaccruedYield() internal view returns (uint256) {
        uint256 amount = yieldStreamingAmount;
        if (amount == 0) return 0;

        uint256 start = yieldStreamStart;
        uint256 end = yieldStreamEnd;
        uint256 ts = block.timestamp;

        if (ts <= start) {
            // streaming not started yet: entire amount is unaccrued
            return amount;
        }

        if (ts >= end || end <= start) {
            // fully accrued or invalid config
            return 0;
        }

        uint256 elapsed = ts - start;
        uint256 duration = end - start;

        uint256 accrued = (amount * elapsed) / duration;
        if (accrued >= amount) return 0;
        return amount - accrued;
    }

    // ==================== ERC4626 overrides (NAV with linear yield) ====================

    /// @notice Virtual total assets backing tranche shares.
    /// @dev Real balance minus not-yet-accrued yield. This is what drives pricePerShare.
    function totalAssets() public view override returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 unaccrued = _unaccruedYield();

        if (unaccrued > balance) {
            // Should not happen if notifyYield is used correctly, but guard against underflow.
            return 0;
        }

        return balance - unaccrued;
    }

    /// @notice Convenience view: price per share using virtual NAV.
    function pricePerShare() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    // ==================== Core user flows ====================

    function deposit(
        uint256 assets,
        address receiver
    ) public override whenNotPaused nonReentrant returns (uint256 shares) {
        if (isPolJunior) revert InvalidAmount();
        _checkDepositLimit(assets);
        // ERC4626 uses totalAssets() (with virtual NAV) under the hood:
        shares = super.deposit(assets, receiver);
    }

    function requestWithdrawal(uint256 shares) external whenNotPaused nonReentrant {
        if (isPolJunior) revert InvalidAmount();
        if (shares == 0 || balanceOf(_msgSender()) < shares) revert InvalidAmount();

        uint256 currentVaultEpoch = IVaultEpochSource(vault).currentEpochId();
        uint256 targetEpoch = currentVaultEpoch + unstakeDelayEpochs;

        umbrellaSharesByEpoch[targetEpoch] += shares;
        userSharesByEpoch[_msgSender()][targetEpoch] += shares;

        _transfer(_msgSender(), address(this), shares);

        emit UnstakeRequested(_msgSender(), shares, currentVaultEpoch, targetEpoch);
    }

    function finalizeEpoch(uint256 epochId) external nonReentrant whenNotPaused restricted {
        uint256 currentVaultEpoch = IVaultEpochSource(vault).currentEpochId();
        if (currentVaultEpoch <= epochId) revert EpochNotPassed();

        uint256 sharesToFinalize = umbrellaSharesByEpoch[epochId];
        if (sharesToFinalize == 0) revert NothingToFinalize();

        umbrellaSharesByEpoch[epochId] = 0;

        // use virtual NAV at the moment of finalization
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
        uint256 userShares = userSharesByEpoch[_msgSender()][epochId];
        if (userShares == 0) revert NothingToClaim();

        FinalizedEpoch memory finalizedData = finalizedEpochs[epochId];
        if (!finalizedData.isFinalized) revert NotFinalized();

        // user keeps tranche exposure until this moment because shares stayed on tranche
        // assets are stored on this contract and only transferred out on claim
        uint256 userAssets = (userShares * finalizedData.totalAssets) / finalizedData.totalShares;

        userSharesByEpoch[_msgSender()][epochId] = 0;

        IERC20(asset()).safeTransfer(_msgSender(), userAssets);

        emit WithdrawalClaimed(_msgSender(), epochId, userAssets);
    }

    // ==================== Admin config ====================

    function setUnstakeDelayEpochs(uint256 epochsDelay) external restricted {
        unstakeDelayEpochs = epochsDelay;
        emit UnstakeDelayUpdated(epochsDelay);
    }

    function setDepositLimits(bool enabled, uint256 cap, uint256 tvlBps) external restricted {
        if (tvlBps > BASIS_POINTS) revert InvalidAmount();
        depositLimitEnabled = enabled;
        maxDepositCap = cap;
        maxDepositTvlBps = tvlBps;
        emit DepositLimitUpdated(enabled, cap, tvlBps);
    }

    // ==================== Internal helpers ====================

    function _checkDepositLimit(uint256 amount) internal view {
        if (!depositLimitEnabled) return;

        uint256 totalVaultAssets = totalAssets(); // virtual TVL with streaming
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

    function _authorizeUpgrade(address newImplementation) internal override restricted {}
}
