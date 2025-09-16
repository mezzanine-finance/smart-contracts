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
/// To limit risk, the system enforces a global hourly redemption cap (in USDC terms).
contract MZUSD is ERC20, ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    // Request in MZUSD (18 decimals)
    struct WithdrawalRequest {
        address user;
        uint256 amountMZ; // store in 18-decimals MZ units
        uint64 createdAt; // timestamp of request creation (for window accounting)
    }

    bytes32 public constant LIMIT_SETTER_ROLE = keccak256("LIMIT_SETTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable usdc;
    IVault public immutable vault;

    // Decimals & scaling
    uint8 public constant USDC_DECIMALS = 6;
    uint8 public constant MZ_DECIMALS = 18;
    uint256 private constant SCALE = 10 ** (MZ_DECIMALS - USDC_DECIMALS); // 1e12

    // Global hourly redemption cap (USDC-6)
    uint256 public globalHourlyRedemptionCapUSDC; // 0 = disabled
    uint64 public windowStartTimestamp; // start of current 1h window
    uint256 public windowUsedUSDC; // consumed in current window (USDC-6)

    WithdrawalRequest[] public withdrawalQueue;
    uint256 public queueHead; // index of the next request to process
    mapping(address => uint256) private queueIndex; // idx+1 in withdrawal queue

    event GlobalHourlyRedemptionCapUpdated(uint256 newCapUSDC);
    error GlobalHourlyCapExceeded();

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
    /// @param _hourlyLimitUSDC Initial global hourly withdrawal limit (in USDC base units, 6 decimals)
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
        globalHourlyRedemptionCapUSDC = _hourlyLimitUSDC;
        windowStartTimestamp = uint64(block.timestamp);

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
    /// Withdrawals are limited by an hourly global limit (in USDC terms).
    /// 1 MZUSD (18 decimals) = 1 USDC (6 decimals)
    /// Any "dust" MZUSD that cannot be redeemed for USDC (amountMZ < 1e12) is kept by the protocol.
    function withdrawalRequest(
        uint256 amountMZ
    ) external whenNotPaused nonReentrant {
        if (amountMZ == 0) revert ZeroAmount();
        if (balanceOf(msg.sender) < amountMZ) revert InsufficientBalance();
        if (queueIndex[msg.sender] != 0)
            revert WithdrawalRequestAlreadyExists();

        // convert to USDC (floor in favor of protocol)
        uint256 usdcOut = amountMZ / SCALE;
        if (usdcOut == 0) revert DustOnlyWithdrawal();

        _checkAndConsumeGlobalCap(usdcOut);
        _burn(msg.sender, amountMZ);

        uint256 vaultBal = usdc.balanceOf(address(vault));
        if (vaultBal >= usdcOut) {
            vault.withdraw(address(usdc), msg.sender, usdcOut);
            emit InstantWithdrawal(msg.sender, amountMZ, usdcOut);
        } else {
            uint256 idx = withdrawalQueue.length;
            withdrawalQueue.push(
                WithdrawalRequest({
                    user: msg.sender,
                    amountMZ: amountMZ,
                    createdAt: uint64(block.timestamp)
                })
            );
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

        // remove from cap if request is in current window
        uint256 usdcOut = req.amountMZ / SCALE;
        if (
            globalHourlyRedemptionCapUSDC != 0 &&
            req.createdAt >= windowStartTimestamp
        ) {
            if (usdcOut <= windowUsedUSDC) {
                windowUsedUSDC -= usdcOut;
            } else {
                windowUsedUSDC = 0;
            }
        }

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

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Sets a new global hourly redemption cap (in USDC terms)
    /// @param newCapUSDC New hourly cap in USDC base units (6 decimals), 0 = disabled
    /// @dev Can only be called by an account with the LIMIT_SETTER_ROLE role
    function setGlobalHourlyRedemptionCap(
        uint256 newCapUSDC
    ) external onlyRole(LIMIT_SETTER_ROLE) {
        globalHourlyRedemptionCapUSDC = newCapUSDC;
        emit GlobalHourlyRedemptionCapUpdated(newCapUSDC);
    }

    /// @notice Returns the remaining USDC amount that can be redeemed in the current hourly window
    /// @return remainingUSDC Remaining USDC amount that can be redeemed (6 decimals)
    /// @return windowStart of the start of the current hourly window
    function getRemainingGlobalHourlyCap()
        external
        view
        returns (uint256 remainingUSDC, uint256 windowStart)
    {
        if (globalHourlyRedemptionCapUSDC == 0)
            return (type(uint256).max, windowStartTimestamp);
        if (block.timestamp >= uint256(windowStartTimestamp) + 1 hours) {
            return (globalHourlyRedemptionCapUSDC, uint256(block.timestamp));
        }
        uint256 spent = windowUsedUSDC;
        remainingUSDC = spent >= globalHourlyRedemptionCapUSDC
            ? 0
            : globalHourlyRedemptionCapUSDC - spent;
        return (remainingUSDC, windowStartTimestamp);
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

    /// @notice Checks and consumes the global hourly redemption cap
    /// @param usdcAmount Amount of USDC (6 decimals) to check and consume from the global hourly cap
    function _checkAndConsumeGlobalCap(uint256 usdcAmount) internal {
        uint256 cap = globalHourlyRedemptionCapUSDC;
        if (cap == 0) return; // disabled

        // roll window if an hour passed
        if (block.timestamp >= uint256(windowStartTimestamp) + 1 hours) {
            windowStartTimestamp = uint64(block.timestamp);
            windowUsedUSDC = 0;
        }

        uint256 newTotal = windowUsedUSDC + usdcAmount;
        if (newTotal > cap) revert GlobalHourlyCapExceeded();

        windowUsedUSDC = newTotal;
    }
}
