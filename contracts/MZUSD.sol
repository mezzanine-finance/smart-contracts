// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";
import "./interfaces/IVault.sol";

/// @title MZUSD stablecoin
/// @notice 1 USDC (6 decimals) = 1 MZUSD (18 decimals)
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
    /// @notice start timestamp of current redemption window
    uint40 public windowStartTimestamp;
    /// @notice duration of redemption window in seconds (e.g. 1 hours)
    uint32 public redemptionWindowDuration;
    /// @notice global redemption cap in USDC (6 decimals); must be > 0
    uint256 public globalRedemptionCapUSDC;
    /// @notice amount of USDC redeemed in current window
    uint256 public windowUsedUSDC;

    /// @notice per-tx deposits for atomic netting
    uint256 transient _txDepositedUSDC;
    /// @notice next redemption window duration to apply when the window rolls
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

    /// @param accessManager - address of AccessManager contract for role management
    /// @param pauseManager_ - address of PauseManager contract for category-based pauses
    /// @param _initialCapUSDC - initial global redemption cap in USDC (6 decimals)
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

    /// @notice deposit USDC and mint MZUSD 1:1
    /// @param amountUSDC - amount of USDC to deposit (6 decimals)
    function deposit(uint256 amountUSDC) external whenNotPaused(PauseCategory.DEPOSITS) {
        if (amountUSDC == 0) revert ZeroAmount();

        _txDepositedUSDC += amountUSDC;

        // USDC is a well-behaved ERC20; direct transferFrom is safe here.
        usdc.transferFrom(msg.sender, address(vault), amountUSDC);

        uint256 mintAmount = amountUSDC * SCALE;
        _mint(msg.sender, mintAmount);

        emit Deposit(msg.sender, amountUSDC);
    }

    /// @notice request withdrawal of MZUSD for USDC
    /// @param amountMZ - amount of MZUSD to burn (18 decimals)
    /// @dev v1: executes instantly if vault has liquidity (or can pull from Reservoir)
    /// @dev v2: will be changed to enqueue
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

    /// @notice mint MZUSD to an address
    /// @dev Used by VAULT to mint MZUSD
    function mint(
        address to,
        uint256 amount
    ) external onlyVault whenNotPaused(PauseCategory.PROTOCOL) {
        _mint(to, amount);
    }

    /// @notice burn MZUSD from an address
    /// @dev Used by authorized contracts to burn MZUSD
    function burn(
        address from,
        uint256 amount
    ) external onlyLossManager whenNotPaused(PauseCategory.PROTOCOL) {
        _burn(from, amount);
    }

    //SETTERS

    /// @notice set global redemption cap in USDC (6 decimals)
    /// @param newCapUSDC - new cap value; must be > 0 and <= USDC total supply
    function setGlobalRedemptionCap(
        uint256 newCapUSDC
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (globalRedemptionCapUSDC == newCapUSDC) revert SameValue();
        _setGlobalRedemptionCap(newCapUSDC);
    }

    /// @notice set the duration of the redemption window
    /// @param newDuration - new duration in seconds
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

    /// @notice View redemption cap usage for the current (or next) window
    function getRemainingRedemptionCap()
        public
        view
        returns (uint256 capUSDC, uint256 usedUSDC, uint256 remainingUSDC)
    {
        capUSDC = globalRedemptionCapUSDC;
        if (_isWindowExpired()) {
            // Next withdrawal resets the window — full cap available
            return (capUSDC, 0, capUSDC);
        }
        usedUSDC = windowUsedUSDC;
        remainingUSDC = usedUSDC >= capUSDC ? 0 : capUSDC - usedUSDC;
    }

    /// @notice View the current redemption window timing
    function getRedemptionWindow()
        external
        view
        returns (uint40 windowStart, uint40 windowEnd, uint32 duration)
    {
        duration = redemptionWindowDuration;
        if (_isWindowExpired()) {
            // Next withdrawal would reset — show projected window
            uint32 pending = nextRedemptionWindowDuration;
            if (pending != 0) duration = pending;
            windowStart = uint40(block.timestamp);
        } else {
            windowStart = windowStartTimestamp;
        }
        windowEnd = windowStart + duration;
    }

    function decimals() public pure override returns (uint8 decimals_) {
        decimals_ = MZ_DECIMALS;
    }

    ///INTERNAL HELPERS

    /// @notice Whether the current redemption window has expired
    function _isWindowExpired() private view returns (bool) {
        return block.timestamp >= uint256(windowStartTimestamp) + redemptionWindowDuration;
    }

    /// @notice apply atomic netting of deposits against withdrawals within the same tx
    /// @param usdcOut - initial USDC amount to withdraw
    /// @return adjustedUSDC adjusted USDC amount to withdraw after netting
    function _applyAtomicNetting(uint256 usdcOut) internal returns (uint256 adjustedUSDC) {
        uint256 txDeposited = _txDepositedUSDC;
        uint256 coveredUSDC = txDeposited < usdcOut ? txDeposited : usdcOut;
        _txDepositedUSDC = txDeposited - coveredUSDC;
        adjustedUSDC = usdcOut - coveredUSDC;
    }

    /// @notice check and consume from the global redemption cap
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

    function _setGlobalRedemptionCap(uint256 newCapUSDC) internal {
        if (newCapUSDC == 0) {
            revert ZeroCap();
        }

        // Cap can be any non-zero value; admin is trusted to set a sensible limit
        globalRedemptionCapUSDC = newCapUSDC;
        emit GlobalRedemptionCapUpdated(newCapUSDC);
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
