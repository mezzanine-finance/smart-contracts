// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IVault {
    function currentEpochId() external view returns (uint256);
    function epochDuration() external view returns (uint256);
}

// @title Tranche with epoch-based umbrella unstake and optional POL/Junior mode
// solhint-disable-next-line max-line-length
// @notice Users request unstake -> shares stay on tranche under umbrella -> after N epochs admin finalizes -> users claim.
// @dev Linear yield streaming: vault sends yield in a lump sum, tranche streams it linearly in NAV.
contract Tranche is
    Initializable,
    ERC4626Upgradeable,
    AccessManagedUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    struct FinalizedEpoch {
        uint256 totalShares;
        uint256 totalAssets;
        bool isFinalized;
    }

    uint256 public constant BASIS_POINTS = 10_000;

    address public vault;
    uint256 public trancheId;

    uint256 public unstakeDelayEpochs;

    bool public depositLimitEnabled;
    uint256 public maxDepositCap;
    uint256 public maxDepositTvlBps;

    bool public isPolJunior;
    address public polPayout;

    // YIELD STREAMING (linear distribution over epoch)
    /// @notice Amount of yield (MZUSD) that is being streamed linearly into NAV.
    /// @dev These tokens are already on the tranche balance, but not yet fully reflected in price per share.
    uint256 public yieldStreamingAmount;

    /// @notice Timestamp when current yield streaming started.
    uint256 public yieldStreamStart;

    /// @notice Timestamp when current yield streaming should finish (all yield accrued).
    uint256 public yieldStreamEnd;

    mapping(uint256 => FinalizedEpoch) public finalizedEpochs;

    // umbrella withdrawals
    mapping(uint256 => uint256) public umbrellaSharesByEpoch;
    mapping(address => mapping(uint256 => uint256)) public userSharesByEpoch;

    event UnstakeRequested(
        address indexed user,
        uint256 shares,
        uint256 requestEpoch,
        uint256 targetEpoch
    );
    event UnstakeCancelled(
        address indexed user,
        uint256 indexed epochId,
        uint256 shares
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
    event WithdrawalClaimed(
        address indexed user,
        uint256 indexed epochId,
        uint256 assets
    );

    /// @notice Emitted when new yield is registered for linear streaming.
    /// @dev yieldAmount must correspond to MZUSD amount already transferred to this tranche.
    event YieldNotified(
        uint256 indexed epochId,
        uint256 yieldAmount,
        uint256 streamStart,
        uint256 streamEnd
    );

    error InvalidAmount();
    error DepositLimitExceeded(uint256 attempted, uint256 limit);
    error NothingToFinalize();
    error EpochNotPassed();
    error NotFinalized();
    error NothingToClaim();
    error ZeroAddress();
    error YieldStreamIsActive();
    error AlreadyFinalized();
    error NoPendingUnstake();
    error InvalidMode();
    error ZeroPassedShares();
    error InvalidShares();
    error InvalidBalance();
    error ZeroYieldPassed();
    error ZeroEpochDuration();
    error ZeroPolPayoutAddressWhileModeIsOn();
    error TooLateToCancel();

    constructor() {
        _disableInitializers();
    }

    //@dev polPayout can be zero address initially, because polJuniorMode can be false
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
            accessManager == address(0) ||
            address(assetToken) == address(0)
        ) revert ZeroAddress();

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

        if (polJuniorMode && polPayoutAddress == address(0)) {
            revert ZeroPolPayoutAddressWhileModeIsOn();
        }
        polPayout = polPayoutAddress;
    }

    // CORE USER FUNCTIONS
    function deposit(
        uint256 assets,
        address receiver
    ) public override whenNotPaused nonReentrant returns (uint256 shares) {
        if (isPolJunior) revert InvalidMode();
        _checkDepositLimit(assets);
        // ERC4626 uses totalAssets() (with virtual NAV) under the hood:
        shares = super.deposit(assets, receiver);
    }

    function requestWithdrawal(
        uint256 shares
    ) external whenNotPaused nonReentrant {
        if (isPolJunior) revert InvalidMode();
        if (shares == 0) revert ZeroPassedShares();
        if (balanceOf(_msgSender()) < shares) revert InvalidBalance();

        uint256 currentVaultEpoch = IVault(vault).currentEpochId();
        uint256 targetEpoch = currentVaultEpoch + unstakeDelayEpochs;

        umbrellaSharesByEpoch[targetEpoch] += shares;
        userSharesByEpoch[_msgSender()][targetEpoch] += shares;

        _transfer(_msgSender(), address(this), shares);

        emit UnstakeRequested(
            _msgSender(),
            shares,
            currentVaultEpoch,
            targetEpoch
        );
    }

    /// @notice Cancel a previously requested unstake for a given epoch.
    /// @dev User can only cancel shares that are still pending under the umbrella and
    ///      for epochs that have not yet been finalized.
    /// @param epochId The epoch for which the user wants to cancel their unstake.
    /// @param shares The amount of shares to cancel (returned back to the user).
    function cancelUnstake(
        uint256 epochId,
        uint256 shares
    ) external nonReentrant whenNotPaused {
        uint256 userShares = userSharesByEpoch[_msgSender()][epochId];
        if (userShares == 0) revert NoPendingUnstake();
        if (shares == 0) revert ZeroPassedShares();
        if (shares > userShares) revert InvalidShares();

        if (finalizedEpochs[epochId].isFinalized) revert AlreadyFinalized();
        uint256 currentEpochOnVault = IVault(vault).currentEpochId();
        if (currentEpochOnVault > epochId) revert TooLateToCancel();

        // Update user and global umbrella accounting
        userSharesByEpoch[_msgSender()][epochId] = userShares - shares;
        uint256 umbrellaShares = umbrellaSharesByEpoch[epochId];
        if (shares > umbrellaShares) revert InvalidAmount();
        umbrellaSharesByEpoch[epochId] = umbrellaShares - shares;

        // Return shares back to the user from the tranche contract
        _transfer(address(this), _msgSender(), shares);

        emit UnstakeCancelled(_msgSender(), epochId, shares);
    }

    function claim(uint256 epochId) external nonReentrant whenNotPaused {
        uint256 userShares = userSharesByEpoch[_msgSender()][epochId];
        if (userShares == 0) revert NothingToClaim();

        FinalizedEpoch memory finalizedData = finalizedEpochs[epochId];
        if (!finalizedData.isFinalized) revert NotFinalized();

        // user keeps tranche exposure until this moment because shares stayed on tranche
        // assets are stored on this contract and only transferred out on claim
        uint256 userAssets = (userShares * finalizedData.totalAssets) /
            finalizedData.totalShares;

        userSharesByEpoch[_msgSender()][epochId] = 0;

        IERC20(asset()).safeTransfer(_msgSender(), userAssets);

        emit WithdrawalClaimed(_msgSender(), epochId, userAssets);
    }

    // CORE ADMIN FUNCTIONS

    function finalizeEpoch(
        uint256 epochId
    ) external nonReentrant whenNotPaused restricted {
        uint256 currentVaultEpoch = IVault(vault).currentEpochId();
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

    // Linear yield streaming

    /// @notice Registers yieldAmount of MZUSD as yield to be streamed linearly over next epoch.
    /// @dev Assumes yieldAmount tokens are already transferred to this contract (from Vault).
    ///      This does NOT transfer tokens, it only affects accounting (virtual NAV).
    /// @param yieldAmount Amount of yield (MZUSD, 18d) to stream.
    function notifyYield(uint256 yieldAmount) external restricted {
        if (yieldAmount == 0) revert ZeroYieldPassed();

        // Do not allow overriding active stream
        if (yieldStreamingAmount != 0 && block.timestamp < yieldStreamEnd) {
            revert YieldStreamIsActive();
        }

        uint256 duration = IVault(vault).epochDuration();
        if (duration == 0) revert ZeroEpochDuration();

        yieldStreamingAmount = yieldAmount;
        yieldStreamStart = block.timestamp;
        yieldStreamEnd = block.timestamp + duration;

        uint256 epochId = IVault(vault).currentEpochId();
        emit YieldNotified(
            epochId,
            yieldAmount,
            yieldStreamStart,
            yieldStreamEnd
        );
    }

    // Admin config
    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
        _unpause();
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

    // POL/JUNIOR MODE (not for users)
    function sweepPol() external restricted {
        if (polPayout == address(0)) revert ZeroAddress();
        if (!isPolJunior) revert InvalidMode();
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        IERC20(asset()).safeTransfer(polPayout, balance);
        emit PolPayout(balance);
    }

    /// @notice Update payout address for POL/junior tranche proceeds.
    /// @dev Does not change isPolJunior flag, that is fixed at initialization.
    function setPolPayout(address payout) external restricted {
        if (payout == address(0)) revert ZeroAddress();
        polPayout = payout;
        emit PolJuniorUpdated(isPolJunior, payout);
    }

    // ERC4626 overrides (NAV with linear yield)

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

    function getUserEpochInfo(
        address user,
        uint256 epochId
    )
        external
        view
        returns (
            uint256 pendingShares,
            bool isFinalized,
            uint256 totalShares,
            uint256 totalAssets_,
            uint256 claimableAssets
        )
    {
        pendingShares = userSharesByEpoch[user][epochId];
        FinalizedEpoch memory e = finalizedEpochs[epochId];
        isFinalized = e.isFinalized;
        totalShares = e.totalShares;
        totalAssets_ = e.totalAssets;

        if (isFinalized && pendingShares != 0 && e.totalShares != 0) {
            claimableAssets = (pendingShares * e.totalAssets) / e.totalShares;
        }
    }

    function getEpochInfo(
        uint256 epochId
    )
        external
        view
        returns (
            uint256 umbrellaShares,
            bool isFinalized,
            uint256 totalShares,
            uint256 totalAssets_
        )
    {
        umbrellaShares = umbrellaSharesByEpoch[epochId];
        FinalizedEpoch memory e = finalizedEpochs[epochId];
        isFinalized = e.isFinalized;
        totalShares = e.totalShares;
        totalAssets_ = e.totalAssets;
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

    function _authorizeUpgrade(
        address newImplementation
    ) internal override restricted {}
}
