// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * StakingMEZZ:
 * - Two inflow paths:
 *   (1) User stake: stake() → mint sMEZZ 1:1, NO deposit lock.
 *   (2) Mint flow: stakeFromMint(user, amount) → mint sMEZZ and APPLY deposit lock.
 *   (3) Buyback/donation: donateFrom(from, amount) → NO sMEZZ mint; grows MEZZ pool.
 * - Unstake: burn sMEZZ → start unstake lock → claim() transfers MEZZ back.
 */

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
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

contract StakingMEZZ is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    struct PendingWithdrawal { uint256 mezzAmount; uint256 unlockTs; }

    // Roles
    bytes32 public constant ADMIN_ROLE       = keccak256("ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE      = keccak256("PAUSER_ROLE");
    bytes32 public constant FLOW_STAKER_ROLE = keccak256("FLOW_STAKER_ROLE"); // authorized minter flow (MEZZ)
    bytes32 public constant DONOR_ROLE       = keccak256("DONOR_ROLE");       // authorized donor (buyback via MEZZ)

    // Tokens
    IERC20 public mezz;   // the staked asset
    ISMEZZ public smezz;  // ERC20Votes receipt/governance token

    // Locks
    uint256 public depositLock;   // applies to stakeFromMint()
    uint256 public unstakeLock;   // applies to unstake()

    // State
    mapping(address => uint256) public stakedUntil;        // deposit lock timestamp per user
    mapping(address => PendingWithdrawal) public pending;  // active pending withdrawal per user

    // Events
    event Staked(address indexed user, uint256 amount, bool locked);
    event Donated(address indexed from, uint256 amount);
    event UnstakeInitiated(address indexed user, uint256 amount, uint256 unlockTs);
    event Claimed(address indexed user, uint256 amount);

    constructor() { _disableInitializers(); }

    function initialize(address _admin, address _mezz, address _smezz) external initializer {
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        mezz  = IERC20(_mezz);
        smezz = ISMEZZ(_smezz);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE,        _admin);
        _grantRole(PAUSER_ROLE,       _admin);
    }

    /**
     * @notice User-provided stake: transfer MEZZ in and mint sMEZZ 1:1. No deposit lock is applied.
     */
    function stake(uint256 mezzAmount) external whenNotPaused nonReentrant {
        require(mezzAmount > 0, "amount=0");
        mezz.safeTransferFrom(msg.sender, address(this), mezzAmount);
        smezz.mint(msg.sender, mezzAmount);
        emit Staked(msg.sender, mezzAmount, false);
    }

    /**
     * @notice Mint flow (called by MEZZ): apply deposit lock and mint sMEZZ to the end-user.
     * @dev Caller must hold FLOW_STAKER_ROLE and transfer MEZZ in along this call.
     */
    function stakeFromMint(address user, uint256 mezzAmount)
        external
        whenNotPaused
        nonReentrant
        onlyRole(FLOW_STAKER_ROLE)
    {
        require(mezzAmount > 0, "amount=0");
        mezz.safeTransferFrom(msg.sender, address(this), mezzAmount);
        smezz.mint(user, mezzAmount);

        uint256 newUnlock = block.timestamp + depositLock;
        if (newUnlock > stakedUntil[user]) stakedUntil[user] = newUnlock;

        emit Staked(user, mezzAmount, true);
    }

    /**
     * @notice Donation flow (buyback): transfer MEZZ in without minting sMEZZ.
     * @dev Caller must hold DONOR_ROLE. This simply increases the MEZZ pool held by the staking contract.
     */
    function donateFrom(address from, uint256 mezzAmount)
        external
        whenNotPaused
        nonReentrant
        onlyRole(DONOR_ROLE)
    {
        require(mezzAmount > 0, "amount=0");
        mezz.safeTransferFrom(from, address(this), mezzAmount);
        emit Donated(from, mezzAmount);
    }

    /**
     * @notice Begin unstake: burn sMEZZ and start the unstake lock countdown.
     * @dev Only one pending withdrawal per user at a time.
     */
    function unstake(uint256 smezzAmount) external whenNotPaused nonReentrant {
        require(smezzAmount > 0, "amount=0");
        require(block.timestamp >= stakedUntil[msg.sender], "deposit lock");
        require(pending[msg.sender].mezzAmount == 0, "pending");
        smezz.burn(msg.sender, smezzAmount);

        pending[msg.sender] = PendingWithdrawal({
            mezzAmount: smezzAmount,
            unlockTs:   block.timestamp + unstakeLock
        });
        emit UnstakeInitiated(msg.sender, smezzAmount, pending[msg.sender].unlockTs);
    }

    /**
     * @notice Finish unstake after lock period: transfer MEZZ out to the user.
     */
    function claim() external whenNotPaused nonReentrant {
        PendingWithdrawal memory wd = pending[msg.sender];
        require(wd.mezzAmount > 0, "none");
        require(block.timestamp >= wd.unlockTs, "unlock pending");
        delete pending[msg.sender];
        mezz.safeTransfer(msg.sender, wd.mezzAmount);
        emit Claimed(msg.sender, wd.mezzAmount);
    }

    // --- Admin ---

    function setLockDurations(uint256 _deposit, uint256 _unstake) external onlyRole(ADMIN_ROLE) {
        depositLock = _deposit;
        unstakeLock = _unstake;
    }

    function grantFlowStaker(address addr) external onlyRole(ADMIN_ROLE) { _grantRole(FLOW_STAKER_ROLE, addr); }
    function grantDonor(address addr) external onlyRole(ADMIN_ROLE) { _grantRole(DONOR_ROLE, addr); }

    /// @notice Optionally grant sMEZZ MINTER_ROLE to another contract (e.g., this contract or MEZZ).
    function setSmezzMinter(address addr) external onlyRole(ADMIN_ROLE) {
        smezz.grantRole(smezz.MINTER_ROLE(), addr);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // --- UUPS ---
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(ADMIN_ROLE) {}
}