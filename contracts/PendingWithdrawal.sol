// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/manager/AccessManaged.sol";

contract PendingWithdrawal is AccessManaged, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant TRANCHE_ROLE = keccak256("TRANCHE_ROLE");
    bytes32 public constant PAUSER_ROLE  = keccak256("PAUSER_ROLE");

    IERC20 public immutable mzusd;

    struct Claim {
        uint256 owed;      
        uint256  unlockAt; 
    }

    mapping(address => Claim) public claims;

    event Recorded(address indexed user, uint256 amountMZ, uint256 unlockAt);
    event Claimed(address indexed user, uint256 amountMZ);
    event Forfeited(address indexed user, uint256 amountMZ);

    error ZeroAmount();
    error TooEarly(uint256 unlockAt);
    error NothingToClaim();

    constructor(IERC20 _mzusd, address admin, address tranche)
    {
        mzusd  = _mzusd;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TRANCHE_ROLE, tranche);
        _grantRole(PAUSER_ROLE, admin);
    }

    // onlyRole(TRANCHE_ROLE)
    function record(address user, uint256 amountMZ, uint256 unlockAt)
        external
        nonReentrant
        
    {
        if (amountMZ == 0) revert ZeroAmount();

        Claim storage userClaim = claims[user];
        userClaim.owed += amountMZ;
        if (unlockAt > userClaim.unlockAt) userClaim.unlockAt = unlockAt;

        emit Recorded(user, amountMZ, unlockAt);
    }

    function claim() external nonReentrant whenNotPaused {
        Claim memory userClaim = claims[msg.sender];
        if (userClaim.owed == 0) revert NothingToClaim();
        if (block.timestamp < userClaim.unlockAt) revert TooEarly(userClaim.unlockAt);

        delete claims[msg.sender];
        mzusd.safeTransfer(msg.sender, userClaim.owed);
        emit Claimed(msg.sender, userClaim.owed);
    }

    function claimFor(address user) external nonReentrant whenNotPaused {
        Claim memory c = claims[user];
        if (c.owed == 0) revert NothingToClaim();
        if (block.timestamp < c.unlockAt) revert TooEarly(c.unlockAt);

        delete claims[user];
        mzusd.safeTransfer(user, c.owed);
        emit Claimed(user, c.owed);
    }

    function pause() external restricted { _pause(); }
    function unpause() external restricted { _unpause(); }

    function getClaim(address user) external view returns (uint256 owed, uint256 unlockAt) {
        Claim memory c = claims[user];
        return (c.owed, c.unlockAt);
    }
}