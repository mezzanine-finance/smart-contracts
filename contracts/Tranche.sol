// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";
import "./interfaces/IVault.sol";
import "./interfaces/IMZUSD.sol";

/// @title Tranche with epoch-based umbrella unstake
/// @notice Users request withdrawal -> instant redeem in direct mode, or umbrella flow with delayed claim.
/// @dev Linear yield streaming: vault sends yield in a lump sum, tranche streams it linearly in NAV.
/// @dev directWithdrawEnabled = true: standard ERC4626 withdraw/redeem enabled, umbrella unstake disabled.
/// @dev The contract enforces deposit cap via setDepositLimits function based on the TVL bps. The contract has no deposit cap by default.
/// @dev Deposit cap is enforced on the whole Tranche's totalSupply.
/// @dev Deposit cap is dynamic and grows as the total supply of the asset grows.
/// @dev Deposit cap can be disabled or updated by the Admin at any time.
/// @dev Dynamic cap through TVL (maxDepositTvlBps) enforces limits at the early stages as the asset's supply grows. After that, the static cap (maxDepositCap) is enforced.
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract Tranche is
    ERC4626Upgradeable,
    AccessManagedUpgradeable,
    UUPSUpgradeable,
    PauseManagedUpgradeable
{
    using SafeCast for uint256;

    struct FinalizedEpoch {
        uint256 totalShares;
        uint256 totalAssets;
    }

    // aderyn-ignore-next-line(large-numeric-literal)
    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant MAX_UNSTAKE_DELAY_EPOCHS = 30;

    // If true - direct ERC4626 withdraw/redeem are enabled and umbrella unstake flow is disabled
    bool public immutable directWithdrawEnabled;
    address public immutable vault;
    uint256 public trancheId;

    // unstake delay in epochs for umbrella withdrawals
    uint256 public unstakeDelayEpochs;

    bool public depositLimitEnabled;
    uint256 public maxDepositCap;
    /// @notice Limits how much the users can deposit into Tranche in total based on the asset's TVL and specified BPS.
    uint256 public maxDepositTvlBps;

    // YIELD STREAMING (linear distribution over epoch)
    /// @notice Amount of yield (MZUSD) that is being streamed linearly into NAV.
    /// @dev These tokens are already on the tranche balance, but not yet fully reflected in price per share.
    uint256 public yieldStreamingAmount;

    /// @notice Timestamp when current yield streaming started.
    uint64 public yieldStreamStart;

    /// @notice Timestamp when current yield streaming should finish (all yield accrued).
    uint64 public yieldStreamEnd;

    /// @notice Assets reserved for finalized-but-unclaimed umbrella withdrawals.
    uint256 public reservedAssets;

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
    event UnstakeCancelled(address indexed user, uint256 indexed epochId, uint256 shares);
    event EpochFinalized(uint256 indexed epochId, uint256 sharesBurned, uint256 assetsFinal);
    event UnstakeDelayUpdated(uint256 newDelayEpochs);
    event DepositLimitUpdated(bool enabled, uint256 cap, uint256 tvlBps);
    event WithdrawalClaimed(address indexed user, uint256 indexed epochId, uint256 assets);

    /// @notice Emitted when new yield is registered for linear streaming.
    /// @dev yieldAmount must correspond to MZUSD amount already transferred to this tranche.
    event YieldNotified(uint256 yieldAmount, uint256 streamStart, uint256 streamEnd);

    error InvalidAmount();
    error DepositLimitExceeded(uint256 attempted, uint256 limit);
    error NothingToFinalize();
    error EpochNotPassed();
    error NotFinalized();
    error NothingToClaim();
    error ZeroAddress();
    error YieldStreamIsActive();
    error NoPendingUnstake();
    error ZeroPassedShares();
    error InvalidShares();
    error InvalidBalance();
    error ZeroYieldPassed();
    error ZeroEpochDuration();
    error TooLateToCancel();
    error DirectWithdrawModeEnabled();
    error DirectWithdrawModeDisabled();
    error UnstakeDelayTooLarge(uint256 requested, uint256 maxAllowed);
    error NotVault();
    error NotLossManager();

    /// @param vaultAddress Vault address.
    /// @param _directWithdrawEnabled Enable direct withdraw/redeem; disables umbrella flow.
    constructor(address vaultAddress, bool _directWithdrawEnabled) {
        if (vaultAddress == address(0)) revert ZeroAddress();
        vault = vaultAddress;
        directWithdrawEnabled = _directWithdrawEnabled;
        _disableInitializers();
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    modifier onlyLossManager() {
        if (msg.sender != IVault(vault).lossManager()) revert NotLossManager();
        _;
    }

    /// @notice Initialize the tranche.
    /// @param trancheIdentifier Tranche identifier within the vault.
    /// @param initialUnstakeDelayEpochs Initial unstake delay in epochs.
    /// @param name_ Tranche name.
    /// @param symbol_ Tranche symbol.
    /// @dev MZUSD, AccessManager, and PauseManager are resolved from the Vault-linked MZUSD.
    function initialize(
        uint256 trancheIdentifier,
        uint256 initialUnstakeDelayEpochs,
        string memory name_,
        string memory symbol_
    ) external initializer {
        address mzusdAddress = IVault(vault).mzusd();

        IMZUSD mzusdToken = IMZUSD(mzusdAddress);
        address accessManager = mzusdToken.authority();
        address pauseManager_ = mzusdToken.pauseManager();
        if (accessManager == address(0)) revert ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC4626_init(IERC20(mzusdAddress));
        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);

        trancheId = trancheIdentifier;
        _setUnstakeDelayEpochs(initialUnstakeDelayEpochs);
    }

    modifier whenDirectEnabled() {
        if (!directWithdrawEnabled) revert DirectWithdrawModeDisabled();
        _;
    }

    modifier whenDirectDisabled() {
        if (directWithdrawEnabled) revert DirectWithdrawModeEnabled();
        _;
    }

    // CORE USER FUNCTIONS

    /// @notice Request withdrawal in shares.
    /// @dev Direct mode: redeem immediately. Umbrella mode: shares are held until epoch finalization.
    /// @param shares Tranche shares to withdraw.
    function requestWithdrawal(uint256 shares) external whenNotPaused(PauseCategory.WITHDRAWALS) {
        if (shares == 0) revert ZeroPassedShares();
        if (balanceOf(msg.sender) < shares) revert InvalidBalance();

        if (directWithdrawEnabled) {
            super.redeem(shares, msg.sender, msg.sender);
            return;
        }

        // aderyn-fp-next-line(reentrancy-state-change)
        uint256 currentVaultEpoch = IVault(vault).currentEpochId();
        uint256 targetEpoch = currentVaultEpoch + unstakeDelayEpochs;

        umbrellaSharesByEpoch[targetEpoch] += shares;
        userSharesByEpoch[msg.sender][targetEpoch] += shares;

        _transfer(msg.sender, address(this), shares);

        emit UnstakeRequested(msg.sender, shares, currentVaultEpoch, targetEpoch);
    }

    /// @notice Cancel a previously requested unstake for a given epoch.
    /// @dev User can only cancel shares that are still pending under the umbrella and
    ///      for epochs that have not yet been finalized.
    /// @param epochId The epoch for which the user wants to cancel their unstake.
    /// @param shares The amount of shares to cancel (returned back to the user).
    function cancelUnstake(
        uint256 epochId,
        uint256 shares
    ) external whenDirectDisabled whenNotPaused(PauseCategory.WITHDRAWALS) {
        uint256 userShares = userSharesByEpoch[msg.sender][epochId];
        if (userShares == 0) revert NoPendingUnstake();
        if (shares == 0) revert ZeroPassedShares();
        if (shares > userShares) revert InvalidShares();

        // aderyn-fp-next-line(reentrancy-state-change)
        uint256 currentEpochOnVault = IVault(vault).currentEpochId();
        if (currentEpochOnVault > epochId) revert TooLateToCancel();

        uint256 umbrellaShares = umbrellaSharesByEpoch[epochId];
        if (shares > umbrellaShares) revert InvalidAmount();

        // Update user and global umbrella accounting
        userSharesByEpoch[msg.sender][epochId] = userShares - shares;
        umbrellaSharesByEpoch[epochId] = umbrellaShares - shares;

        // Return shares back to the user from the tranche contract
        _transfer(address(this), msg.sender, shares);

        emit UnstakeCancelled(msg.sender, epochId, shares);
    }

    /// @notice Claim assets for finalized epoch after admin has finalized it.
    /// @param epochId The epoch for which to claim assets.
    function claim(
        uint256 epochId
    ) external whenDirectDisabled whenNotPaused(PauseCategory.WITHDRAWALS) {
        uint256 userShares = userSharesByEpoch[msg.sender][epochId];
        if (userShares == 0) revert NothingToClaim();

        FinalizedEpoch memory finalizedData = finalizedEpochs[epochId];
        if (finalizedData.totalShares == 0) revert NotFinalized();
        uint256 userAssets = (userShares * finalizedData.totalAssets) / finalizedData.totalShares;

        userSharesByEpoch[msg.sender][epochId] = 0;
        reservedAssets -= userAssets;

        IERC20(asset()).transfer(msg.sender, userAssets);

        emit WithdrawalClaimed(msg.sender, epochId, userAssets);
    }

    // EPOCH FINALIZATION
    /// @notice Finalize an epoch after it has passed on the vault if there are umbrella shares to process.
    /// @dev Burns umbrella shares for the epoch and records finalized data for user claims.
    /// @param epochId The epoch to finalize.
    function finalizeEpoch(
        uint256 epochId
    ) external whenDirectDisabled whenNotPaused(PauseCategory.PROTOCOL) {
        // aderyn-fp-next-line(reentrancy-state-change)
        uint256 currentVaultEpoch = IVault(vault).currentEpochId();
        if (currentVaultEpoch <= epochId) revert EpochNotPassed();

        uint256 sharesToFinalize = umbrellaSharesByEpoch[epochId];
        if (sharesToFinalize == 0) revert NothingToFinalize();

        umbrellaSharesByEpoch[epochId] = 0;

        // use virtual NAV at the moment of finalization
        uint256 assetsToCredit = convertToAssets(sharesToFinalize);

        finalizedEpochs[epochId] = FinalizedEpoch({
            totalShares: sharesToFinalize,
            totalAssets: assetsToCredit
        });

        reservedAssets += assetsToCredit;
        _burn(address(this), sharesToFinalize);

        emit EpochFinalized(epochId, sharesToFinalize, assetsToCredit);
    }

    // Linear yield streaming
    /// @notice Registers yieldAmount of MZUSD as yield to be streamed linearly over next epoch.
    /// @dev Assumes yieldAmount tokens are already transferred to this contract (from Vault).
    ///      This does NOT transfer tokens, it only affects accounting (virtual NAV).
    /// @param yieldAmount Amount of yield (MZUSD, 18d) to stream.
    function notifyYield(
        uint256 yieldAmount
    ) external onlyVault whenNotPaused(PauseCategory.PROTOCOL) {
        if (yieldAmount == 0) revert ZeroYieldPassed();

        // Do not allow overriding active stream
        if (yieldStreamingAmount != 0 && block.timestamp < yieldStreamEnd) {
            revert YieldStreamIsActive();
        }

        // aderyn-fp-next-line(reentrancy-state-change)
        uint256 duration = IVault(vault).epochDuration();
        if (duration == 0) revert ZeroEpochDuration();

        uint256 startTs = block.timestamp;
        uint256 endTs = startTs + duration;

        yieldStreamingAmount = yieldAmount;
        yieldStreamStart = SafeCast.toUint64(startTs);
        yieldStreamEnd = SafeCast.toUint64(endTs);

        emit YieldNotified(yieldAmount, yieldStreamStart, yieldStreamEnd);
    }

    /// @notice Burn MZUSD from this tranche (used by LossManager).
    function burnMZUSD(
        uint256 amount
    ) external onlyLossManager whenNotPaused(PauseCategory.PROTOCOL) {
        IMZUSD(asset()).burn(amount);
    }

    // SETTERS

    /// @notice Update unstake delay in epochs.
    function setUnstakeDelayEpochs(
        uint256 epochsDelay
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        _setUnstakeDelayEpochs(epochsDelay);
    }

    /// @notice Update deposit limits.
    function setDepositLimits(
        bool enabled,
        uint256 cap,
        uint256 tvlBps
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (tvlBps > BASIS_POINTS) revert InvalidAmount();
        depositLimitEnabled = enabled;
        maxDepositCap = cap;
        maxDepositTvlBps = tvlBps;
        emit DepositLimitUpdated(enabled, cap, tvlBps);
    }

    // GETTERS
    // ERC4626 overrides (NAV with linear yield)
    /// @notice Virtual total assets backing tranche shares.
    /// @dev Real balance minus not-yet-accrued yield. This is what drives pricePerShare.
    function totalAssets() public view override returns (uint256 totalAssets_) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 unaccrued = _unaccruedYield();
        uint256 reserved = reservedAssets;

        if (unaccrued + reserved > balance) {
            // Should not happen if notifyYield is used correctly, but guard against underflow.
            return 0;
        }

        totalAssets_ = balance - unaccrued - reserved;
    }

    /// @notice Convenience view: price per share using virtual NAV.
    function pricePerShare() external view returns (uint256 pricePerShare_) {
        pricePerShare_ = convertToAssets(10 ** decimals());
    }

    /// @notice Returns the amount of yield that has not yet accrued into NAV.
    function unaccruedYield() external view returns (uint256 unaccrued) {
        unaccrued = _unaccruedYield();
    }

    /// @notice Returns the current deposit limit parameters and computed limit.
    /// @return enabled Whether deposit limits are enabled.
    /// @return limit Effective deposit limit.
    /// @return limitByTvl Limit derived from TVL bps.
    /// @return cap Absolute deposit cap.
    function getDepositLimitInfo()
        external
        view
        returns (bool enabled, uint256 limit, uint256 limitByTvl, uint256 cap)
    {
        enabled = depositLimitEnabled;
        (limit, limitByTvl, cap) = _computeDepositLimit();
    }

    /// @notice Get user's pending shares and claimable assets for a given epoch.
    /// @param user User address.
    /// @param epochId Epoch to query.
    /// @return pendingShares Shares pending under umbrella for that epoch.
    /// @return claimableAssets Assets user can claim (0 if not finalized).
    function getUserEpochInfo(
        address user,
        uint256 epochId
    ) external view returns (uint256 pendingShares, uint256 claimableAssets) {
        pendingShares = userSharesByEpoch[user][epochId];
        FinalizedEpoch memory e = finalizedEpochs[epochId];

        if (e.totalShares > 0 && pendingShares > 0) {
            claimableAssets = (pendingShares * e.totalAssets) / e.totalShares;
        }
    }

    /// @notice Get global epoch info for umbrella unstake.
    /// @param epochId Epoch to query.
    /// @return umbrellaShares Total shares under umbrella for that epoch.
    /// @return isFinalized Whether the epoch has been finalized.
    /// @return totalShares Total shares burned on finalization.
    /// @return totalAssets_ Total assets credited on finalization.
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
        isFinalized = e.totalShares > 0;
        totalShares = e.totalShares;
        totalAssets_ = e.totalAssets;
    }

    // OVERRIDEN FUNCTIONS

    /// @notice Deposit assets into the tranche, respecting deposit limits.
    /// @dev Overrides ERC4626 _deposit to enforce deposit limits and pause.
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override whenNotPaused(PauseCategory.DEPOSITS) {
        _checkDepositLimit(assets);
        super._deposit(caller, receiver, assets, shares);
    }

    /// @notice Withdraw assets from the Tranche if direct withdraw enabled.
    /// @dev Overrides ERC4626 _withdraw to enforce direct withdraw validation and pause.
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override whenDirectEnabled whenNotPaused(PauseCategory.WITHDRAWALS) {
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev Overrides ERC20 _update to enforce pause.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override whenNotPaused(PauseCategory.TRANSFERS) {
        super._update(from, to, value);
    }

    /// @dev Overrides ERC20 approve to enforce pause.
    function approve(
        address spender,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused(PauseCategory.TRANSFERS)
        returns (bool success)
    {
        return super.approve(spender, value);
    }

    // INTERNAL HELPERS

    /// @notice Returns how much of current yield is still not accrued into NAV.
    /// @dev This is what we subtract from raw balance in totalAssets().
    function _unaccruedYield() internal view returns (uint256 unaccrued) {
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
        unaccrued = amount - accrued;
    }

    /// @dev Deposit limits apply only to user deposits/mints; yield streaming via notifyYield
    /// does not check these limits and can continue even when deposits would revert.
    // Global deposit limits (cap + % of total supply).
    function _checkDepositLimit(uint256 amount) internal view {
        (uint256 limit, , ) = _computeDepositLimit();
        if (amount > limit) revert DepositLimitExceeded(amount, limit);
    }

    /// @notice Computes the effective deposit limit from cap and TVL constraints.
    /// @return limit Effective deposit limit.
    /// @return limitByTvl Limit derived from TVL bps.
    /// @return cap Absolute deposit cap.
    function _computeDepositLimit()
        internal
        view
        returns (uint256 limit, uint256 limitByTvl, uint256 cap)
    {
        cap = maxDepositCap;

        if (!depositLimitEnabled) {
            limit = type(uint256).max;
            limitByTvl = type(uint256).max;
            // TODO: fix the cap, add option to disable it
            return (limit, limitByTvl, cap);
        }

        uint256 assetTotalSupply = IERC20(asset()).totalSupply();
        uint256 trancheAssets = totalAssets(); // virtual TVL with streaming
        uint256 maxTotalByTvl = (assetTotalSupply * maxDepositTvlBps) / BASIS_POINTS;
        if (maxTotalByTvl <= trancheAssets) {
            limitByTvl = 0;
        } else {
            limitByTvl = maxTotalByTvl - trancheAssets;
        }

        uint256 limitByCap = type(uint256).max;
        if (cap != 0) {
            if (cap <= trancheAssets) {
                limitByCap = 0;
            } else {
                limitByCap = cap - trancheAssets;
            }
        }

        limit = limitByTvl < limitByCap ? limitByTvl : limitByCap;
    }

    function _setUnstakeDelayEpochs(uint256 epochsDelay) internal {
        if (epochsDelay > MAX_UNSTAKE_DELAY_EPOCHS) {
            revert UnstakeDelayTooLarge(epochsDelay, MAX_UNSTAKE_DELAY_EPOCHS);
        }
        unstakeDelayEpochs = epochsDelay;
        emit UnstakeDelayUpdated(epochsDelay);
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address newImplementation) internal override restricted {}
}
