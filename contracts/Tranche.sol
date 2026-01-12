// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

// aderyn-fp-next-line(reused-contract-name)
interface IVault {
    function currentEpochId() external view returns (uint256);
    function epochDuration() external view returns (uint256);
}

// @title Tranche with epoch-based umbrella unstake
// solhint-disable-next-line max-line-length
// @notice Users request unstake -> shares stay on tranche under umbrella -> after N epochs admin finalizes -> users claim.
// @dev Linear yield streaming: vault sends yield in a lump sum, tranche streams it linearly in NAV.
/// @dev directWithdrawEnabled = true: standard ERC4626 withdraw/redeem enabled, umbrella unstake disabled.
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

    // aderyn-ignore-next-line(large-numeric-literal)
    uint256 public constant BASIS_POINTS = 10_000;

    // If true - direct ERC4626 withdraw/redeem are enabled and umbrella unstake flow is disabled
    bool public immutable directWithdrawEnabled;

    address public vault;
    uint256 public trancheId;

    // unstake delay in epochs for umbrella withdrawals
    uint256 public unstakeDelayEpochs;

    // deposit limits
    bool public depositLimitEnabled;
    uint256 public maxDepositCap;
    uint256 public maxDepositTvlBps;

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
    error EthTransferFailed(address to, uint256 attemptedAmount);

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
    function initialize(
        IERC20 assetToken,
        address vaultAddress,
        uint256 trancheIdentifier,
        uint256 initialUnstakeDelayEpochs,
        string memory name_,
        string memory symbol_,
        address accessManager
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
    ) public override nonReentrant whenNotPaused restricted returns (uint256 shares) {
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
    ) public override nonReentrant whenNotPaused restricted returns (uint256 assets) {
        uint256 assetsRequired = convertToAssets(shares);
        _checkDepositLimit(assetsRequired);
        assets = super.mint(shares, receiver);
    }

    /// @notice Request an unstake by locking shares under the umbrella for N epochs.
    /// @dev Shares are transferred from user to tranche contract and kept there until
    ///      the epoch is finalized by admin. After finalization, user can claim their assets
    /// @param shares - amount of tranche shares to unstake
    function requestWithdrawal(
        uint256 shares
    ) external nonReentrant whenNotPaused whenDirectDisabled restricted {
        if (shares == 0) revert ZeroPassedShares();
        if (balanceOf(_msgSender()) < shares) revert InvalidBalance();

        // aderyn-fp-next-line(reentrancy-state-change)
        uint256 currentVaultEpoch = IVault(vault).currentEpochId();
        uint256 targetEpoch = currentVaultEpoch + unstakeDelayEpochs;

        umbrellaSharesByEpoch[targetEpoch] += shares;
        userSharesByEpoch[_msgSender()][targetEpoch] += shares;

        _transfer(_msgSender(), address(this), shares);

        emit UnstakeRequested(_msgSender(), shares, currentVaultEpoch, targetEpoch);
    }

    /// @notice Cancel a previously requested unstake for a given epoch.
    /// @dev User can only cancel shares that are still pending under the umbrella and
    ///      for epochs that have not yet been finalized.
    /// @param epochId The epoch for which the user wants to cancel their unstake.
    /// @param shares The amount of shares to cancel (returned back to the user).
    function cancelUnstake(
        uint256 epochId,
        uint256 shares
    ) external nonReentrant whenNotPaused whenDirectDisabled restricted {
        uint256 userShares = userSharesByEpoch[_msgSender()][epochId];
        if (userShares == 0) revert NoPendingUnstake();
        if (shares == 0) revert ZeroPassedShares();
        if (shares > userShares) revert InvalidShares();

        if (finalizedEpochs[epochId].isFinalized) revert AlreadyFinalized();
        // aderyn-fp-next-line(reentrancy-state-change)
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

    /// @notice Claim assets for finalized epoch after admin has finalized it.
    /// @param epochId The epoch for which to claim assets.
    function claim(
        uint256 epochId
    ) external nonReentrant whenNotPaused whenDirectDisabled restricted {
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

    /// @notice Finalize an epoch after it has passed on the vault.
    /// @dev Burns umbrella shares for the epoch and records finalized data for user claims.
    /// @param epochId The epoch to finalize.
    function finalizeEpoch(
        uint256 epochId
    ) external nonReentrant whenNotPaused restricted whenDirectDisabled {
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

        _burn(address(this), sharesToFinalize);

        emit EpochFinalized(epochId, sharesToFinalize, assetsToCredit);
    }

    // ERC4626 exit points (role-controlled via AccessManager)
    // @dev For direct withdraw mode this is enabled as normal
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    )
        public
        override
        nonReentrant
        whenNotPaused
        whenDirectEnabled
        restricted
        returns (uint256 shares)
    {
        return super.withdraw(assets, receiver, owner);
    }

    // @dev For direct withdraw mode this is enabled as normal
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    )
        public
        override
        nonReentrant
        whenNotPaused
        whenDirectEnabled
        restricted
        returns (uint256 assets)
    {
        return super.redeem(shares, receiver, owner);
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

        // aderyn-fp-next-line(reentrancy-state-change)
        uint256 duration = IVault(vault).epochDuration();
        if (duration == 0) revert ZeroEpochDuration();

        yieldStreamingAmount = yieldAmount;
        yieldStreamStart = block.timestamp;
        yieldStreamEnd = block.timestamp + duration;

        uint256 epochId = IVault(vault).currentEpochId();
        emit YieldNotified(epochId, yieldAmount, yieldStreamStart, yieldStreamEnd);
    }

    // SETTERS
    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
        _unpause();
    }

    /// @notice Update unstake delay in epochs
    function setUnstakeDelayEpochs(uint256 epochsDelay) external restricted {
        unstakeDelayEpochs = epochsDelay;
        emit UnstakeDelayUpdated(epochsDelay);
    }

    /// @notice Update deposit limits
    function setDepositLimits(bool enabled, uint256 cap, uint256 tvlBps) external restricted {
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
    function totalAssets() public view override returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 unaccrued = _unaccruedYield();

        if (unaccrued > balance) {
            // Should not happen if notifyYield is used correctly, but guard against underflow.
            return 0;
        }

        return balance - unaccrued;
    }

    /// @notice Convenience view - price per share using virtual NAV
    function pricePerShare() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
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

    /// @notice Emergency helper to recover ETH that might be accidentally sent to this contract.
    /// @dev Due to inheriting UUPSUpgradeable, the implementation exposes a payable
    ///      `upgradeToAndCall` function, so static analyzers treat this contract as
    ///      capable of receiving ETH. In normal operation, `msg.value` is forwarded
    ///      via the proxy and no ETH should remain here, but having an explicit
    ///      withdrawal function avoids locking ETH that may arrive via selfdestruct
    ///      or mistaken transfers. This function is not part of the normal protocol
    ///      flow and is restricted to the admin role.
    // aderyn-ignore-next-line(state-change-without-event)
    function rescueETH(address to, uint256 amount) external restricted {
        if (to == address(0)) revert ZeroAddress();

        uint256 bal = address(this).balance;
        if (amount > bal) {
            amount = bal;
        }

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed(to, amount);
    }

    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address newImplementation) internal override restricted {}
}
