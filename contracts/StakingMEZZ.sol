// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISMEZZ is IERC20 {
    function MINTER_ROLE() external pure returns (bytes32);
    function grantRole(bytes32 role, address account) external;
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/* ─────────────── Custom errors ─────────────── */
error AmountZero();
error UserZero();
error PendingWithdrawalExists();
error NoPendingDeposit();
error DepositLocked(uint256 unlockTs);
error NothingToClaim();
error UnlockPending(uint256 unlockTs);

contract StakingMEZZ is
    Initializable,
    AccessManagedUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    struct PendingWithdrawal { uint256 mezzAmount; uint256 unlockTs; }
    struct PendingDeposit    { uint256 mezzAmount; uint256 unlockTs; }

    // Tokens
    IERC20 public mezz;   // the staked asset
    ISMEZZ public smezz;  // ERC20Votes receipt/governance token

    // Locks
    uint256 public depositLock;   // applies ONLY to MEZZ flow (stakeFromFlow)
    uint256 public unstakeLock;   // applies to unstake() in all cases

    // State
    mapping(address => uint256) public stakedUntil; // DEPRECATED, kept for storage compatibility
    mapping(address => PendingWithdrawal) public pending;          // withdrawals
    mapping(address => PendingDeposit)    public pendingDeposit;   // delayed sMEZZ mints (MEZZ flow)

    // Events
    event Staked(address indexed user, uint256 amount, bool locked);
    event DepositQueued(address indexed user, uint256 amount, uint256 unlockTs);
    event DepositClaimed(address indexed user, uint256 amount);
    event UnstakeInitiated(address indexed user, uint256 amount, uint256 unlockTs);
    event Claimed(address indexed user, uint256 amount);

    constructor() { _disableInitializers(); }

    function initialize(address _mezz, address _smezz, address accessManager) external initializer {
        __AccessManaged_init(accessManager);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        mezz  = IERC20(_mezz);
        smezz = ISMEZZ(_smezz);
    }

    /* ---------------- Direct user stake: MEZZ -> sMEZZ instantly (NO deposit lock) ---------------- */

    function stake(uint256 mezzAmount) external whenNotPaused nonReentrant {
        if (mezzAmount == 0) revert AmountZero();
        mezz.safeTransferFrom(msg.sender, address(this), mezzAmount);
        smezz.mint(msg.sender, mezzAmount);
        emit Staked(msg.sender, mezzAmount, false);
    }

    /* ---------------- MEZZ flow: queue deposit, mint sMEZZ only after depositLock ---------------- */

    /// @notice Called by MEZZ contract. Transfers MEZZ from caller and applies deposit lock before minting sMEZZ.
    function stakeFromFlow(address user, uint256 mezzAmount)
        external
        whenNotPaused
        nonReentrant
        restricted
    {
        if (user == address(0)) revert UserZero();
        if (mezzAmount == 0) revert AmountZero();

        // Pull MEZZ from the MEZZ contract (caller). MEZZ must approve this contract.
        mezz.safeTransferFrom(msg.sender, address(this), mezzAmount);

        if (depositLock == 0) {
            // No deposit lock configured — mint sMEZZ immediately (back-compat mode)
            smezz.mint(user, mezzAmount);
            emit Staked(user, mezzAmount, false);
            return;
        }

        // Aggregate into a single pending deposit per user
        PendingDeposit memory pd = pendingDeposit[user];
        uint256 newAmount  = pd.mezzAmount + mezzAmount;
        uint256 baseUnlock = block.timestamp + depositLock;
        uint256 newUnlock  = pd.unlockTs > baseUnlock ? pd.unlockTs : baseUnlock;

        pendingDeposit[user] = PendingDeposit({ mezzAmount: newAmount, unlockTs: newUnlock });
        emit DepositQueued(user, mezzAmount, newUnlock);
    }

    /// @notice After depositLock, user claims sMEZZ minted 1:1 for queued MEZZ.
    function claimDeposit() external whenNotPaused nonReentrant {
        PendingDeposit memory pd = pendingDeposit[msg.sender];
        if (pd.mezzAmount == 0) revert NoPendingDeposit();
        if (block.timestamp < pd.unlockTs) revert DepositLocked(pd.unlockTs);

        delete pendingDeposit[msg.sender];
        smezz.mint(msg.sender, pd.mezzAmount);
        emit DepositClaimed(msg.sender, pd.mezzAmount);
    }

    /* ---------------- Unstake flow (applies to everyone) ---------------- */

    /// @notice Burn sMEZZ → start unstake lock.
    function unstake(uint256 smezzAmount) external whenNotPaused nonReentrant {
        if (smezzAmount == 0) revert AmountZero();
        if (pending[msg.sender].mezzAmount != 0) revert PendingWithdrawalExists();

        smezz.burn(msg.sender, smezzAmount);
        uint256 unlockTs = block.timestamp + unstakeLock;
        pending[msg.sender] = PendingWithdrawal({ mezzAmount: smezzAmount, unlockTs: unlockTs });
        emit UnstakeInitiated(msg.sender, smezzAmount, unlockTs);
    }

    /// @notice Finish unstake: transfer MEZZ after unstakeLock.
    function claim() external whenNotPaused nonReentrant {
        PendingWithdrawal memory wd = pending[msg.sender];
        if (wd.mezzAmount == 0) revert NothingToClaim();
        if (block.timestamp < wd.unlockTs) revert UnlockPending(wd.unlockTs);

        delete pending[msg.sender];
        mezz.safeTransfer(msg.sender, wd.mezzAmount);
        emit Claimed(msg.sender, wd.mezzAmount);
    }

    /* ---------------- Admin ---------------- */

    function setLockDurations(uint256 _deposit, uint256 _unstake) external restricted {
        depositLock = _deposit;
        unstakeLock = _unstake;
    }

    /// @notice Optionally grant sMEZZ MINTER_ROLE to another contract (e.g., this contract or MEZZ).
    function setSmezzMinter(address addr) external restricted {
        smezz.grantRole(smezz.MINTER_ROLE(), addr);
    }

    function pause() external restricted { _pause(); }
    function unpause() external restricted { _unpause(); }

    /* ---------------- UUPS ---------------- */
    function _authorizeUpgrade(address newImplementation) internal override restricted {}
}