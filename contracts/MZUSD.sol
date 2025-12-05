// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";

import "./interfaces/IVault.sol";

/// @title MZUSD stablecoin
/// @notice 1 USDC (6 decimals) = 1 MZUSD (18 decimals)
contract MZUSD is
    Initializable,
    ERC20Upgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    AccessManagedUpgradeable
{
    using SafeERC20 for IERC20;


    IERC20 public usdc;
    IVault public vault;

    uint8 public constant USDC_DECIMALS = 6;
    uint8 public constant MZ_DECIMALS = 18;
    uint256 private constant SCALE = 10 ** (MZ_DECIMALS - USDC_DECIMALS);

    /// @notice global hourly redemption cap in USDC (6 decimals); 0 = disabled
    uint256 public globalHourlyRedemptionCapUSDC;
    uint64 public windowStartTimestamp;
    uint256 public windowUsedUSDC;

    /// @notice per-tx deposits for atomic netting
    uint256 transient _txDepositedUSDC;

    event Deposit(address indexed user, uint256 usdcAmount, uint256 mzMinted);
    event Withdrawal(address indexed user, uint256 mzBurned, uint256 usdcOut);
    event GlobalHourlyRedemptionCapUpdated(uint256 newCapUSDC);
    event SetVault(address vault);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientLiquidity();
    error GlobalHourlyCapExceeded();


    constructor() {
        _disableInitializers();
    }

    function initialize(
        address accessManager,
        address _usdc,
        uint256 _hourlyLimitUSDC
    ) external initializer {
        if (accessManager == address(0) || _usdc == address(0)) {
            revert ZeroAddress();
        }

        __ERC20_init("MZUSD Token", "MZUSD");
        __AccessManaged_init(accessManager);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        usdc = IERC20(_usdc);
        globalHourlyRedemptionCapUSDC = _hourlyLimitUSDC;
        windowStartTimestamp = uint64(block.timestamp);
    }

    /// @notice deposit USDC and mint MZUSD 1:1
    function deposit(uint256 amountUSDC) external whenNotPaused nonReentrant {
        if (amountUSDC == 0) revert ZeroAmount();

        _txDepositedUSDC += amountUSDC;

        usdc.safeTransferFrom(_msgSender(), address(vault), amountUSDC);

        uint256 mintAmount = amountUSDC * SCALE;
        _mint(_msgSender(), mintAmount);

        emit Deposit(_msgSender(), amountUSDC, mintAmount);
    }

    /// @notice request withdrawal of MZUSD for USDC
    /// @dev v1: executes instantly if vault has liquidity
    /// @dev v2: can be changed to enqueue
    function requestWithdrawal(uint256 amountMZ) external whenNotPaused nonReentrant {
        if (amountMZ == 0) revert ZeroAmount();
        if (balanceOf(_msgSender()) < amountMZ) revert InsufficientBalance();

        uint256 usdcOut = amountMZ / SCALE;
        if (usdcOut == 0) revert InsufficientLiquidity();

        uint256 effectiveForLimit = _applyAtomicNetting(usdcOut);
        if (effectiveForLimit != 0) {
            _checkAndConsumeGlobalCap(effectiveForLimit);
        }

        _burn(_msgSender(), amountMZ);

        uint256 vaultBal = usdc.balanceOf(address(vault));
        if (vaultBal < usdcOut) revert InsufficientLiquidity();

        vault.withdraw(_msgSender(), usdcOut);

        emit Withdrawal(_msgSender(), amountMZ, usdcOut);
    }

     function mint(address to, uint256 amount) external restricted {
        _mint(to, amount);
    }

    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
        _unpause();
    }

    function setGlobalHourlyRedemptionCap(uint256 newCapUSDC) external restricted {
        globalHourlyRedemptionCapUSDC = newCapUSDC;
        emit GlobalHourlyRedemptionCapUpdated(newCapUSDC);
    }

    function setVault(address _vault) external restricted { 
        if (_vault == address(0)) revert ZeroAddress();
        vault = IVault(_vault);
        emit SetVault(address(vault));
    }

    function getRemainingGlobalHourlyCap()
        external
        view
        returns (uint256 remainingUSDC, uint256 windowStart)
    {
        if (globalHourlyRedemptionCapUSDC == 0) {
            return (type(uint256).max, windowStartTimestamp);
        }
        if (block.timestamp >= uint256(windowStartTimestamp) + 1 hours) {
            return (globalHourlyRedemptionCapUSDC, uint256(block.timestamp));
        }
        uint256 spent = windowUsedUSDC;
        remainingUSDC = spent >= globalHourlyRedemptionCapUSDC
            ? 0
            : globalHourlyRedemptionCapUSDC - spent;
        return (remainingUSDC, windowStartTimestamp);
    }

    function previewDeposit(uint256 amountUSDC) external pure returns (uint256 mintMZ) {
        return amountUSDC * SCALE;
    }

    function previewWithdrawal(uint256 amountMZ)
        external
        pure
        returns (uint256 usdcOut, uint256 dustMZ)
    {
        usdcOut = amountMZ / SCALE;
        dustMZ = amountMZ % SCALE;
    }

    function decimals() public pure override returns (uint8) {
        return MZ_DECIMALS;
    }

    function _applyAtomicNetting(uint256 usdcOut) internal returns (uint256) {
        uint256 txDeposited = _txDepositedUSDC;
        if (txDeposited == 0) {
            return usdcOut;
        }
        if (txDeposited >= usdcOut) {
            _txDepositedUSDC = txDeposited - usdcOut;
            return 0;
        } else {
            _txDepositedUSDC = 0;
            return usdcOut - txDeposited;
        }
    }

    function _checkAndConsumeGlobalCap(uint256 usdcAmount) internal {
        uint256 cap = globalHourlyRedemptionCapUSDC;
        if (cap == 0) return;

        if (block.timestamp >= uint256(windowStartTimestamp) + 1 hours) {
            windowStartTimestamp = uint64(block.timestamp);
            windowUsedUSDC = 0;
        }

        uint256 newTotal = windowUsedUSDC + usdcAmount;
        if (newTotal > cap) revert GlobalHourlyCapExceeded();

        windowUsedUSDC = newTotal;
    }

    function _authorizeUpgrade(address) internal override restricted {}
}