// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";
import "./interfaces/IVault.sol";

/// @title MZUSD stablecoin
/// @notice 1 USDC (6 decimals) = 1 MZUSD (18 decimals).
/// @notice Supports atomic netting of deposits vs withdrawals within the same tx.
/// @notice Supports a global redemption cap in USDC (6 decimals), enforced per window.
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract MZUSD is
    ERC20Upgradeable,
    UUPSUpgradeable,
    AccessManagedUpgradeable,
    PauseManagedUpgradeable
{
    IERC20 public immutable usdc;

    uint8 public constant USDC_DECIMALS = 6;
    uint8 public constant MZ_DECIMALS = 18;
    uint256 private constant SCALE = 10 ** (MZ_DECIMALS - USDC_DECIMALS);
    uint32 public constant MIN_REDEMPTION_WINDOW_DURATION = 1 hours;
    uint32 public constant MAX_REDEMPTION_WINDOW_DURATION = 30 days;

    IVault public immutable vault;
    address public lossManager;
    /// @notice Start timestamp of current redemption window.
    uint40 public windowStartTimestamp;
    /// @notice Duration of redemption window in seconds (e.g. 1 hours).
    uint32 public redemptionWindowDuration;
    /// @notice Global redemption cap in USDC (6 decimals); must be > 0.
    uint256 public globalRedemptionCapUSDC;
    /// @notice USDC redeemed in current window.
    uint256 public windowUsedUSDC;

    /// @notice Tracks USDC deposited in current tx; enables atomic netting so same-tx withdrawals bypass redemption cap for deposited amounts.
    uint256 transient _txDepositedUSDC;
    /// @notice Next redemption window duration to apply when the window rolls.
    uint32 public nextRedemptionWindowDuration;

    event Deposit(address indexed user, uint256 usdcAmount);
    event Withdrawal(address indexed user, uint256 usdcOut);
    event GlobalRedemptionCapUpdated(uint256 newCapUSDC);
    event RedemptionWindowDurationQueued(uint32 newDuration);
    event RedemptionWindowDurationUpdated(uint32 newDuration);
    event LossManagerUpdated(address indexed lossManager);

    error ZeroAmount();
    error ZeroAddress();
    error ZeroCap();
    error ZeroDuration();
    error SameValue();
    error LossManagerAlreadySet();
    error NotVault();
    error NotLossManager();
    error InvalidRedemptionWindowDuration();
    error CapExceedsTotalSupply(uint256 capUSDC, uint256 totalSupplyUSDC);
    error TooSmallWithdrawalAmount(uint256 requestedMZ, uint256 usdcOut);
    error GlobalRedemptionCapExceeded(uint256 capUSDC, uint256 newTotal, uint256 attemptedUSDC);
    error InvalidUSDCDecimals(uint8 actualDecimals);

    constructor(address _usdc, address _vault) {
        if (_usdc == address(0) || _vault == address(0)) revert ZeroAddress();

        // aderyn-fp-next-line(reentrancy-state-change)
        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals != USDC_DECIMALS) revert InvalidUSDCDecimals(usdcDecimals);

        usdc = IERC20(_usdc);
        vault = IVault(_vault);
        _disableInitializers();
    }

    modifier onlyVault() {
        if (msg.sender != address(vault)) revert NotVault();
        _;
    }

    modifier onlyLossManager() {
        if (msg.sender != lossManager) revert NotLossManager();
        _;
    }

    /// @param accessManager AccessManager address.
    /// @param pauseManager_ PauseManager address for category-based pauses.
    /// @param _initialCapUSDC Initial global redemption cap in USDC (6 decimals).
    function initialize(
        address accessManager,
        address pauseManager_,
        uint256 _initialCapUSDC
    ) external initializer {
        if (accessManager == address(0)) {
            revert ZeroAddress();
        }

        __ERC20_init("MZUSD Token", "MZUSD");
        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);

        _setGlobalRedemptionCap(_initialCapUSDC);
        windowStartTimestamp = uint40(block.timestamp);
        redemptionWindowDuration = 1 hours;
        nextRedemptionWindowDuration = redemptionWindowDuration;
    }

    /// @notice Deposit USDC and mint MZUSD 1:1.
    /// @param amountUSDC USDC amount (6 decimals).
    function deposit(uint256 amountUSDC) external whenNotPaused(PauseCategory.DEPOSITS) {
        if (amountUSDC == 0) revert ZeroAmount();

        // Accumulate deposit for atomic netting; if user withdraws later in this tx, this amount won't count against redemption cap
        _txDepositedUSDC += amountUSDC;

        // USDC is a well-behaved ERC20; direct transferFrom is safe here.
        usdc.transferFrom(msg.sender, address(vault), amountUSDC);

        uint256 mintAmount = amountUSDC * SCALE;
        _mint(msg.sender, mintAmount);

        emit Deposit(msg.sender, amountUSDC);
    }

    /// @notice Burn MZUSD and withdraw USDC.
    /// @param amountMZ MZUSD amount to burn (18 decimals).
    /// @dev v1: executes instantly if vault has liquidity (or can pull from Reservoir)
    /// @dev v2: might be changed to enqueue
    /// @dev Applies atomic netting of deposits vs withdrawals within the same tx
    /// @dev Enforces global redemption cap per window
    function requestWithdrawal(uint256 amountMZ) external whenNotPaused(PauseCategory.WITHDRAWALS) {
        uint256 usdcOut = amountMZ / SCALE;
        if (usdcOut == 0) revert TooSmallWithdrawalAmount(amountMZ, usdcOut);
        uint256 burnAmount = usdcOut * SCALE;

        uint256 effectiveForLimit = _applyAtomicNetting(usdcOut);
        if (effectiveForLimit != 0) {
            _checkAndConsumeGlobalCap(effectiveForLimit);
        }

        _burn(msg.sender, burnAmount);

        vault.withdraw(msg.sender, usdcOut);

        emit Withdrawal(msg.sender, usdcOut);
    }

    function transfer(
        address to,
        uint256 value
    ) public override whenNotPaused(PauseCategory.TRANSFERS) returns (bool success) {
        return super.transfer(to, value);
    }

    function approve(
        address spender,
        uint256 value
    ) public override whenNotPaused(PauseCategory.TRANSFERS) returns (bool success) {
        return super.approve(spender, value);
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) public override whenNotPaused(PauseCategory.TRANSFERS) returns (bool success) {
        return super.transferFrom(from, to, value);
    }

    //MINT/BURN for authorized contracts (fees, yield distribution, burn losses)

    /// @notice Mint MZUSD to an address.
    /// @dev Used by VAULT to mint MZUSD
    function mint(
        address to,
        uint256 amount
    ) external onlyVault whenNotPaused(PauseCategory.PROTOCOL) {
        _mint(to, amount);
    }

    /// @notice Burn MZUSD from an address.
    /// @dev Used by LossManager to burn MZUSD.
    function burn(
        address from,
        uint256 amount
    ) external onlyLossManager whenNotPaused(PauseCategory.PROTOCOL) {
        _burn(from, amount);
    }

    //SETTERS

    /// @notice Set global redemption cap in USDC (6 decimals).
    /// @param newCapUSDC New cap value; must be > 0 and <= USDC total supply.
    function setGlobalRedemptionCap(
        uint256 newCapUSDC
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (globalRedemptionCapUSDC == newCapUSDC) revert SameValue();
        _setGlobalRedemptionCap(newCapUSDC);
    }

    /// @notice Set the duration of the redemption window (how long a window lasts).
    /// @param newDuration New duration in seconds.
    /// @dev Validations: non-zero, within min/max bounds, different from current or pending value.
    function setRedemptionWindowDuration(
        uint32 newDuration
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (
            newDuration < MIN_REDEMPTION_WINDOW_DURATION ||
            newDuration > MAX_REDEMPTION_WINDOW_DURATION
        ) {
            revert InvalidRedemptionWindowDuration();
        }

        uint32 pending = nextRedemptionWindowDuration;
        if (pending == 0) {
            pending = redemptionWindowDuration;
        }
        if (pending == newDuration) revert SameValue();

        nextRedemptionWindowDuration = newDuration;
        emit RedemptionWindowDurationQueued(newDuration);
    }

    /// @notice Set LossManager address (one-time).
    function setLossManager(address _lossManager) external restricted {
        if (_lossManager == address(0)) revert ZeroAddress();
        if (lossManager != address(0)) revert LossManagerAlreadySet();
        lossManager = _lossManager;
        emit LossManagerUpdated(_lossManager);
    }

    //GETTERS

    /// @notice View remaining USDC available for redemption in the current window.
    /// @return remainingUSDC USDC left redeemable in the current window.
    /// @return windowStart Start timestamp of the current redemption window.
    function getRemainingGlobalRedemptionCap()
        public
        view
        returns (uint256 remainingUSDC, uint40 windowStart)
    {
        uint256 cap = globalRedemptionCapUSDC;

        if (block.timestamp >= uint256(windowStartTimestamp) + redemptionWindowDuration) {
            // New window would start on next withdrawal; expose full cap and current timestamp.
            return (cap, uint40(block.timestamp));
        }

        uint256 spent = windowUsedUSDC;
        remainingUSDC = cap - _min(spent, cap);
        return (remainingUSDC, windowStartTimestamp);
    }

    /// @notice Returns the current redemption window state derived from cap and timing.
    /// @return capUSDC Global redemption cap in USDC (6 decimals).
    /// @return usedUSDC USDC redeemed in the current window.
    /// @return remainingUSDC USDC still redeemable in the current window.
    /// @return windowStart Start timestamp of the current window.
    /// @return windowEnd End timestamp of the current window.
    function getRedemptionWindow()
        external
        view
        returns (
            uint256 capUSDC,
            uint256 usedUSDC,
            uint256 remainingUSDC,
            uint40 windowStart,
            uint40 windowEnd
        )
    {
        capUSDC = globalRedemptionCapUSDC;
        (remainingUSDC, windowStart) = getRemainingGlobalRedemptionCap();
        usedUSDC = capUSDC - remainingUSDC;

        uint32 duration = redemptionWindowDuration;
        if (block.timestamp >= uint256(windowStartTimestamp) + duration) {
            uint32 pending = nextRedemptionWindowDuration;
            if (pending != 0) {
                duration = pending;
            }
        }
        if (duration == 0) {
            windowEnd = windowStart;
        } else {
            windowEnd = windowStart + duration;
        }
    }

    function decimals() public pure override returns (uint8) {
        return MZ_DECIMALS;
    }

    ///INTERNAL HELPERS

    function _min(uint256 a, uint256 b) internal pure returns (uint256 minValue) {
        minValue = a < b ? a : b;
    }

    /// @notice Apply atomic netting of deposits against withdrawals within the same tx.
    /// @param usdcOut USDC amount to withdraw (6 decimals).
    /// @return adjustedUSDC USDC amount to withdraw after netting.
    function _applyAtomicNetting(uint256 usdcOut) internal returns (uint256 adjustedUSDC) {
        // Read tx-local deposit accumulator to offset withdrawal against redemption cap
        uint256 txDeposited = _txDepositedUSDC;
        // Calculate how much of this withdrawal is covered by same-tx deposits (up to full withdrawal)
        uint256 coveredUSDC = _min(txDeposited, usdcOut);
        // Decrease available deposit balance by consumed amount; remainder stays for potential subsequent withdrawals
        _txDepositedUSDC = txDeposited - coveredUSDC;
        // Return the portion that actually counts against the global redemption cap
        adjustedUSDC = usdcOut - coveredUSDC;
    }

    /// @notice Consume from the global redemption cap for the current window.
    /// @dev Rolls the window forward and applies a queued duration if needed.
    function _checkAndConsumeGlobalCap(uint256 usdcAmount) internal {
        uint256 cap = globalRedemptionCapUSDC;
        uint32 duration = redemptionWindowDuration;

        if (block.timestamp >= uint256(windowStartTimestamp) + duration) {
            windowStartTimestamp = uint40(block.timestamp);
            windowUsedUSDC = 0;

            uint32 pending = nextRedemptionWindowDuration;
            if (pending != 0) {
                redemptionWindowDuration = pending;
                emit RedemptionWindowDurationUpdated(pending);
            }
        }

        uint256 newTotal = windowUsedUSDC + usdcAmount;
        if (newTotal > cap) revert GlobalRedemptionCapExceeded(cap, newTotal, usdcAmount);

        windowUsedUSDC = newTotal;
    }

    /// @notice Set the global redemption cap in USDC (6 decimals).
    function _setGlobalRedemptionCap(uint256 newCapUSDC) internal {
        if (newCapUSDC == 0) {
            revert ZeroCap();
        }

        uint256 totalSupplyUSDC = usdc.totalSupply();
        if (newCapUSDC > totalSupplyUSDC) {
            revert CapExceedsTotalSupply(newCapUSDC, totalSupplyUSDC);
        }

        globalRedemptionCapUSDC = newCapUSDC;
        emit GlobalRedemptionCapUpdated(newCapUSDC);
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
