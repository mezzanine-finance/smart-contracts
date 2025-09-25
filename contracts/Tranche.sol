// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./IVault.sol";

/**
 * @title Tranche
 * @dev An ERC4626 vault representing a single investment tranche.
 * It accepts a base asset and issues tranche-specific shares.
 * Features a dynamic withdrawal mechanism supporting both instant and delayed
 * (unlock period) withdrawals, configurable deposit limits, and is pausable.
 */
contract Tranche is ERC4626, AccessControl, ReentrancyGuard, Pausable {
    /// @dev Represents a user's pending withdrawal request for a delayed withdrawal.
    struct Withdrawal {
        uint256 shares;
        uint256 unlocksAt;
    }

    /// @dev Role for accounts that can configure tranche parameters like unlock periods and deposit limits.
    bytes32 public constant CONFIG_MANAGER_ROLE =
        keccak256("CONFIG_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant BASIS_POINTS = 10_000;

    /// @dev The main Vault contract, which this tranche notifies of TVL changes.
    IVault public immutable vault;
    /// @dev A unique identifier for this tranche (e.g., 0=Senior, 1=Mezzanine, 2=Junior).
    uint8 public immutable trancheId;

    /// @dev The required duration in seconds between requesting and executing a delayed withdrawal. If 0, withdrawals are instant.
    uint256 public unlockPeriod;
    /// @dev Maps a user to their pending delayed withdrawal request.
    mapping(address => Withdrawal) public withdrawalRequests;

    /// @dev Toggles whether deposit limits are enforced.
    bool public depositLimitEnabled;
    /// @dev A fixed maximum deposit cap in terms of the underlying asset.
    uint256 public maxDepositCap;
    /// @dev A dynamic maximum deposit cap expressed as a percentage of TVL in basis points.
    uint16 public maxDepositTvlBps;

    event UnlockPeriodUpdated(uint256 newPeriod);
    event DepositLimitUpdated(bool enabled, uint256 cap, uint16 tvlBps);
    event WithdrawalRequested(
        address indexed user,
        uint256 shares,
        uint256 unlocksAt
    );
    event WithdrawalExecuted(
        address indexed user,
        uint256 shares,
        uint256 assets
    );
    event WithdrawalCancelled(address indexed user, uint256 shares);

    error InvalidAmount();
    error ActiveWithdrawalRequestExists();
    error NoActiveWithdrawalRequest();
    error WithdrawalNotYetUnlocked();
    error DepositLimitExceeded(uint256 attempted, uint256 limit);

    /**
     * @dev Sets up the Tranche with its specific parameters.
     * @param _asset The underlying asset this tranche will hold (e.g., MZUSD).
     * @param _vault The main Vault contract to be notified of TVL changes.
     * @param _id The unique numerical identifier for this tranche.
     * @param _unlockPeriod The initial unlock period for withdrawals.
     * @param _name The name of the tranche's share token (e.g., "Senior MZUSD").
     * @param _symbol The symbol of the share token (e.g., "smzUSD").
     */
    constructor(
        IERC20 _asset,
        IVault _vault,
        uint8 _id,
        uint256 _unlockPeriod,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) ERC4626(_asset) {
        vault = _vault;
        trancheId = _id;
        unlockPeriod = _unlockPeriod;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(CONFIG_MANAGER_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    /**
     * @dev Pauses the contract, blocking key functions like `deposit` and `requestWithdrawal`.
     * @notice Can only be called by an account with the `PAUSER_ROLE`.
     */
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /**
     * @dev Unpauses the contract, re-enabling key functions.
     * @notice Can only be called by an account with the `PAUSER_ROLE`.
     */
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /**
     * @dev Overrides the standard ERC4626 deposit function to add deposit limit checks and Vault notification.
     * @param assets The amount of the base asset to deposit.
     * @param receiver The address that will receive the tranche's share tokens.
     * @return shares The amount of share tokens minted.
     */
    function deposit(
        uint256 assets,
        address receiver
    ) public override whenNotPaused nonReentrant returns (uint256 shares) {
        _checkDepositLimit(assets);
        shares = super.deposit(assets, receiver);
        // vault.notifyDeposit(trancheId, assets); // Interface for IVault needs this method
    }

    // -------- delayed withdrawal ----------

    /**
     * @dev Main entry point for withdrawals. Behaves dynamically based on `unlockPeriod`.
     * If `unlockPeriod` is 0, withdrawal is instant. Otherwise, it initiates a delayed withdrawal request.
     * @param shares The amount of share tokens to withdraw.
     */
    function requestWithdrawal(uint256 shares) external whenNotPaused nonReentrant {
        if (shares == 0 || balanceOf(msg.sender) < shares) revert InvalidAmount();

        if (unlockPeriod == 0) {
            // instant path — выдаём mzUSD сразу
            uint256 assets = redeem(shares, msg.sender, msg.sender);
            emit WithdrawalExecuted(msg.sender, shares, assets);
            return;
        }

        // delayed path — сразу фиксируем результат в эскроу
        uint64 unlocksAt = uint64(block.timestamp  unlockPeriod);
        // redeem переводит asset (mzUSD) на pendingEscrow
        uint256 assets = redeem(shares, address(pendingEscrow), msg.sender);
        // записываем долг и дедлайн
        pendingEscrow.record(msg.sender, assets, unlocksAt);
        emit WithdrawalRequested(msg.sender, shares, unlocksAt);
    }

    /**
     * @dev Allows a user to cancel their pending delayed withdrawal request.
     * Locked share tokens are transferred back to the user.
     */
    function cancelWithdrawal() external nonReentrant {
        Withdrawal memory req = withdrawalRequests[msg.sender];
        if (req.shares == 0) revert NoActiveWithdrawalRequest();

        delete withdrawalRequests[msg.sender];
        _transfer(address(this), msg.sender, req.shares); // Return locked shares
        emit WithdrawalCancelled(msg.sender, req.shares);
    }

   
    function executeWithdrawal() external nonReentrant whenNotPaused {
        pendingEscrow.claimFor(msg.sender);
    }

    // -------- configuration --------

    /**
     * @dev Updates the unlock period for this tranche.
     * @notice Can only be called by an account with `CONFIG_MANAGER_ROLE`.
     * @param period The new unlock period in seconds. Setting to 0 enables instant withdrawals.
     */
    function setUnlockPeriod(uint256 period) external onlyRole(CONFIG_MANAGER_ROLE) {
        unlockPeriod = period;
        emit UnlockPeriodUpdated(period);
    }

    /**
     * @dev Updates the deposit limits for this tranche.
     * @notice Can only be called by an account with `CONFIG_MANAGER_ROLE`.
     * @param en Whether limits are active.
     * @param cap The fixed cap in asset terms.
     * @param tvlBps The TVL-based cap in basis points.
     */
    function setDepositLimits(
        bool en,
        uint256 cap,
        uint16 tvlBps
    ) external onlyRole(CONFIG_MANAGER_ROLE) {
        depositLimitEnabled = en;
        maxDepositCap = cap;
        maxDepositTvlBps = tvlBps;
        emit DepositLimitUpdated(en, cap, tvlBps);
    }

    // -------- view --------

    function getWithdrawalStatus(address user) external view returns (uint256 amountMZ, uint256 unlocksAt) {
        (uint256 owed, uint256 ua) = pendingEscrow.getClaim(user);
        return (owed, uint256(ua));
    }

    /**
     * @dev Calculates the current value of a single full share token in terms of the underlying asset.
     * @return The amount of base asset that 1 full share token (1e18) is worth.
     */
    function pricePerShare() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }


    function hasPendingWithdrawal(address user) external view returns (bool) {
        (uint256 owed,) = pendingEscrow.getClaim(user);
        return owed != 0;
    }

    function pendingAssets(address user) external view returns (uint256 assets, uint256 unlocksAt) {
        (uint256 owed, uint64 ua) = pendingEscrow.getClaim(user);
        return (owed, uint256(ua));
    }

    // -------- internal --------

    /**
     * @dev Internal function to check if a deposit amount exceeds the current limits.
     * @param amount The amount of the underlying asset to be deposited.
     */
    function _checkDepositLimit(uint256 amount) internal view {
        if (!depositLimitEnabled) return;

        uint256 tvl = totalAssets();

        // if TVL is 0, we allow the first deposit without TVL-based limits
        uint256 perTxLimitByTvl = tvl == 0
            ? type(uint256).max
            : (tvl * maxDepositTvlBps) / BASIS_POINTS;

        uint256 perTxLimit = perTxLimitByTvl;
        if (maxDepositCap != 0 && maxDepositCap < perTxLimit) {
            perTxLimit = maxDepositCap;
        }

        if (amount > perTxLimit)
            revert DepositLimitExceeded(amount, perTxLimit);
    }
}
