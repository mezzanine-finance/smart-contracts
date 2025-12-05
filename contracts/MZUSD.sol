// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "./interfaces/IMZUSD.sol";
import "./interfaces/IVault.sol";

/// @title MZUSD stablecoin
/// @notice 1 USDC (6 decimals) = 1 MZUSD (18 decimals)
contract MZUSD is
    Initializable,
    ERC20Upgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    AccessManagedUpgradeable,
    IMZUSD
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
    /// @notice duration of redemption window in seconds (e.g. 1 hours)
    uint256 public redemptionWindowDuration;

    /// @notice per-tx deposits for atomic netting
    uint256 transient _txDepositedUSDC;

    event Deposit(address indexed user, uint256 usdcAmount, uint256 mzMinted);
    event Withdrawal(address indexed user, uint256 mzBurned, uint256 usdcOut);
    event GlobalHourlyRedemptionCapUpdated(uint256 newCapUSDC);
    event SetVault(address vault);
    event RedemptionWindowDurationUpdated(uint256 newDuration);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientLiquidity();
    error InsufficientLiquidityOnVault();
    error GlobalHourlyCapExceeded();
    error ZeroCap();
    error ZeroDuration();
    error EthTransferFailed();

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
        __UUPSUpgradeable_init();

        usdc = IERC20(_usdc);
        globalHourlyRedemptionCapUSDC = _hourlyLimitUSDC;
        windowStartTimestamp = uint64(block.timestamp);
        redemptionWindowDuration = 1 hours;
    }

    /// @notice deposit USDC and mint MZUSD 1:1
    function deposit(uint256 amountUSDC) external nonReentrant restricted {
        if (vault == IVault(address(0))) revert ZeroAddress();
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
    function requestWithdrawal(uint256 amountMZ) external nonReentrant restricted {
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
        if (vaultBal < usdcOut) revert InsufficientLiquidityOnVault();

        vault.withdraw(_msgSender(), usdcOut);

        emit Withdrawal(_msgSender(), amountMZ, usdcOut);
    }

    function mint(address to, uint256 amount) external restricted {
        _mint(to, amount);
    }

    function setGlobalHourlyRedemptionCap(uint256 newCapUSDC) external restricted {
        if (newCapUSDC == 0) revert ZeroCap();
        globalHourlyRedemptionCapUSDC = newCapUSDC;
        emit GlobalHourlyRedemptionCapUpdated(newCapUSDC);
    }

    function setVault(address _vault) external restricted {
        if (_vault == address(0)) revert ZeroAddress();
        vault = IVault(_vault);
        emit SetVault(address(vault));
    }

    function setRedemptionWindowDuration(uint256 newDuration) external restricted {
        if (newDuration == 0) revert ZeroDuration();
        redemptionWindowDuration = newDuration;

        // If the current window is already longer than the new duration,
        // start a fresh window from "now" so that the shorter window
        // semantics are applied immediately.
        if (block.timestamp >= uint256(windowStartTimestamp) + newDuration) {
            windowStartTimestamp = uint64(block.timestamp);
            windowUsedUSDC = 0;
        }
        emit RedemptionWindowDurationUpdated(newDuration);
    }

    function getRemainingGlobalHourlyCap()
        public
        view
        returns (uint256 remainingUSDC, uint256 windowStart)
    {
        uint256 cap = globalHourlyRedemptionCapUSDC;

        // If cap is explicitly zero, treat it as "no redemptions allowed" for this view:
        // remaining = 0. For "no limit", callers should configure cap as type(uint256).max.
        if (cap == 0) {
            return (0, windowStartTimestamp);
        }

        if (block.timestamp >= uint256(windowStartTimestamp) + redemptionWindowDuration) {
            // New window would start on next withdrawal; expose full cap and current timestamp.
            return (cap, uint256(block.timestamp));
        }

        uint256 spent = windowUsedUSDC;
        remainingUSDC = spent >= cap ? 0 : cap - spent;
        return (remainingUSDC, windowStartTimestamp);
    }

    function calculateDeposit(uint256 amountUSDC) external pure returns (uint256 mintMZ) {
        return amountUSDC * SCALE;
    }

    /// @notice Pure calculator - converts MZUSD amount to USDC and dust.
    function calculateWithdrawalAmounts(
        uint256 amountMZ
    ) public pure returns (uint256 usdcOut, uint256 dustMZ) {
        usdcOut = amountMZ / SCALE;
        dustMZ = amountMZ % SCALE;
    }

    function decimals() public pure override returns (uint8) {
        return MZ_DECIMALS;
    }

    function previewWithdrawalFlat(
        uint256 amountMZ
    )
        external
        view
        returns (
            uint256 requestedMZ,
            uint256 userBalanceMZ,
            bool hasEnoughMZ,
            uint256 usdcOut,
            uint256 dustMZ,
            uint256 vaultLiquidityUSDC,
            bool hasSufficientLiquidity,
            uint256 globalCapUSDC,
            uint256 windowStart,
            uint256 windowEnd,
            uint256 windowUsedUSDC_,
            uint256 windowRemainingUSDC,
            bool isGlobalCapZero,
            bool wouldExceedGlobalCap
        )
    {
        requestedMZ = amountMZ;

        userBalanceMZ = balanceOf(_msgSender());
        hasEnoughMZ = userBalanceMZ >= amountMZ;

        (usdcOut, dustMZ) = calculateWithdrawalAmounts(amountMZ);

        if (address(vault) != address(0)) {
            vaultLiquidityUSDC = usdc.balanceOf(address(vault));
        } else {
            vaultLiquidityUSDC = 0;
        }
        hasSufficientLiquidity = vaultLiquidityUSDC >= usdcOut;

        globalCapUSDC = globalHourlyRedemptionCapUSDC;
        isGlobalCapZero = (globalCapUSDC == 0);

        (windowRemainingUSDC, windowStart) = getRemainingGlobalHourlyCap();

        uint256 storedUsed = windowUsedUSDC;
        if (
            globalCapUSDC > 0 &&
            globalCapUSDC != type(uint256).max &&
            windowRemainingUSDC <= globalCapUSDC
        ) {
            windowUsedUSDC_ = globalCapUSDC - windowRemainingUSDC;
        } else {
            windowUsedUSDC_ = storedUsed;
        }

        if (redemptionWindowDuration == 0) {
            windowEnd = windowStart;
        } else {
            windowEnd = windowStart + redemptionWindowDuration;
        }

        if (globalCapUSDC == 0) {
            wouldExceedGlobalCap = (usdcOut > 0);
        } else if (globalCapUSDC == type(uint256).max) {
            wouldExceedGlobalCap = false;
        } else {
            wouldExceedGlobalCap = (usdcOut > windowRemainingUSDC);
        }
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

        // Cap == 0 now means "zero allowed" (hard stop). For "no limit", use type(uint256).max.
        if (cap == 0) {
            if (usdcAmount > 0) revert GlobalHourlyCapExceeded();
            return;
        }

        if (block.timestamp >= uint256(windowStartTimestamp) + redemptionWindowDuration) {
            windowStartTimestamp = uint64(block.timestamp);
            windowUsedUSDC = 0;
        }

        uint256 newTotal = windowUsedUSDC + usdcAmount;
        if (newTotal > cap) revert GlobalHourlyCapExceeded();

        windowUsedUSDC = newTotal;
    }

    
    /// @notice Emergency helper to recover ETH that might be accidentally sent to this contract.
    /// @dev Due to inheriting UUPSUpgradeable, the implementation exposes a payable
    ///      `upgradeToAndCall` function, so static analyzers treat this contract as
    ///      capable of receiving ETH. In normal operation, `msg.value` is forwarded
    ///      via the proxy and no ETH should remain here, but having an explicit
    ///      withdrawal function avoids locking ETH that may arrive via selfdestruct
    ///      or mistaken transfers. This function is not part of the normal protocol
    ///      flow and is restricted to the admin role.
    function rescueETH(address to, uint256 amount) external restricted {
        if (to == address(0)) revert ZeroAddress();

        uint256 bal = address(this).balance;
        if (amount > bal) {
            amount = bal;
        }

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    function _authorizeUpgrade(address) internal override restricted {}
}
