// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract PendingWithdrawalEscrow is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant TRANCHE_ROLE = keccak256("TRANCHE_ROLE");
    bytes32 public constant PAUSER_ROLE  = keccak256("PAUSER_ROLE");

    IERC20 public immutable mzusd;

    struct Claim {
        uint256 owed;      
        uint64  unlockAt; 
    }

    mapping(address => Claim) public claims;

    event Recorded(address indexed user, uint256 amountMZ, uint64 unlockAt);
    event Claimed(address indexed user, uint256 amountMZ);
    event Forfeited(address indexed user, uint256 amountMZ); // на случай админ-сброса, если когда-нибудь понадобится

    error ZeroAmount();
    error TooEarly(uint64 unlockAt);
    error NothingToClaim();

    constructor(IERC20 _mzusd, address admin, address tranche)
    {
        mzusd  = _mzusd;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TRANCHE_ROLE, tranche);
        _grantRole(PAUSER_ROLE, admin);
    }

    function record(address user, uint256 amountMZ, uint64 unlockAt)
        external
        nonReentrant
        onlyRole(TRANCHE_ROLE)
    {
        if (amountMZ == 0) revert ZeroAmount();

        Claim storage c = claims[user];
        c.owed += amountMZ;
        // держим максимальный из сроков (новый запрос продлевает окно)
        if (unlockAt > c.unlockAt) c.unlockAt = unlockAt;

        emit Recorded(user, amountMZ, unlockAt);
    }

    function claim() external nonReentrant whenNotPaused {
        Claim memory c = claims[msg.sender];
        if (c.owed == 0) revert NothingToClaim();
        if (block.timestamp < c.unlockAt) revert TooEarly(c.unlockAt);

        delete claims[msg.sender];
        mzusd.safeTransfer(msg.sender, c.owed);
        emit Claimed(msg.sender, c.owed);
    }

    function claimFor(address user) external nonReentrant whenNotPaused {
        Claim memory c = claims[user];
        if (c.owed == 0) revert NothingToClaim();
        if (block.timestamp < c.unlockAt) revert TooEarly(c.unlockAt);

        delete claims[user];
        mzusd.safeTransfer(user, c.owed);
        emit Claimed(user, c.owed);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function getClaim(address user) external view returns (uint256 owed, uint64 unlockAt) {
        Claim memory c = claims[user];
        return (c.owed, c.unlockAt);
    }
}