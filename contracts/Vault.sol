// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";

/* ─────────────── External interfaces ─────────────── */

interface IMZUSD is IERC20 {
    function mint(address to, uint256 amount) external; // pulls USDC → mints MZUSD
}

interface IReservoir {
    function deposit(uint256 amount) external;

    function withdraw(uint256 amount, address to) external;
}

interface ITrancheLike {
    function totalAssets() external view returns (uint256);
}
//todo interface inheritance
interface IVault {
    function withdraw(address to, uint256 amount) external;
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
    IVault,
    AccessManagedUpgradeable
{
    using SafeERC20 for IERC20;

    /* ─────────────── Roles ─────────────── */
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant MZUSD_ROLE = keccak256("MZUSD_ROLE");

    uint256 public constant BPS = 10_000;

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

    // ─── Fees ──────────────────────────────────────────────────────────────
    uint16 public performanceFeeBps; // 1000 = 10%
    uint16 public protocolFeeBps; // 100  = 1%
    address public performanceFeeReceiver; // receiver of performance fee (USDC)
    address public protocolFeeReceiver; // receiver protocol fee (USDC)

    event FeesUpdated(
        uint16 perfBps,
        address perfReceiver,
        uint16 protoBps,
        address protoReceiver
    );
    event FeesPaid(uint256 perfUSDC, uint256 protoUSDC);
    event Rebalanced(uint256 sent, uint256 pulled, uint256 idleAfter);
    event YieldDistributed(uint256 usdcUsed, uint256 mintedMZUSD);
    event TrancheRegistered(address tranche, uint16 weightBps, bool enabled);
    event TrancheUpdated(uint256 idx, uint16 weightBps, bool enabled);
    event InsuranceUpdated(address insurance, uint16 bps);
    event BufferUpdated(uint256 buffer, uint256 hysteresisBps);
    event WithdrawnUSDCFromVault(address to, uint256 amount);
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

    /// @dev Initializes the contract with the given parameters.
    /// @param _admin Address of the admin role
    /// @param _usdc Address of the USDC token contract (stablecoin backing MZUSD)
    /// @param _mzusd Address of the MZUSD token contract (mintable by vault, 18 decimals, protocol main stablecoin)
    /// @param _reservoir Address of the reservoir contract (for buffer and yield on strategies)
    function initialize(
        address _admin,
        address _usdc,
        address _mzusd,
        address _reservoir,
        address accessManager
    ) external initializer {
        if (
            _admin == address(0) ||
            _usdc == address(0) ||
            _mzusd == address(0) ||
            _reservoir == address(0) ||
            accessManager == address(0)
        ) revert ZeroAddress();

        __AccessManaged_init(accessManager);
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
        _grantRole(DISTRIBUTOR_ROLE, _admin);

        idleBufferUSDC = 1_000_000 * 1e6; // 1M USDC
        hysteresisBps = 500; // +-5 %
    }

    /* ─────────────── MZUSD withdrawal handler ─────────────── */
    function withdraw(
        address to,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (!hasRole(MZUSD_ROLE, msg.sender)) revert NotMZUSD();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 idle = usdc.balanceOf(address(this));
        if (idle < amount) {
            reservoir.withdraw(amount - idle, address(this));
        }
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientUSDC();
        usdc.safeTransfer(to, amount);
        emit WithdrawnUSDCFromVault(to, amount);
    }

    /* ─────────────── Buffer rebalance ─────────────── */
    function rebalance() external whenNotPaused {
        uint256 idle = usdc.balanceOf(address(this));
        uint256 low = (idleBufferUSDC * (BPS - hysteresisBps)) / BPS;
        uint256 high = (idleBufferUSDC * (BPS + hysteresisBps)) / BPS;

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
        uint256 usdcReported
    ) external whenNotPaused nonReentrant restricted onlyRole(DISTRIBUTOR_ROLE) {
        if (usdcReported == 0) revert ZeroAmount();
        if (tranches.length == 0) revert NoTranchesAdded();

        // 6 -> 18 dec scaling (1 USDC == 1 mzUSD)
        uint256 mintedGross = usdcReported * 1e12;

        // --- Fees: post-mint in mzUSD (nothing moves in USDC) ---
        uint256 mintedForAllocation = mintedGross;

        if (performanceFeeBps > 0 && performanceFeeReceiver != address(0)) {
            uint256 feeMZ = (mintedGross * performanceFeeBps) / BPS;
            if (feeMZ > 0) {
                mzusd.mint(performanceFeeReceiver, feeMZ);
                mintedForAllocation -= feeMZ;
            }
        }
        if (protocolFeeBps > 0 && protocolFeeReceiver != address(0)) {
            uint256 feeMZ = (mintedGross * protocolFeeBps) / BPS;
            if (feeMZ > 0) {
                mzusd.mint(protocolFeeReceiver, feeMZ);
                mintedForAllocation -= feeMZ;
            }
        }

        //If nothing is left to allocate after fees
        if (mintedForAllocation == 0) {
            emit YieldDistributed(usdcReported, 0);
            return;
        }

        // Mint the remainder to the Vault itself for subsequent distribution to tranches
        mzusd.mint(address(this), mintedForAllocation);

        // --- Insurance cut (in mzUSD) ---
        uint256 minted = mintedForAllocation;
        if (insurance != address(0) && insuranceBps > 0) {
            uint256 cut = (minted * insuranceBps) / BPS;
            if (cut > 0) {
                IERC20(address(mzusd)).safeTransfer(insurance, cut);
                minted -= cut;
            }
        }

        // --- Relative-weight * TVL allocation ---
        uint256 n = tranches.length;
        uint256 sum;
        uint256[] memory base = new uint256[](n);

        for (uint256 i; i < n; ++i) {
            TrancheInfo memory t = tranches[i];
            if (!t.enabled || t.weightBps == 0) continue;
            uint256 tvl = ITrancheLike(t.tranche).totalAssets(); // 18d mzUSD
            uint256 p = uint256(t.weightBps) * tvl; // bps * 18d
            base[i] = p;
            sum += p;
        }
        if (sum == 0) revert TVLZero();

        uint256 distributed;
        for (uint256 i; i < n; ++i) {
            uint256 p = base[i];
            if (p == 0) continue;
            uint256 amt = (minted * p) / sum; // 18d
            IERC20(address(mzusd)).safeTransfer(tranches[i].tranche, amt);
            distributed += amt;
        }

        // rounding dust → insurance or first enabled tranche
        if (minted > distributed) {
            address sink = insurance != address(0)
                ? insurance
                : _firstEnabledTranche();
            IERC20(address(mzusd)).safeTransfer(sink, minted - distributed);
        }

        emit YieldDistributed(usdcReported, minted);
    }

    /* ─────────────── Admin ─────────────── */
    /// @dev Sets the reservoir contract address.
    /// @param _reservoir Address of the reservoir contract (for buffer and yield on strategies)
    function setReservoir(address _reservoir) external restricted onlyRole(ADMIN_ROLE) {
        if (_reservoir == address(0)) revert ZeroAddress();
        reservoir = IReservoir(_reservoir);
        emit ReservoirUpdated(_reservoir);
    }

    /// @dev Sets the MZUSD contract address.
    /// @param _mzusd Address of the MZUSD token contract (mintable by vault, 18 decimals, protocol main stablecoin)
    function setMZUSD(address _mzusd) external restricted onlyRole(ADMIN_ROLE) {
        if (_mzusd == address(0)) revert ZeroAddress();
        
        address old = address(mzusd);
        if (old == _mzusd) return;
        
        mzusd = IMZUSD(_mzusd);
        
        _grantRole(MZUSD_ROLE, _mzusd);
        if (old != address(0)) {
            _revokeRole(MZUSD_ROLE, old);
        }
        emit MZUSDChanged(_mzusd);
    }

    /// @dev Sets performance and protocol fees (in basis points) and their receivers.
    /// @param _performanceFeeBps New performance fee (in basis points)
    /// @param _performanceFeeReceiver Address to receive performance fees (//todo curator)
    /// @param _protocolFeeBps New protocol fee (in basis points)
    /// @param _protocolFeeReceiver Address to receive protocol fees (//todo treasury)
    function setFees(
        uint16 _performanceFeeBps,
        address _performanceFeeReceiver,
        uint16 _protocolFeeBps,
        address _protocolFeeReceiver
    ) external restricted onlyRole(ADMIN_ROLE) {
        if (_performanceFeeBps > BPS || _protocolFeeBps > BPS)
            revert TooBigBps();
        if (_performanceFeeBps > 0 && _performanceFeeReceiver == address(0))
            revert ZeroAddress();
        if (_protocolFeeBps > 0 && _protocolFeeReceiver == address(0))
            revert ZeroAddress();

        performanceFeeBps = _performanceFeeBps;
        performanceFeeReceiver = _performanceFeeReceiver;
        protocolFeeBps = _protocolFeeBps;
        protocolFeeReceiver = _protocolFeeReceiver;

        emit FeesUpdated(
            performanceFeeBps,
            performanceFeeReceiver,
            protocolFeeBps,
            protocolFeeReceiver
        );
    }

    /// @dev Adds a new tranche to the vault.
    /// @param tranche address of tranche contract
    /// @param weightBps weight of the tranche (in basis points)
    /// @param enabled whether the tranche is enabled
    function addTranche(
        address tranche,
        uint16 weightBps,
        bool enabled
    ) external restricted onlyRole(ADMIN_ROLE) {
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
    ) external restricted onlyRole(ADMIN_ROLE) {
        if (idx >= tranches.length) revert TrancheIndexOOB();
        tranches[idx].weightBps = weightBps;
        tranches[idx].enabled = enabled;
        emit TrancheUpdated(idx, weightBps, enabled);
    }

    function setInsurance(
        address _insurance,
        uint16 bps
    ) external restricted onlyRole(ADMIN_ROLE) {
        if (bps > BPS) revert TooBigBps();
        if (_insurance == address(0)) revert ZeroAddress();
        insurance = _insurance;
        insuranceBps = bps;
        emit InsuranceUpdated(_insurance, bps);
    }

    function setBuffer(
        uint256 target,
        uint256 bandBps
    ) external restricted onlyRole(ADMIN_ROLE) {
        idleBufferUSDC = target;
        hysteresisBps = bandBps;
        emit BufferUpdated(target, bandBps);
    }

    function pause() external restricted onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external restricted onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function tranchesLength() external view returns (uint256) {
        return tranches.length;
    }

    function currentIdleUSDC() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function bufferBounds() external view returns (uint256 low, uint256 high) {
        low = (idleBufferUSDC * (BPS - hysteresisBps)) / BPS;
        high = (idleBufferUSDC * (BPS + hysteresisBps)) / BPS;
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
