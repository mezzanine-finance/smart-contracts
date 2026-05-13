// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";
import "./interfaces/IVault.sol";
import "./interfaces/IAllowlist.sol";

/// @title MZUSD stablecoin
/// @notice 1 USDC (6 decimals) = 1 MZUSD (18 decimals). Withdrawals are quantized to full USDC units,
///         subject to a configurable withdrawal fee (bps), and gated by a sliding-window redemption cap.
/// @notice Atomic netting: same-tx withdrawals bypass the redemption cap for amounts deposited earlier in the tx.
/// @notice Deposit and withdrawal access is gated by Allowlist (KYC + Chainalysis sanctions check).
/// @dev Burn authorization is delegated to AccessManager (BURNER_ROLE), usually granted to tranche contracts.
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
    /// @notice Basis points denominator used across fee math.
    /// @dev Examples: 10_000 = 100%, 500 = 5%, 50 = 0.5%, 5 = 0.05%.
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_WITHDRAWAL_FEE_BPS = 1_000;
    /// @notice Decimal conversion scale between USDC (6d) and MZUSD (18d): 1 USDC = 1e12 MZUSD units.
    uint256 private constant SCALE = 10 ** (MZ_DECIMALS - USDC_DECIMALS);
    uint32 public constant MIN_REDEMPTION_WINDOW_DURATION = 1 hours;
    uint32 public constant MAX_REDEMPTION_WINDOW_DURATION = 30 days;

    IVault public vault;
    /// @notice Start timestamp of current redemption window.
    uint48 public windowStartTimestamp;
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
    /// @notice Redemption fee charged on withdrawal in bps; fee stays in IssuanceVault.
    /// @dev Examples: 10_000 = 100%, 500 = 5%, 50 = 0.5%, 5 = 0.05%.
    uint16 public withdrawalFeeBps;

    /// @notice Address of allowlist for accounts validation.
    IAllowlist public allowlist;

    /// @notice Next global redemption cap (USDC, 6 decimals) to apply when the window rolls.
    uint256 public nextGlobalRedemptionCapUSDC;

    event Deposit(address indexed user, uint256 usdcAmount);
    event Withdrawal(address indexed user, uint256 usdcOut);
    event WithdrawalFeeUpdated(uint256 newFeeBps);
    event GlobalRedemptionCapQueued(uint256 newCapUSDC);
    event GlobalRedemptionCapUpdated(uint256 newCapUSDC);
    event RedemptionWindowDurationQueued(uint32 newDuration);
    event RedemptionWindowDurationUpdated(uint32 newDuration);
    event VaultUpdated(address indexed vault);
    event AllowlistUpdated(address indexed allowlist);

    error ZeroAmount();
    error ZeroAddress();
    error ZeroCap();
    error SameValue();
    error VaultAlreadySet();
    error VaultNotSet();
    error NotVault();
    error InvalidRedemptionWindowDuration();
    error TooBigBps();
    error TooSmallWithdrawalAmount(uint256 requestedMZ, uint256 usdcOut);
    error GlobalRedemptionCapExceeded(uint256 capUSDC, uint256 newTotal, uint256 attemptedUSDC);
    error InvalidUSDCDecimals(uint8 actualDecimals);
    error AccountNotAllowed(address account);

    /// @notice Disable initializer on implementation contract and set immutable USDC token reference.
    /// @param _usdc USDC token address; must be non-zero and expose 6 decimals.
    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();

        // aderyn-fp-next-line(reentrancy-state-change)
        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals != USDC_DECIMALS) revert InvalidUSDCDecimals(usdcDecimals);

        usdc = IERC20(_usdc);
        _disableInitializers();
    }

    modifier onlyVault() {
        if (msg.sender != address(vault)) revert NotVault();
        _;
    }

    /// @notice Validates if an account is allowed in the Allowlist.
    modifier allowed(address account) {
        require(allowlist.verifyAccount(account), AccountNotAllowed(account));
        _;
    }

    /// @notice Initialize the MZUSD token.
    /// @param accessManager AccessManager address.
    /// @param pauseManager_ PauseManager address for category-based pauses.
    /// @param allowlist_ Allowlist contract address for KYC/sanctions gating on deposits and withdrawals.
    /// @param _initialCapUSDC Initial global redemption cap in USDC (6 decimals); must be > 0.
    function initialize(
        address accessManager,
        address pauseManager_,
        address allowlist_,
        uint256 _initialCapUSDC
    ) external initializer {
        if (accessManager == address(0) || allowlist_ == address(0)) {
            revert ZeroAddress();
        }

        __ERC20_init("MZUSD Token", "MZUSD");
        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);

        _setGlobalRedemptionCap(_initialCapUSDC);
        windowStartTimestamp = uint48(block.timestamp);
        redemptionWindowDuration = 1 hours;
        allowlist = IAllowlist(allowlist_);
    }

    /// @notice Deposit USDC and mint MZUSD at fixed 1:1 notional value.
    /// @param amountUSDC USDC amount in 6 decimals.
    /// @dev Minted amount is amountUSDC * SCALE, so conversion is exact (no rounding loss on deposit).
    /// @dev Example: deposit 15_000_000 (15 USDC in 6d) -> mint 15_000_000_000_000_000_000 (15 MZUSD in 18d).
    /// @dev USDC is transferred directly to the IssuanceVault, MZUSD is minted to the depositor.
    /// @dev Only allowed accounts can deposit.
    function deposit(
        uint256 amountUSDC
    ) external whenNotPaused(PauseCategory.DEPOSITS) allowed(msg.sender) {
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
    /// @dev Withdrawal is quantized to full USDC units: usdcOut = floor(amountMZ / SCALE).
    /// @dev Only burnAmount = usdcOut * SCALE is burned, any sub-SCALE remainder stays on user balance.
    /// @dev Example: if amountMZ = SCALE + 123, then usdcOut = 1, burnAmount = SCALE, and 123 MZUSD-wei remain.
    /// @dev If amountMZ < SCALE, tx reverts with `TooSmallWithdrawalAmount`.
    /// @dev Only allowed accounts can withdraw.
    function requestWithdrawal(
        uint256 amountMZ
    ) external whenNotPaused(PauseCategory.WITHDRAWALS) allowed(msg.sender) {
        uint256 usdcOutGross = amountMZ / SCALE;
        if (usdcOutGross == 0) revert TooSmallWithdrawalAmount(amountMZ, usdcOutGross);
        uint256 burnAmount = usdcOutGross * SCALE;

        uint256 effectiveForLimit = _applyAtomicNetting(usdcOutGross);
        if (effectiveForLimit != 0) {
            _checkAndConsumeGlobalCap(effectiveForLimit);
        }

        _burn(msg.sender, burnAmount);

        if (address(vault) == address(0)) revert VaultNotSet();
        uint256 usdcOutNet = usdcOutGross;
        if (withdrawalFeeBps != 0) {
            uint256 feeUSDC = (usdcOutGross * withdrawalFeeBps + BPS - 1) / BPS;
            usdcOutNet -= feeUSDC;
        }
        if (usdcOutNet != 0) {
            vault.withdraw(msg.sender, usdcOutNet);
        }

        emit Withdrawal(msg.sender, usdcOutNet);
    }

    /// @notice Transfer MZUSD; paused when TRANSFERS category is active.
    /// @param to Recipient address.
    /// @param value Amount of MZUSD (18 decimals).
    /// @return success True on success.
    function transfer(
        address to,
        uint256 value
    ) public override whenNotPaused(PauseCategory.TRANSFERS) returns (bool success) {
        return super.transfer(to, value);
    }

    /// @notice Approve spender; paused when TRANSFERS category is active.
    /// @param spender Address to approve.
    /// @param value Allowance amount of MZUSD (18 decimals).
    /// @return success True on success.
    function approve(
        address spender,
        uint256 value
    ) public override whenNotPaused(PauseCategory.TRANSFERS) returns (bool success) {
        return super.approve(spender, value);
    }

    /// @notice Transfer MZUSD on behalf of `from`; paused when TRANSFERS category is active.
    /// @param from Source address.
    /// @param to Recipient address.
    /// @param value Amount of MZUSD (18 decimals).
    /// @return success True on success.
    function transferFrom(
        address from,
        address to,
        uint256 value
    ) public override whenNotPaused(PauseCategory.TRANSFERS) returns (bool success) {
        return super.transferFrom(from, to, value);
    }

    //MINT/BURN for authorized contracts (fees, yield distribution, burn losses)

    /// @notice Mint MZUSD to an address.
    /// @param to Recipient address.
    /// @param amount Amount of MZUSD to mint (18 decimals).
    /// @dev Used by VAULT to mint MZUSD.
    function mint(
        address to,
        uint256 amount
    ) external onlyVault whenNotPaused(PauseCategory.PROTOCOL) {
        _mint(to, amount);
    }

    /// @notice Burn MZUSD from caller balance.
    /// @param amount Amount of MZUSD to burn (18 decimals).
    /// @dev AccessManager should grant burn permission only to approved tranche contracts.
    function burn(uint256 amount) external restricted whenNotPaused(PauseCategory.PROTOCOL) {
        _burn(msg.sender, amount);
    }

    //SETTERS

    /// @notice Queue a new global redemption cap in USDC (6 decimals).
    /// @param newCapUSDC New cap value; must be > 0.
    /// @dev The new cap takes effect on the next window rollover.
    function setGlobalRedemptionCap(
        uint256 newCapUSDC
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (newCapUSDC == 0) revert ZeroCap();

        uint256 pending = nextGlobalRedemptionCapUSDC;
        if (pending == 0) {
            pending = globalRedemptionCapUSDC;
        }
        if (pending == newCapUSDC) revert SameValue();

        nextGlobalRedemptionCapUSDC = newCapUSDC;
        emit GlobalRedemptionCapQueued(newCapUSDC);
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

    /// @notice Set withdrawal fee in bps (charged on USDC output).
    /// @param newFeeBps New fee rate in bps, capped at MAX_WITHDRAWAL_FEE_BPS (10%).
    function setWithdrawalFeeBps(
        uint16 newFeeBps
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (newFeeBps > MAX_WITHDRAWAL_FEE_BPS) revert TooBigBps();
        if (withdrawalFeeBps == newFeeBps) revert SameValue();
        withdrawalFeeBps = newFeeBps;
        emit WithdrawalFeeUpdated(newFeeBps);
    }

    /// @notice Set IssuanceVault address (one-time).
    /// @param _vault IssuanceVault proxy address; must be non-zero.
    /// @dev IssuanceVault is immutable at the application level: once set, it cannot be changed.
    function setVault(address _vault) external restricted {
        if (_vault == address(0)) revert ZeroAddress();
        if (address(vault) != address(0)) revert VaultAlreadySet();
        vault = IVault(_vault);
        emit VaultUpdated(_vault);
    }

    /// @notice Set Allowlist contract for deposit/withdrawal gating.
    /// @param _allowlist New Allowlist proxy address; must be non-zero.
    function setAllowlist(address _allowlist) external restricted {
        if (_allowlist == address(0)) revert ZeroAddress();
        if (address(allowlist) == _allowlist) revert SameValue();
        allowlist = IAllowlist(_allowlist);
        emit AllowlistUpdated(_allowlist);
    }

    //GETTERS

    /// @notice View redemption cap usage for the current (or next) window.
    /// @return capUSDC Global redemption cap in USDC (6 decimals).
    /// @return usedUSDC USDC redeemed so far in the current window (0 if window has expired).
    /// @return remainingUSDC USDC still available for redemption in the current window.
    function getRemainingRedemptionCap()
        public
        view
        returns (uint256 capUSDC, uint256 usedUSDC, uint256 remainingUSDC)
    {
        capUSDC = globalRedemptionCapUSDC;
        if (_isWindowExpired()) {
            // Next withdrawal resets the window — full cap available
            uint256 pendingCap = nextGlobalRedemptionCapUSDC;
            if (pendingCap != 0) capUSDC = pendingCap;
            return (capUSDC, 0, capUSDC);
        }
        usedUSDC = windowUsedUSDC;
        remainingUSDC = usedUSDC >= capUSDC ? 0 : capUSDC - usedUSDC;
    }

    /// @notice View the current redemption window timing.
    /// @return windowStart Start timestamp of the current (or projected) window.
    /// @return windowEnd End timestamp of the current (or projected) window.
    /// @return duration Window duration in seconds (may reflect a queued duration if window expired).
    function getRedemptionWindow()
        external
        view
        returns (uint48 windowStart, uint48 windowEnd, uint32 duration)
    {
        duration = redemptionWindowDuration;
        if (_isWindowExpired()) {
            // Next withdrawal would reset — show projected window
            uint32 pending = nextRedemptionWindowDuration;
            if (pending != 0) duration = pending;
            windowStart = uint48(block.timestamp);
        } else {
            windowStart = windowStartTimestamp;
        }
        windowEnd = windowStart + duration;
    }

    /// @notice Returns token decimals (18).
    /// @return MZUSD decimal precision.
    function decimals() public pure override returns (uint8) {
        return MZ_DECIMALS;
    }

    ///INTERNAL HELPERS

    /// @notice Whether the current redemption window has expired
    function _isWindowExpired() private view returns (bool) {
        return block.timestamp >= uint256(windowStartTimestamp) + redemptionWindowDuration;
    }

    /// @notice Apply atomic netting of deposits against withdrawals within the same tx.
    /// @param usdcOut USDC amount to withdraw (6 decimals).
    /// @return adjustedUSDC USDC amount to withdraw after netting.
    function _applyAtomicNetting(uint256 usdcOut) internal returns (uint256 adjustedUSDC) {
        uint256 txDeposited = _txDepositedUSDC;
        uint256 coveredUSDC = txDeposited < usdcOut ? txDeposited : usdcOut;
        _txDepositedUSDC = txDeposited - coveredUSDC;
        // Return the portion that actually counts against the global redemption cap
        adjustedUSDC = usdcOut - coveredUSDC;
    }

    /// @notice Consume from the global redemption cap for the current window.
    /// @dev Rolls the window forward and applies a queued duration if needed.
    function _checkAndConsumeGlobalCap(uint256 usdcAmount) internal {
        uint32 duration = redemptionWindowDuration;

        if (block.timestamp >= uint256(windowStartTimestamp) + duration) {
            windowStartTimestamp = uint48(block.timestamp);
            windowUsedUSDC = 0;

            uint32 pendingDuration = nextRedemptionWindowDuration;
            if (pendingDuration != 0) {
                redemptionWindowDuration = pendingDuration;
                nextRedemptionWindowDuration = 0;
                emit RedemptionWindowDurationUpdated(pendingDuration);
            }

            uint256 pendingCap = nextGlobalRedemptionCapUSDC;
            if (pendingCap != 0) {
                globalRedemptionCapUSDC = pendingCap;
                nextGlobalRedemptionCapUSDC = 0;
                emit GlobalRedemptionCapUpdated(pendingCap);
            }
        }

        uint256 cap = globalRedemptionCapUSDC;
        uint256 newTotal = windowUsedUSDC + usdcAmount;
        if (newTotal > cap) revert GlobalRedemptionCapExceeded(cap, newTotal, usdcAmount);

        windowUsedUSDC = newTotal;
    }

    /// @notice Set the global redemption cap in USDC (6 decimals).
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
