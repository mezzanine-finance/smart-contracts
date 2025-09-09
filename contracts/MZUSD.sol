// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

interface IVault {
    function withdraw(address token, address to, uint256 amount) external;
}

/// @title MZUSD stablecoin
/// @notice MZUSD is a USD-pegged stablecoin backed by USDC in a vault.
/// Users can mint MZUSD by depositing USDC and can burn MZUSD to redeem USDC.
/// Withdrawals are instant if the vault has enough USDC liquidity,
/// otherwise they are queued and processed later by anyone when liquidity is available.
/// To limit risk, users have an hourly withdrawal limit (in USDC terms).
contract MZUSD is ERC20, ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    // Request in MZUSD (18 decimals)
    struct WithdrawalRequest {
        address user;
        uint256 amountMZ; // store in 18-decimals MZ units
    }

    bytes32 public constant LIMIT_SETTER_ROLE = keccak256("LIMIT_SETTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable usdc;
    IVault public immutable vault;

    // Decimals & scaling
    uint8 public constant USDC_DECIMALS = 6;
    uint8 public constant MZ_DECIMALS = 18;
    uint256 private constant SCALE = 10 ** (MZ_DECIMALS - USDC_DECIMALS); // 1e12

    // Hourly limit in USDC base units (6 decimals)
    uint256 public hourlyWithdrawalLimitUSDC;

    WithdrawalRequest[] public withdrawalQueue;
    uint256 public queueHead; // index of the next request to process
    mapping(address => uint256) private queueIndex; // idx+1 in withdrawal queue

    // Track hourly spent in USDC base units
    mapping(address => uint256) public hourlyWithdrawnUSDC;
    mapping(address => uint256) public lastWithdrawalTimestamp;

    event Deposit(address indexed user, uint256 usdcAmount, uint256 mzMinted);
    event InstantWithdrawal(
        address indexed user,
        uint256 mzBurned,
        uint256 usdcOut
    );
    event WithdrawalQueued(
        address indexed user,
        uint256 mzAmount,
        uint256 queuePos
    );
    event WithdrawalCancelled(address indexed user, uint256 mzAmount);
    event WithdrawalProcessed(
        address indexed user,
        uint256 mzAmount,
        uint256 usdcOut,
        uint256 queuePos
    );
    event HourlyWithdrawalLimitUpdated(uint256 newLimitUSDC);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance();
    error WithdrawalRequestAlreadyExists();
    error HourlyLimitExceeded();
    error NotInWithdrawalQueue();
    error QueueEmpty();
    error InsufficientLiquidity();
    error DustOnlyWithdrawal(); // when mzAmount < SCALE -> would produce 0 USDC
        
    /// @param _usdc Address of the USDC token contract
    /// @param _vault Address of the vault contract where USDC is stored
    /// @param _hourlyLimitUSDC Initial hourly withdrawal limit per user (in USDC base units, 6 decimals)
    /// @param _admin Address to be granted admin roles
    constructor(
        address _usdc,
        address _vault,
        uint256 _hourlyLimitUSDC,
        address _admin
    ) ERC20("MZUSD Token", "MZUSD") {
        if (_admin == address(0) || _vault == address(0) || _usdc == address(0))
            revert ZeroAddress();
        usdc = IERC20(_usdc);
        vault = IVault(_vault);
        hourlyWithdrawalLimitUSDC = _hourlyLimitUSDC;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(LIMIT_SETTER_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);
    }

    /// @notice Mints MZUSD tokens in exchange for USDC deposited into the vault
    /// @param amountUSDC Amount of USDC to deposit (6 decimals)
    /// @dev 1 USDC (6 decimals) = 1 MZUSD (18 decimals)
    function deposit(uint256 amountUSDC) external whenNotPaused nonReentrant {
        if (amountUSDC == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(vault), amountUSDC);

        uint256 mintAmount = amountUSDC * SCALE; // 6->18
        _mint(msg.sender, mintAmount);
        emit Deposit(msg.sender, amountUSDC, mintAmount);
    }

    /// @notice Burns MZUSD tokens to redeem USDC from the vault
    /// @param amountMZ Amount of MZUSD to burn (18 decimals)
    /// @dev If the vault has enough USDC liquidity, the withdrawal is instant.
    /// Otherwise, the request is queued and can be processed later by anyone.
    /// Withdrawals are limited by an hourly limit per user (in USDC terms).
    /// 1 MZUSD (18 decimals) = 1 USDC (6 decimals)
    /// Any "dust" MZUSD that cannot be redeemed for USDC (amountMZ < 1e12) is kept by the protocol.
    function withdraw(uint256 amountMZ) external whenNotPaused nonReentrant {
        if (amountMZ == 0) revert ZeroAmount();
        if (balanceOf(msg.sender) < amountMZ) revert InsufficientBalance();
        if (queueIndex[msg.sender] != 0)
            revert WithdrawalRequestAlreadyExists();

        // convert to USDC (floor in favor of protocol)
        uint256 usdcOut = amountMZ / SCALE;
        if (usdcOut == 0) revert DustOnlyWithdrawal();

        _checkAndUpdateHourlyLimit(msg.sender, usdcOut);
        _burn(msg.sender, amountMZ);

        uint256 vaultBal = usdc.balanceOf(address(vault));
        if (vaultBal >= usdcOut) {
            vault.withdraw(address(usdc), msg.sender, usdcOut);
            emit InstantWithdrawal(msg.sender, amountMZ, usdcOut);
        } else {
            uint256 idx = withdrawalQueue.length;
            withdrawalQueue.push(WithdrawalRequest(msg.sender, amountMZ));
            queueIndex[msg.sender] = idx + 1;
            emit WithdrawalQueued(msg.sender, amountMZ, idx);
        }
    }

    /// @notice Cancels a pending withdrawal request and mints back the MZUSD tokens
    /// @dev Can only be called if the user has a pending withdrawal request
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

        _mint(msg.sender, req.amountMZ);
        emit WithdrawalCancelled(msg.sender, req.amountMZ);
    }

    /// @notice Processes the next pending withdrawal request in the queue
    /// @dev Can be called by anyone. If the vault has enough USDC liquidity,
    /// the request is fulfilled and the user receives USDC.
    /// Otherwise, the function reverts.
    function release() external nonReentrant {
        if (queueHead >= withdrawalQueue.length) revert QueueEmpty();

        WithdrawalRequest memory req = withdrawalQueue[queueHead];
        uint256 usdcOut = req.amountMZ / SCALE; // floor, favor protocol
        // if (usdcOut == 0) revert InsufficientLiquidity(); // nothing meaningful to pay

        uint256 vaultBal = usdc.balanceOf(address(vault));
        if (vaultBal < usdcOut) revert InsufficientLiquidity();

        delete queueIndex[req.user];
        queueHead++;

        vault.withdraw(address(usdc), req.user, usdcOut);
        emit WithdrawalProcessed(
            req.user,
            req.amountMZ,
            usdcOut,
            queueHead - 1
        );

        delete withdrawalQueue[queueHead - 1];
    }

    /// @notice Sets a new hourly withdrawal limit per user (in USDC terms)
    /// @param newLimitUSDC New hourly withdrawal limit (in USDC base units, 6 decimals)
    function setHourlyWithdrawalLimit(
        uint256 newLimitUSDC
    ) external onlyRole(LIMIT_SETTER_ROLE) {
        hourlyWithdrawalLimitUSDC = newLimitUSDC;
        emit HourlyWithdrawalLimitUpdated(newLimitUSDC);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Returns the number of pending withdrawal requests in the queue
    function getQueueLength() external view returns (uint256) {
        return withdrawalQueue.length - queueHead;
    }

    /// @notice Returns the details of a user's pending withdrawal request
    /// @param user Address of the user
    /// @return amountMZ Amount of MZUSD in the pending request (18 decimals)
    /// @return position Position in the queue (max uint256 if not in queue)
    function getWithdrawalRequest(
        address user
    ) external view returns (uint256 amountMZ, uint256 position) {
        uint256 idxPlus = queueIndex[user];
        if (idxPlus == 0) return (0, type(uint256).max);
        uint256 idx = idxPlus - 1;
        return (withdrawalQueue[idx].amountMZ, idx - queueHead);
    }

    /// @notice Returns the remaining hourly withdrawal limit for a user
    /// @param user Address of the user
    /// @return Remaining amount of USDC that the user can withdraw in the current hour (6 decimals)
    function getRemainingHourlyLimit(
        address user
    ) external view returns (uint256) {
        if (block.timestamp > lastWithdrawalTimestamp[user] + 1 hours) {
            return hourlyWithdrawalLimitUSDC;
        }
        uint256 spent = hourlyWithdrawnUSDC[user];
        return
            spent >= hourlyWithdrawalLimitUSDC
                ? 0
                : hourlyWithdrawalLimitUSDC - spent;
    }

    /// @notice Simulates the amount of MZUSD that would be minted for a given USDC deposit
    /// @param amountUSDC Amount of USDC to deposit (6 decimals)
    /// @return mintMZ Amount of MZUSD that would be minted (18 decimals)
    function previewDeposit(
        uint256 amountUSDC
    ) external pure returns (uint256 mintMZ) {
        return amountUSDC * SCALE;
    }

    /// @notice Simulates the amount of USDC that would be received for a given MZUSD burn
    /// @param amountMZ Amount of MZUSD to burn (18 decimals)
    /// @return usdcOut Amount of USDC that would be received (6 decimals)
    /// @return dustMZ Amount of MZUSD "dust" that cannot be redeemed for USDC (less than 1e12)
    /// @dev The "dust" MZUSD is kept by the protocol.
    function previewWithdraw(
        uint256 amountMZ
    ) external pure returns (uint256 usdcOut, uint256 dustMZ) {
        usdcOut = amountMZ / SCALE;
        dustMZ = amountMZ % SCALE; // this “dust” is implicitly kept by protocol via floor
    }
    
    function decimals() public pure override returns (uint8) {
        return MZ_DECIMALS;
    }

    /// @dev Checks and updates the hourly withdrawal limit for a user
    /// Reverts if the new withdrawal would exceed the limit
    /// @param user Address of the user
    /// @param usdcAmount Amount of USDC to withdraw (6 decimals)
    function _checkAndUpdateHourlyLimit(
        address user,
        uint256 usdcAmount
    ) internal {
        if (block.timestamp > lastWithdrawalTimestamp[user] + 1 hours) {
            hourlyWithdrawnUSDC[user] = 0;
        }
        uint256 newTotal = hourlyWithdrawnUSDC[user] + usdcAmount;
        if (newTotal > hourlyWithdrawalLimitUSDC) revert HourlyLimitExceeded();

        hourlyWithdrawnUSDC[user] = newTotal;
        lastWithdrawalTimestamp[user] = block.timestamp;
    }
}
