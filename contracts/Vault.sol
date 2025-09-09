// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/* ─────────────── External interfaces ─────────────── */

interface IMZUSD is IERC20 {
    function deposit(uint256 amount) external; // pulls USDC → mints MZUSD
}

interface IReservoir {
    function deposit(uint256 amount) external;

    function withdraw(uint256 amount, address to) external;
}

interface ITrancheLike {
    function totalAssets() external view returns (uint256);
}

interface IVaultPublic {
    function withdraw(address token, address to, uint256 amount) external;
}

/* ─────────────── Vault ─────────────── */
/*
 * Vault (UUPS, custom-errors version)
 * – Custodies USDC backing MZUSD & MEZZ
 * – Rebalances with SmallReservoirUSDC
 * – Serves MZUSD redemptions
 * – Distributes realised yield (USDC → MZUSD) straight to Tranche contracts
 */
contract Vault is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IVaultPublic
{
    using SafeERC20 for IERC20;

    /* ─────────────── Roles ─────────────── */
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant CURATOR_ROLE = keccak256("CURATOR_ROLE");
    bytes32 public constant MZUSD_ROLE = keccak256("MZUSD_ROLE");

    /* ─────────────── Core refs ─────────────── */
    IERC20 public usdc;
    IMZUSD public mzusd;
    IReservoir public reservoir;

    /* ─────────────── Buffer ─────────────── */
    /// @dev Target USDC balance to keep on hand for instant withdrawals.
    uint256 public idleBufferUSDC;
    /// @dev +/- range around target in basis points (1 bps = 0.01%).
    /// e.g., 500 => ±5% band around idleBufferUSDC.
    uint256 public hysteresisBps;

    /* ─────────────── Insurance ─────────────── */
    address public insurance;
    uint16 public insuranceBps;

    /* ─────────────── Tranches ─────────────── */
    struct TrancheInfo {
        address tranche;
        uint16 weightBps;
        bool enabled;
    }
    TrancheInfo[] public tranches;
    mapping(address => bool) public isTranche;

    event Rebalanced(uint256 sent, uint256 pulled, uint256 idleAfter);
    event YieldDistributed(uint256 usdcUsed, uint256 mintedMZUSD);
    event TrancheRegistered(address tranche, uint16 weightBps, bool enabled);
    event TrancheUpdated(uint256 idx, uint16 weightBps, bool enabled);
    event InsuranceUpdated(address insurance, uint16 bps);
    event BufferUpdated(uint256 buffer, uint256 hysteresisBps);
    event WithdrawnFromVault(address token, address to, uint256 amount);
    event MZUSDChanged(address newMZUSD);
    event ReservoirUpdated(address newReservoir);

    error NotMZUSD();
    error TokenNotUSDC();
    error ZeroAmount();
    error InsufficientUSDC();
    error NoTranchesAdded();
    error TVLZero();
    error WeightsZero();
    error TooBigBps();
    error TrancheExists();
    error TrancheIndexOOB();
    error ZeroAddress();

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _admin,
        address _usdc,
        address _mzusd,
        address _reservoir
    ) external initializer {
        if (
            _admin == address(0) ||
            _usdc == address(0) ||
            _mzusd == address(0) ||
            _reservoir == address(0)
        ) revert ZeroAddress();
        
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        usdc = IERC20(_usdc);
        mzusd = IMZUSD(_mzusd);
        reservoir = IReservoir(_reservoir);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);
        _grantRole(CURATOR_ROLE, _admin);

        idleBufferUSDC = 1_000_000 * 1e6; // 1M USDC
        hysteresisBps = 500; // ±5 %
    }

    /* ─────────────── MZUSD withdrawal handler ─────────────── */
    function withdraw(
        address token,
        address to,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (!hasRole(MZUSD_ROLE, msg.sender)) revert NotMZUSD();
        if (token != address(usdc)) revert TokenNotUSDC();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 idle = usdc.balanceOf(address(this));
        if (idle < amount) {
            reservoir.withdraw(amount - idle, address(this));
        }
        usdc.safeTransfer(to, amount);
        emit WithdrawnFromVault(token, to, amount);
    }

    /* ─────────────── Buffer rebalance ─────────────── */
    function rebalance() external whenNotPaused {
        uint256 idle = usdc.balanceOf(address(this));
        uint256 low = (idleBufferUSDC * (10_000 - hysteresisBps)) / 10_000;
        uint256 high = (idleBufferUSDC * (10_000 + hysteresisBps)) / 10_000;

        uint256 sent;
        uint256 pulled;
        if (idle > high) {
            uint256 toSend = idle - idleBufferUSDC;
            _approveIfNeeded(usdc, address(reservoir), toSend);
            reservoir.deposit(toSend);
            sent = toSend;
        } else if (idle < low) {
            uint256 toPull = idleBufferUSDC - idle;
            reservoir.withdraw(toPull, address(this));
            pulled = toPull;
        }
        emit Rebalanced(sent, pulled, usdc.balanceOf(address(this)));
    }

    /* ─────────────── Yield distribution ─────────────── */
    function distributeYield(
        uint256 usdcAmount,
        bool byTVL
    ) external whenNotPaused nonReentrant onlyRole(CURATOR_ROLE) {
        if (usdcAmount == 0) revert ZeroAmount();
        if (usdc.balanceOf(address(this)) < usdcAmount)
            revert InsufficientUSDC();
        if (tranches.length == 0) revert NoTranchesAdded();

        /* 1. convert USDC → MZUSD (mint to Vault) */
        _approveIfNeeded(usdc, address(mzusd), usdcAmount);
        mzusd.deposit(usdcAmount);
        uint256 minted = usdcAmount;

        /* 2. insurance cut */
        if (insurance != address(0) && insuranceBps > 0) {
            uint256 cut = (minted * insuranceBps) / 10_000;
            IERC20(address(mzusd)).safeTransfer(insurance, cut);
            minted -= cut;
        }

        /* 3. compute shares */
        uint256 n = tranches.length;
        uint256 totalBase;
        uint256[] memory part = new uint256[](n);

        if (byTVL) {
            for (uint256 i; i < n; ++i)
                if (tranches[i].enabled)
                    totalBase += ITrancheLike(tranches[i].tranche)
                        .totalAssets();
            if (totalBase == 0) revert TVLZero();

            for (uint256 i; i < n; ++i)
                if (tranches[i].enabled) {
                    uint256 tvl = ITrancheLike(tranches[i].tranche)
                        .totalAssets();
                    part[i] = (minted * tvl) / totalBase;
                }
        } else {
            for (uint256 i; i < n; ++i)
                if (tranches[i].enabled) totalBase += tranches[i].weightBps;
            if (totalBase == 0) revert WeightsZero();

            for (uint256 i; i < n; ++i)
                if (tranches[i].enabled)
                    part[i] = (minted * tranches[i].weightBps) / totalBase;
        }

        /* 4. transfer MZUSD to tranches */
        uint256 distributed;
        for (uint256 i; i < n; ++i) {
            uint256 p = part[i];
            if (p == 0) continue;
            IERC20(address(mzusd)).safeTransfer(tranches[i].tranche, p);
            distributed += p;
        }
        /* rounding dust */
        if (minted > distributed) {
            address sink = insurance != address(0)
                ? insurance
                : _firstEnabledTranche();
            IERC20(address(mzusd)).safeTransfer(sink, minted - distributed);
        }

        emit YieldDistributed(usdcAmount, usdcAmount);
    }

    /* ─────────────── Admin ─────────────── */
    function setReservoir(address _reservoir) external onlyRole(ADMIN_ROLE) {
        reservoir = IReservoir(_reservoir);
        emit ReservoirUpdated(_reservoir);
    }

    function setMZUSD(address _mzusd) external onlyRole(ADMIN_ROLE) {
        mzusd = IMZUSD(_mzusd);
        emit MZUSDChanged(_mzusd);
    }

    function addTranche(
        address tranche,
        uint16 weightBps,
        bool enabled
    ) external onlyRole(ADMIN_ROLE) {
        if (tranche == address(0)) revert ZeroAddress();
        if (isTranche[tranche]) revert TrancheExists();
        tranches.push(TrancheInfo(tranche, weightBps, enabled));
        isTranche[tranche] = true;
        emit TrancheRegistered(tranche, weightBps, enabled);
    }

    function updateTranche(
        uint256 idx,
        uint16 weightBps,
        bool enabled
    ) external onlyRole(ADMIN_ROLE) {
        if (idx >= tranches.length) revert TrancheIndexOOB();
        tranches[idx].weightBps = weightBps;
        tranches[idx].enabled = enabled;
        emit TrancheUpdated(idx, weightBps, enabled);
    }

    function setInsurance(
        address _insurance,
        uint16 bps
    ) external onlyRole(ADMIN_ROLE) {
        if (bps > 10_000) revert TooBigBps();
        insurance = _insurance;
        insuranceBps = bps;
        emit InsuranceUpdated(_insurance, bps);
    }

    function setBuffer(
        uint256 target,
        uint256 bandBps
    ) external onlyRole(ADMIN_ROLE) {
        idleBufferUSDC = target;
        hysteresisBps = bandBps;
        emit BufferUpdated(target, bandBps);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /* ─────────────── UUPS ─────────────── */
    function _authorizeUpgrade(
        address newImpl
    ) internal override onlyRole(ADMIN_ROLE) {}

    /* ─────────────── Helpers ─────────────── */
    function _approveIfNeeded(
        IERC20 token,
        address spender,
        uint256 amount
    ) internal {
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance < amount) {
            token.safeIncreaseAllowance(spender, amount - currentAllowance);
        }
    }

    function _firstEnabledTranche() internal view returns (address _tranche) {
        for (uint256 i; i < tranches.length; ++i)
            if (tranches[i].enabled) return tranches[i].tranche;
        return address(this);
    }
}
