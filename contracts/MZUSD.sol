// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";

// aderyn-fp-next-line(reused-contract-name)
interface IVault {
    function withdraw(address to, uint256 amountUSDC) external;
}

/// @title MZUSD stablecoin
/// @notice 1 USDC (6 decimals) = 1 MZUSD (18 decimals)
/// @notice Supports atomic netting of deposits vs withdrawals within the same tx.
/// @notice Supports global hourly redemption cap in USDC (6 decimals).
contract MZUSD is ERC20Upgradeable, UUPSUpgradeable, AccessManagedUpgradeable {
    IERC20 public immutable usdc;

    uint8 public constant USDC_DECIMALS = 6;
    uint8 public constant MZ_DECIMALS = 18;
    uint256 private constant SCALE = 10 ** (MZ_DECIMALS - USDC_DECIMALS);

    IVault public immutable vault;
    /// @notice start timestamp of current redemption window
    uint40 public windowStartTimestamp;
    /// @notice duration of redemption window in seconds (e.g. 1 hours)
    uint32 public redemptionWindowDuration;
    /// @notice global hourly redemption cap in USDC (6 decimals); must be > 0
    uint256 public globalHourlyRedemptionCapUSDC;
    /// @notice amount of USDC redeemed in current window
    uint256 public windowUsedUSDC;

    /// @notice per-tx deposits for atomic netting
    uint256 transient _txDepositedUSDC;

    event Deposit(address indexed user, uint256 usdcAmount, uint256 mzMinted);
    event Withdrawal(address indexed user, uint256 mzBurned, uint256 usdcOut);
    event GlobalHourlyRedemptionCapUpdated(uint256 newCapUSDC);
    event RedemptionWindowDurationUpdated(uint32 newDuration);

    error ZeroAmount();
    error ZeroAddress();
    error ZeroCap();
    error ZeroDuration();
    error SameValue();
    error CapExceedsTotalSupply(uint256 capUSDC, uint256 totalSupplyUSDC);
    error TooSmallWithdrawalAmount(uint256 requestedMZ, uint256 usdcOut);
    error GlobalHourlyCapExceeded(uint256 capUSDC, uint256 usedUSDC, uint256 attemptedUSDC);
    error InvalidUSDCDecimals(uint8 actualDecimals);
    error EthTransferFailed(address to, uint256 attemptedAmount);

    constructor(address _usdc, address _vault) {
        if (_usdc == address(0) || _vault == address(0)) revert ZeroAddress();

        // aderyn-fp-next-line(reentrancy-state-change)
        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals != USDC_DECIMALS) revert InvalidUSDCDecimals(usdcDecimals);

        usdc = IERC20(_usdc);
        vault = IVault(_vault);
        _disableInitializers();
    }

    /// @param accessManager - address of AccessManager contract for role management
    /// @param _hourlyLimitUSDC - initial global hourly redemption cap in USDC (6 decimals)
    function initialize(address accessManager, uint256 _hourlyLimitUSDC) external initializer {
        if (accessManager == address(0)) {
            revert ZeroAddress();
        }

        __ERC20_init("MZUSD Token", "MZUSD");
        __AccessManaged_init(accessManager);

        _setGlobalHourlyRedemptionCap(_hourlyLimitUSDC);
        windowStartTimestamp = uint40(block.timestamp);
        redemptionWindowDuration = 1 hours;
    }

    /// @notice deposit USDC and mint MZUSD 1:1
    /// @param amountUSDC - amount of USDC to deposit (6 decimals)
    function deposit(uint256 amountUSDC) external restricted {
        if (amountUSDC == 0) revert ZeroAmount();

        address sender = msg.sender;

        _txDepositedUSDC += amountUSDC;

        // USDC is a well-behaved ERC20; direct transferFrom is safe here.
        usdc.transferFrom(sender, address(vault), amountUSDC);

        uint256 mintAmount = amountUSDC * SCALE;
        _mint(sender, mintAmount);

        emit Deposit(sender, amountUSDC, mintAmount);
    }

    /// @notice request withdrawal of MZUSD for USDC
    /// @param amountMZ - amount of MZUSD to burn (18 decimals)
    /// @dev v1: executes instantly if vault has liquidity (or can pull from Reservoir)
    /// @dev v2: will be changed to enqueue
    function requestWithdrawal(uint256 amountMZ) external restricted {
        address sender = msg.sender;

        uint256 usdcOut = amountMZ / SCALE;
        if (usdcOut == 0) revert TooSmallWithdrawalAmount(amountMZ, usdcOut);
        uint256 burnAmount = usdcOut * SCALE;

        uint256 effectiveForLimit = _applyAtomicNetting(usdcOut);
        if (effectiveForLimit != 0) {
            _checkAndConsumeGlobalCap(effectiveForLimit);
        }

        _burn(sender, burnAmount);

        vault.withdraw(sender, usdcOut);

        emit Withdrawal(sender, burnAmount, usdcOut);
    }

    function transfer(address to, uint256 value) public override restricted returns (bool) {
        return super.transfer(to, value);
    }

    function approve(address spender, uint256 value) public override restricted returns (bool) {
        return super.approve(spender, value);
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) public override restricted returns (bool) {
        return super.transferFrom(from, to, value);
    }

    //MINT/BURN for authorized contracts (fees, yield distribution, burn losses)

    /// @notice mint MZUSD to an address
    /// @dev Used by authorized contracts to mint MZUSD
    function mint(address to, uint256 amount) external restricted {
        _mint(to, amount);
    }

    /// @notice burn MZUSD from an address
    /// @dev Used by authorized contracts to burn MZUSD
    function burn(address from, uint256 amount) external restricted {
        _burn(from, amount);
    }

    //SETTERS

    /// @notice set global hourly redemption cap in USDC (6 decimals)
    /// @param newCapUSDC - new cap value; must be > 0 and <= USDC total supply
    function setGlobalHourlyRedemptionCap(uint256 newCapUSDC) external restricted {
        if (globalHourlyRedemptionCapUSDC == newCapUSDC) revert SameValue();
        _setGlobalHourlyRedemptionCap(newCapUSDC);
    }

    /// @notice set the duration of the redemption window
    /// @param newDuration - new duration in seconds
    function setRedemptionWindowDuration(uint32 newDuration) external restricted {
        if (newDuration == 0) revert ZeroDuration();
        if (redemptionWindowDuration == newDuration) revert SameValue();

        redemptionWindowDuration = newDuration;

        // If the current window is already longer than the new duration,
        // start a fresh window from "now" so that the shorter window
        // semantics are applied immediately.
        if (block.timestamp >= uint256(windowStartTimestamp) + newDuration) {
            windowStartTimestamp = uint40(block.timestamp);
            windowUsedUSDC = 0;
        }
        emit RedemptionWindowDurationUpdated(newDuration);
    }

    //GETTERS

    /// @notice view remaining USDC available for redemption in current window
    /// @return remainingUSDC - amount of USDC left that can be redeemed in current window
    /// @return windowStart - start timestamp of the current redemption window
    function getRemainingGlobalHourlyCap()
        public
        view
        returns (uint256 remainingUSDC, uint40 windowStart)
    {
        uint256 cap = globalHourlyRedemptionCapUSDC;

        if (block.timestamp >= uint256(windowStartTimestamp) + redemptionWindowDuration) {
            // New window would start on next withdrawal; expose full cap and current timestamp.
            return (cap, uint40(block.timestamp));
        }

        uint256 spent = windowUsedUSDC;
        remainingUSDC = spent >= cap ? 0 : cap - spent;
        return (remainingUSDC, windowStartTimestamp);
    }

    /// @notice Pure calculator - converts USDC amount to MZUSD.
    function calculateDeposit(uint256 amountUSDC) external pure returns (uint256 mintMZ) {
        return amountUSDC * SCALE;
    }

    function decimals() public pure override returns (uint8) {
        return MZ_DECIMALS;
    }

    /// @notice preview withdrawal details without executing
    /// @param amountMZ - amount of MZUSD to burn (18 decimals)
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
            uint256 unconvertedMZ,
            uint256 vaultLiquidityUSDC,
            bool hasSufficientLiquidity,
            uint256 globalCapUSDC,
            uint40 windowStart,
            uint40 windowEnd,
            uint256 windowUsedUSDC_,
            uint256 windowRemainingUSDC,
            bool isGlobalCapZero,
            bool wouldExceedGlobalCap
        )
    {
        usdcOut = amountMZ / SCALE;
        uint256 burnAmount = usdcOut * SCALE;
        unconvertedMZ = amountMZ - burnAmount;
        requestedMZ = burnAmount;

        userBalanceMZ = balanceOf(msg.sender);
        hasEnoughMZ = userBalanceMZ >= burnAmount;

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
        if (globalCapUSDC > 0 && windowRemainingUSDC <= globalCapUSDC) {
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
        } else {
            wouldExceedGlobalCap = (usdcOut > windowRemainingUSDC);
        }
    }

    ///INTERNAL HELPERS

    /// @notice apply atomic netting of deposits against withdrawals within the same tx
    /// @param usdcOut - initial USDC amount to withdraw
    /// @return adjusted USDC amount to withdraw after netting
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

    /// @notice check and consume from the global hourly redemption cap
    function _checkAndConsumeGlobalCap(uint256 usdcAmount) internal {
        uint256 cap = globalHourlyRedemptionCapUSDC;

        if (block.timestamp >= uint256(windowStartTimestamp) + redemptionWindowDuration) {
            windowStartTimestamp = uint40(block.timestamp);
            windowUsedUSDC = 0;
        }

        uint256 newTotal = windowUsedUSDC + usdcAmount;
        if (newTotal > cap) revert GlobalHourlyCapExceeded(cap, windowUsedUSDC, usdcAmount);

        windowUsedUSDC = newTotal;
    }

    function _setGlobalHourlyRedemptionCap(uint256 newCapUSDC) internal {
        if (newCapUSDC == 0) {
            revert ZeroCap();
        }

        uint256 totalSupplyUSDC = usdc.totalSupply();
        if (newCapUSDC > totalSupplyUSDC) {
            revert CapExceedsTotalSupply(newCapUSDC, totalSupplyUSDC);
        }

        globalHourlyRedemptionCapUSDC = newCapUSDC;
        emit GlobalHourlyRedemptionCapUpdated(newCapUSDC);
    }

    /// @notice Emergency helper to recover ETH that might be accidentally sent to this contract.
    /// @dev Due to inheriting UUPSUpgradeable, the implementation exposes a payable
    ///      `upgradeToAndCall` function, so static analyzers treat this contract as
    ///      capable of receiving ETH. In normal operation, `msg.value` is forwarded
    ///      via the proxy and no ETH should remain here, but having an explicit
    ///      withdrawal function avoids locking ETH that may arrive via selfdestruct
    ///      or mistaken transfers. This function is not part of the normal protocol
    ///      flow and is restricted to the admin role.
    // aderyn-ignore-next-line(state-change-without-event)
    function rescueETH(address to, uint256 amount) external restricted {
        if (to == address(0)) revert ZeroAddress();

        uint256 bal = address(this).balance;
        if (amount > bal) {
            amount = bal;
        }

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed(to, amount);
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
