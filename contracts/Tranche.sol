// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/manager/AccessManaged.sol";

/* ---------- Escrow interface ---------- */
interface IPendingWithdrawal {
    function record(address user, uint256 amountMZ, uint256 unlockAt) external;

    function claimFor(address user) external;

    function getClaim(
        address user
    ) external view returns (uint256 owed, uint256 unlockAt);
}
//todo deposit limit not per transaction but per all (global)
/// @title Tranche (ERC4626) 
/// @notice Instant redeem to user for Senior tranche. Delayed redeem to escrow and fix amount at request time.
contract Tranche is ERC4626, AccessManaged, ReentrancyGuard, Pausable {
    uint256 public constant BASIS_POINTS = 10_000;

    // external refs
    address public immutable vault;
    IPendingWithdrawal public immutable pendingWithdrawal;
    uint256 public immutable trancheId;

    // params
    uint256 public unlockPeriod; // seconds; 0 = instant

    // deposit limits
    bool public depositLimitEnabled;
    uint256 public maxDepositCap; // absolute per-tx cap in asset units
    uint16 public maxDepositTvlBps; // per-tx cap as % of TVL (bps)

    // events
    event UnlockPeriodUpdated(uint256 newPeriod);
    event DepositLimitUpdated(bool enabled, uint256 cap, uint16 tvlBps);
    event WithdrawalRequested(
        address indexed user,
        uint256 shares,
        uint256 assetsFixed,
        uint256 unlocksAt
    );
    event WithdrawalExecuted(
        address indexed user,
        uint256 shares,
        uint256 assets
    );

    // errors
    error InvalidAmount();
    error DepositLimitExceeded(uint256 attempted, uint256 limit);

    constructor(
        IERC20 _asset, // mzUSD (18d)
        address _vault,
        IPendingWithdrawal _pendingWithdrawal,
        uint256 _trancheId,
        uint256 _unlockPeriod,
        string memory _name,
        string memory _symbol,
        address accessManager
    ) ERC20(_name, _symbol) ERC4626(_asset) AccessManaged(accessManager) {
        if (_vault == address(0) || address(_pendingWithdrawal) == address(0))
            revert InvalidAmount();
        vault = _vault;
        pendingWithdrawal = _pendingWithdrawal;
        trancheId = _trancheId;
        unlockPeriod = _unlockPeriod;
    }

    /* ---------- pause ---------- */
    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
        _unpause();
    }

    /* ---------- deposit with limits ---------- */
    function deposit(
        uint256 assets,
        address receiver
    ) public override whenNotPaused nonReentrant returns (uint256 shares) {
        _checkDepositLimit(assets);
        shares = super.deposit(assets, receiver);
    }

    /* ---------- withdrawals ---------- */
    function requestWithdrawal(
        uint256 shares
    ) external whenNotPaused nonReentrant {
        if (shares == 0 || balanceOf(msg.sender) < shares)
            revert InvalidAmount();

        if (unlockPeriod == 0) {
            // instant path
            uint256 assetsOut = redeem(shares, msg.sender, msg.sender);
            emit WithdrawalExecuted(msg.sender, shares, assetsOut);
            return;
        }

        // delayed path — fix amount now, send to escrow
        uint256 unlocksAt = block.timestamp + unlockPeriod;
        uint256 assetsFixed = redeem(
            shares,
            address(pendingWithdrawal),
            msg.sender
        );
        pendingWithdrawal.record(msg.sender, assetsFixed, unlocksAt);
        emit WithdrawalRequested(msg.sender, shares, assetsFixed, unlocksAt);
    }

    function executeWithdrawal() external nonReentrant whenNotPaused {
        pendingWithdrawal.claimFor(msg.sender);
    }

    function setUnlockPeriod(uint256 period) external restricted {
        unlockPeriod = period;
        emit UnlockPeriodUpdated(period);
    }

    function setDepositLimits(
        bool enabled,
        uint256 cap,
        uint16 tvlBps
    ) external restricted {
        require(tvlBps <= BASIS_POINTS, "tvlBps>100%");
        depositLimitEnabled = enabled;
        maxDepositCap = cap;
        maxDepositTvlBps = tvlBps;
        emit DepositLimitUpdated(enabled, cap, tvlBps);
    }

    function pricePerShare() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    function hasPendingWithdrawal(address user) external view returns (bool) {
        (uint256 owed, ) = pendingWithdrawal.getClaim(user);
        return owed != 0;
    }

    function getWithdrawalStatus(
        address user
    ) external view returns (uint256 assets, uint256 unlocksAt) {
        return pendingWithdrawal.getClaim(user);
    }

    function _checkDepositLimit(uint256 amount) internal view {
        if (!depositLimitEnabled) return;

        uint256 tvl = totalAssets();
        uint256 perTxLimitByTvl = tvl == 0
            ? type(uint256).max
            : (tvl * maxDepositTvlBps) / BASIS_POINTS;

        uint256 perTxLimit = perTxLimitByTvl;
        if (maxDepositCap != 0 && maxDepositCap < perTxLimit)
            perTxLimit = maxDepositCap;

        if (amount > perTxLimit)
            revert DepositLimitExceeded(amount, perTxLimit);
    }
}
