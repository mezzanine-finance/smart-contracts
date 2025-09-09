// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title IVault
 * @dev A minimal interface for a Vault contract that holds funds.
 */
interface IVault {
    function withdraw(address token, address to, uint256 amount) external;
}

/**
 * @title MZUSD Token
 * @dev An ERC20 token pegged 1:1 to USDC, backed by assets in a Vault.
 * This contract handles minting MZUSD upon USDC deposit and burning MZUSD for USDC withdrawal.
 * It features an hourly withdrawal limit per user and a queueing system.
 * The contract is pausable for emergency situations.
 */
contract MZUSD is ERC20, ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    /// @dev Represents a user's request to withdraw funds that is pending in the queue.
    struct WithdrawalRequest {
        address user;
        uint256 amount;
    }

    /// @dev Role for accounts that can set withdrawal limits.
    bytes32 public constant LIMIT_SETTER_ROLE = keccak256("LIMIT_SETTER_ROLE");
    /// @dev Role for accounts that can pause and unpause the contract.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev The underlying USDC token contract.
    IERC20 public immutable usdc;
    /// @dev The Vault contract where USDC collateral is stored.
    IVault public immutable vault;

    /// @dev The maximum amount of USDC a user can withdraw per hour.
    uint256 public hourlyWithdrawalLimit;

    /// @dev An array storing all pending withdrawal requests.
    WithdrawalRequest[] public withdrawalQueue;
    /// @dev A pointer to the next request in the queue to be processed.
    uint256 public queueHead;
    /// @dev Maps a user's address to their position in the queue (index + 1). A value of 0 means not in queue.
    mapping(address => uint256) private queueIndex; // idx+1

    /// @dev Maps a user to the total amount they have withdrawn in the current hourly window.
    mapping(address => uint256) public hourlyWithdrawnAmount;
    /// @dev Maps a user to the timestamp of their last withdrawal action.
    mapping(address => uint256) public lastWithdrawalTimestamp;

    event Deposit(address indexed user, uint256 amount);
    event InstantWithdrawal(address indexed user, uint256 amount);
    event WithdrawalQueued(address indexed user, uint256 amount, uint256 queuePos);
    event WithdrawalCancelled(address indexed user, uint256 amount);
    event WithdrawalProcessed(address indexed user, uint256 amount, uint256 queuePos);
    event HourlyWithdrawalLimitUpdated(uint256 newLimit);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance();
    error WithdrawalRequestAlreadyExists();
    error HourlyLimitExceeded();
    error NotInWithdrawalQueue();
    error QueueEmpty();
    error InsufficientLiquidity();

    /**
     * @dev Sets up the contract with necessary addresses and initial parameters.
     * @param _usdc The address of the USDC token contract.
     * @param _vault The address of the Vault contract.
     * @param _hourlyLimit The initial hourly withdrawal limit per user.
     */
    constructor(
        address _usdc,
        address _vault,
        uint256 _hourlyLimit,
        address _admin
    ) ERC20("MZUSD Token", "MZUSD") {
        if (_admin == address(0) || _vault == address(0) || _usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        vault = IVault(_vault);
        hourlyWithdrawalLimit = _hourlyLimit;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(LIMIT_SETTER_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);
    }

    /**
     * @dev Pauses the contract, blocking key functions like `deposit` and `withdraw`.
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

    // ------- user actions --------

    /**
     * @dev Deposits USDC into the Vault and mints an equivalent amount of MZUSD to the caller.
     * @param amount The amount of USDC to deposit.
     */
    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(vault), amount);
        _mint(msg.sender, amount);
        emit Deposit(msg.sender, amount);
    }

    /**
     * @dev Burns the user's MZUSD and initiates a USDC withdrawal from the Vault.
     * If the Vault has sufficient liquidity, the withdrawal is instant.
     * Otherwise, the request is added to a queue for later processing.
     * @param amount The amount of MZUSD to burn for USDC.
     */
    function withdraw(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf(msg.sender) < amount) revert InsufficientBalance();
        if (queueIndex[msg.sender] != 0) revert WithdrawalRequestAlreadyExists();
        
        _checkAndUpdateHourlyLimit(msg.sender, amount);
        _burn(msg.sender, amount);
        
        uint256 vaultBal = usdc.balanceOf(address(vault));
        if (vaultBal >= amount) {
            vault.withdraw(address(usdc), msg.sender, amount);
            emit InstantWithdrawal(msg.sender, amount);
        } else {
            uint256 idx = withdrawalQueue.length;
            withdrawalQueue.push(WithdrawalRequest(msg.sender, amount));
            queueIndex[msg.sender] = idx + 1;
            emit WithdrawalQueued(msg.sender, amount, idx);
        }
    }

    /**
     * @dev Allows a user to cancel their pending withdrawal request.
     * The user's previously burned MZUSD are minted back to them.
     */
    function cancelWithdrawal() external nonReentrant {
        uint256 idxPlus = queueIndex[msg.sender];
        if (idxPlus == 0) revert NotInWithdrawalQueue();
        
        uint256 idx = idxPlus - 1;
        WithdrawalRequest memory req = withdrawalQueue[idx];
        uint256 last = withdrawalQueue.length - 1;
        
        if (idx != last) {
            WithdrawalRequest memory tail = withdrawalQueue[last];
            withdrawalQueue[idx] = tail;
            queueIndex[tail.user] = idx + 1;
        }
        
        withdrawalQueue.pop();
        delete queueIndex[msg.sender];
        
        _mint(msg.sender, req.amount);
        emit WithdrawalCancelled(msg.sender, req.amount);
    }

    /**
     * @dev Processes the next withdrawal request in the queue.
     * @notice This function is permissionless and intended to be called by a bot
     * when liquidity becomes available in the Vault.
     */
    function release() external nonReentrant {
        if (queueHead >= withdrawalQueue.length) revert QueueEmpty();
        
        WithdrawalRequest memory req = withdrawalQueue[queueHead];
        uint256 vaultBal = usdc.balanceOf(address(vault));
        if (vaultBal < req.amount) revert InsufficientLiquidity();
        
        delete queueIndex[req.user];
        queueHead++;
        
        vault.withdraw(address(usdc), req.user, req.amount);
        emit WithdrawalProcessed(req.user, req.amount, queueHead - 1);
        
        // Clearing the processed slot is a gas optimization, not strictly necessary for logic.
        delete withdrawalQueue[queueHead - 1];
    }

    /**
     * @dev Updates the hourly withdrawal limit.
     * @notice Can only be called by an account with the `LIMIT_SETTER_ROLE`.
     * @param newLimit The new withdrawal limit per hour.
     */
    function setHourlyWithdrawalLimit(uint256 newLimit) external onlyRole(LIMIT_SETTER_ROLE) {
        hourlyWithdrawalLimit = newLimit;
        emit HourlyWithdrawalLimitUpdated(newLimit);
    }

    // ------- view helpers --------
    
    /**
     * @dev Returns the current number of pending requests in the withdrawal queue.
     * @return The number of requests waiting for liquidity.
     */
    function getQueueLength() external view returns (uint256) {
        return withdrawalQueue.length - queueHead;
    }

    /**
     * @dev Gets the details of a user's pending withdrawal request.
     * @param user The address of the user to check.
     * @return amount The amount of the withdrawal request.
     * @return position The user's position in the queue (0-indexed). Returns max_uint if not in queue.
     */
    function getWithdrawalRequest(address user) external view returns (uint256 amount, uint256 position) {
        uint256 idxPlus = queueIndex[user];
        if (idxPlus == 0) return (0, type(uint256).max);
        uint256 idx = idxPlus - 1;
        return (withdrawalQueue[idx].amount, idx - queueHead);
    }

    /**
     * @dev Calculates the remaining amount a user can withdraw within their current hourly window.
     * @param user The address of the user.
     * @return The amount of USDC the user can still withdraw now.
     */
    function getRemainingHourlyLimit(address user) external view returns (uint256) {
        if (block.timestamp > lastWithdrawalTimestamp[user] + 1 hours) {
            return hourlyWithdrawalLimit;
        }
        uint256 spent = hourlyWithdrawnAmount[user];
        return spent >= hourlyWithdrawalLimit ? 0 : hourlyWithdrawalLimit - spent;
    }

    // ------- internal --------
    
    /**
     * @dev Internal function to check and update a user's hourly withdrawal limit.
     * @param user The address of the user.
     * @param amount The amount they are attempting to withdraw.
     */
    function _checkAndUpdateHourlyLimit(address user, uint256 amount) internal {
        if (block.timestamp > lastWithdrawalTimestamp[user] + 1 hours) {
            hourlyWithdrawnAmount[user] = 0;
        }
        uint256 newTotal = hourlyWithdrawnAmount[user] + amount;
        if (newTotal > hourlyWithdrawalLimit) revert HourlyLimitExceeded();
        
        hourlyWithdrawnAmount[user] = newTotal;
        lastWithdrawalTimestamp[user] = block.timestamp;
    }
}