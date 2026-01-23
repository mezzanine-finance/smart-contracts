// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";
import "./interfaces/IVault.sol";

// @title Tranche with epoch-based umbrella unstake
// solhint-disable-next-line max-line-length
// @notice Users request withdrawal -> instant redeem in direct mode, or umbrella flow with delayed claim.
// @dev Linear yield streaming: vault sends yield in a lump sum, tranche streams it linearly in NAV.
/// @dev directWithdrawEnabled = true: standard ERC4626 withdraw/redeem enabled, umbrella unstake disabled.
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract Tranche is
    Initializable,
    ERC4626Upgradeable,
    AccessManagedUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    PauseManagedUpgradeable
{
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    struct FinalizedEpoch {
        uint256 totalShares;
        uint256 totalAssets;
        bool isFinalized;
    }

    // aderyn-ignore-next-line(large-numeric-literal)
    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant MAX_UNSTAKE_DELAY_EPOCHS = 30;

    // If true - direct ERC4626 withdraw/redeem are enabled and umbrella unstake flow is disabled
    bool public immutable directWithdrawEnabled;
    uint256 public trancheId;

    // unstake delay in epochs for umbrella withdrawals
    uint256 public unstakeDelayEpochs;

    bool public depositLimitEnabled;
    address public vault;
    uint256 public maxDepositCap;
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
    error ZeroPassedShares();
    error InvalidShares();
    error InvalidBalance();
    error ZeroYieldPassed();
    error ZeroEpochDuration();
    error TooLateToCancel();
    error DirectWithdrawModeEnabled();
    error DirectWithdrawModeDisabled();
    error UnstakeDelayTooLarge(uint256 requested, uint256 maxAllowed);
    error ZeroAssetSupply();

    /// @param _directWithdrawEnabled - if true, enables direct withdraw/redeem and disables umbrella unstake flow
    constructor(bool _directWithdrawEnabled) {
        directWithdrawEnabled = _directWithdrawEnabled;
        _disableInitializers();
    }

    /// @notice Initializer
    /// @param assetToken - underlying asset token (MZUSD)
    /// @param vaultAddress - address of the Vault
    /// @param trancheIdentifier - tranche identifier within the vault
    /// @param initialUnstakeDelayEpochs - initial unstake delay in epochs
    /// @param name_ - tranche name
    /// @param symbol_ - tranche symbol
    /// @param accessManager - access manager address for role control
    /// @param pauseManager - pause manager address for category-based pauses
    function initialize(
        IERC20 assetToken,
        address vaultAddress,
        uint256 trancheIdentifier,
        uint256 initialUnstakeDelayEpochs,
        string memory name_,
        string memory symbol_,
        address accessManager,
        address pauseManager
    ) external initializer {
        if (
            vaultAddress == address(0) ||
            accessManager == address(0) ||
            address(assetToken) == address(0)
        ) revert ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC4626_init(assetToken);
        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager);
        __ReentrancyGuard_init();

        vault = vaultAddress;
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

    /// @notice Deposit assets into the tranche, respecting deposit limits.
    /// @dev Overrides ERC4626 deposit to enforce deposit limits.
    /// @param assets The amount of the underlying asset to deposit.
    /// @param receiver The address receiving the tranche shares.
    /// @return shares The amount of tranche shares minted to the receiver.
    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant whenNotPaused(PauseCategory.DEPOSITS) returns (uint256 shares) {
        _checkDepositLimit(assets);
        shares = super.deposit(assets, receiver);
    }

    /// @notice Mint tranche shares by depositing assets, respecting deposit limits.
    /// @dev Overrides ERC4626 mint to enforce deposit limits.
    /// @param shares The amount of tranche shares to mint.
    /// @param receiver The address receiving the tranche shares.
    /// @return assets The amount of the underlying asset deposited.
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant whenNotPaused(PauseCategory.DEPOSITS) returns (uint256 assets) {
        uint256 assetsRequired = convertToAssets(shares);
        _checkDepositLimit(assetsRequired);
        assets = super.mint(shares, receiver);
    }

    /// @notice Request withdrawal in shares.
    /// @dev Direct mode: redeem immediately. Umbrella mode: shares are held until epoch finalization.
    /// @param shares - amount of tranche shares to withdraw
    function requestWithdrawal(
        uint256 shares
    ) external nonReentrant whenNotPaused(PauseCategory.WITHDRAWALS) {
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
    ) external nonReentrant whenDirectDisabled whenNotPaused(PauseCategory.WITHDRAWALS) {
        uint256 userShares = userSharesByEpoch[msg.sender][epochId];
        if (userShares == 0) revert NoPendingUnstake();
        if (shares == 0) revert ZeroPassedShares();
        if (shares > userShares) revert InvalidShares();

        if (finalizedEpochs[epochId].isFinalized) revert AlreadyFinalized();
        // aderyn-fp-next-line(reentrancy-state-change)
        uint256 currentEpochOnVault = IVault(vault).currentEpochId();
        if (currentEpochOnVault > epochId) revert TooLateToCancel();

        // Update user and global umbrella accounting
        userSharesByEpoch[msg.sender][epochId] = userShares - shares;
        uint256 umbrellaShares = umbrellaSharesByEpoch[epochId];
        if (shares > umbrellaShares) revert InvalidAmount();
        umbrellaSharesByEpoch[epochId] = umbrellaShares - shares;

        // Return shares back to the user from the tranche contract
        _transfer(address(this), msg.sender, shares);

        emit UnstakeCancelled(msg.sender, epochId, shares);
    }

    /// @notice Claim assets for finalized epoch after admin has finalized it.
    /// @param epochId The epoch for which to claim assets.
    function claim(
        uint256 epochId
    ) external nonReentrant whenDirectDisabled whenNotPaused(PauseCategory.WITHDRAWALS) {
        uint256 userShares = userSharesByEpoch[msg.sender][epochId];
        if (userShares == 0) revert NothingToClaim();

        FinalizedEpoch memory finalizedData = finalizedEpochs[epochId];
        if (!finalizedData.isFinalized) revert NotFinalized();

        // user keeps tranche exposure until this moment because shares stayed on tranche
        // assets are stored on this contract and only transferred out on claim
        uint256 userAssets = (userShares * finalizedData.totalAssets) / finalizedData.totalShares;

        userSharesByEpoch[msg.sender][epochId] = 0;
        reservedAssets -= userAssets;

        IERC20(asset()).safeTransfer(msg.sender, userAssets);

        emit WithdrawalClaimed(msg.sender, epochId, userAssets);
    }

    // EPOCH FINALIZATION
    /// @notice Finalize an epoch after it has passed on the vault if there are umbrella shares to process.
    /// @dev Burns umbrella shares for the epoch and records finalized data for user claims.
    /// @param epochId The epoch to finalize.
    function finalizeEpoch(
        uint256 epochId
    ) external nonReentrant whenDirectDisabled whenNotPaused(PauseCategory.PROTOCOL) {
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
            totalAssets: assetsToCredit,
            isFinalized: true
        });

        reservedAssets += assetsToCredit;
        _burn(address(this), sharesToFinalize);

        emit EpochFinalized(epochId, sharesToFinalize, assetsToCredit);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    )
        public
        override
        nonReentrant
        whenDirectEnabled
        whenNotPaused(PauseCategory.WITHDRAWALS)
        returns (uint256 shares)
    {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    )
        public
        override
        nonReentrant
        whenDirectEnabled
        whenNotPaused(PauseCategory.WITHDRAWALS)
        returns (uint256 assets)
    {
        return super.redeem(shares, receiver, owner);
    }

    function transfer(
        address to,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused(PauseCategory.TRANSFERS)
        returns (bool success)
    {
        return super.transfer(to, value);
    }

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

    function transferFrom(
        address from,
        address to,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused(PauseCategory.TRANSFERS)
        returns (bool success)
    {
        return super.transferFrom(from, to, value);
    }

    // Linear yield streaming
    /// @notice Registers yieldAmount of MZUSD as yield to be streamed linearly over next epoch.
    /// @dev Assumes yieldAmount tokens are already transferred to this contract (from Vault).
    ///      This does NOT transfer tokens, it only affects accounting (virtual NAV).
    /// @param yieldAmount Amount of yield (MZUSD, 18d) to stream.
    function notifyYield(
        uint256 yieldAmount
    ) external restricted whenNotPaused(PauseCategory.PROTOCOL) {
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

        uint256 epochId = IVault(vault).currentEpochId();
        emit YieldNotified(epochId, yieldAmount, yieldStreamStart, yieldStreamEnd);
    }

    // SETTERS

    /// @notice Update unstake delay in epochs
    function setUnstakeDelayEpochs(
        uint256 epochsDelay
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        _setUnstakeDelayEpochs(epochsDelay);
    }

    /// @notice Update deposit limits
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

    /// @notice Convenience view - price per share using virtual NAV
    function pricePerShare() external view returns (uint256 pricePerShare_) {
        pricePerShare_ = convertToAssets(10 ** decimals());
    }

    /// @notice Returns the amount of yield that has not yet accrued into NAV.
    function unaccruedYield() external view returns (uint256 unaccrued) {
        unaccrued = _unaccruedYield();
    }

    /// @notice Returns the current deposit limit parameters and computed limit.
    function getDepositLimitInfo()
        external
        view
        returns (bool enabled, uint256 limit, uint256 limitByTvl, uint256 cap)
    {
        enabled = depositLimitEnabled;
        (limit, limitByTvl, cap) = _computeDepositLimit();
    }

    /// @notice Get user's pending shares and claimable assets for a given epoch.
    /// @param user - user address
    /// @param epochId - epoch to query
    /// @return pendingShares - shares user has pending under umbrella for that epoch
    /// @return isFinalized - whether the epoch has been finalized by admin
    /// @return totalShares - total shares under umbrella for that epoch
    /// @return totalAssets_ - total assets credited to that epoch upon finalization
    /// @return claimableAssets - assets user can claim for that epoch (0 if not finalized)
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

    /// @notice Get global epoch info for umbrella unstake.
    /// @param epochId - epoch to query
    /// @return umbrellaShares - total shares under umbrella for that epoch
    /// @return isFinalized - whether the epoch has been finalized by admin
    /// @return totalShares - total shares burned upon finalization
    /// @return totalAssets_ - total assets credited to that epoch upon finalization
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
        if (accrued >= amount) return 0;
        unaccrued = amount - accrued;
    }

    /// @dev Deposit limits apply only to user deposits/mints; yield streaming via notifyYield
    /// does not check these limits and can continue even when deposits would revert.
    // Global deposit limits (cap + % of total supply).
    function _checkDepositLimit(uint256 amount) internal view {
        (uint256 limit, , ) = _computeDepositLimit();
        if (amount > limit) revert DepositLimitExceeded(amount, limit);
    }

    function _computeDepositLimit()
        internal
        view
        returns (uint256 limit, uint256 limitByTvl, uint256 cap)
    {
        cap = maxDepositCap;

        if (!depositLimitEnabled) {
            limit = type(uint256).max;
            limitByTvl = type(uint256).max;
            return (limit, limitByTvl, cap);
        }

        uint256 assetTotalSupply = IERC20(asset()).totalSupply();
        if (assetTotalSupply == 0) revert ZeroAssetSupply();

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
