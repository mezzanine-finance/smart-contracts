// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";

import "./interfaces/IVault.sol";

interface IMZUSD is IERC20 {
    function mint(address to, uint256 amount) external;
}

interface IReservoir {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount, address to) external;
}

interface ITrancheLike {
    function totalAssets() external view returns (uint256);
}

/// @title Vault Contract
/// @notice The Vault manages USDC liquidity and distributes yield to tranches.
/// It holds USDC, which backs the MZUSD stablecoin, and interacts with a reservoir for funds rebalance.
/// The vault also manages tranches, which receive yield based on their weights and TVL.
contract Vault is
    Initializable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IVault,
    AccessManagedUpgradeable
{
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    IERC20 public usdc;
    IMZUSD public mzusd;
    IReservoir public reservoir;

    /// @dev Target USDC balance to keep on hand for instant withdrawals.
    uint256 public idleBufferUSDC;
    /// @dev +/- range around target in basis points (1 bps = 0.01%).
    /// e.g., 500 => ±5% band around idleBufferUSDC.
    uint256 public hysteresisBps;

    address public insurance;
    uint256 public insuranceBps;

    struct TrancheInfo {
        address tranche;
        uint256 weightBps;
        bool enabled;
    }
    TrancheInfo[] public tranches;
    mapping(address => bool) public isTranche;

    uint256 public performanceFeeBps; // 1000 = 10%
    uint256 public protocolFeeBps; // 100  = 1%
    address public performanceFeeReceiver; // receiver of performance fee (mzUSD)
    address public protocolFeeReceiver; // receiver protocol fee (mzUSD)

    event FeesUpdated(
        uint256 performanceBps,
        address performanceReceiver,
        uint256 protocolBps,
        address protocolReceiver
    );
    event FeesPaid(uint256 performanceMZUSD, uint256 protocolMZUSD);
    event Rebalanced(uint256 sent, uint256 pulled, uint256 idleAfter);
    event YieldDistributed(uint256 usdcUsed, uint256 mintedMZUSD);
    event TrancheRegistered(address tranche, uint256 weightBps, bool enabled);
    event TrancheUpdated(uint256 idx, uint256 weightBps, bool enabled);
    event InsuranceUpdated(address insurance, uint256 bps);
    event BufferUpdated(uint256 buffer, uint256 hysteresisBps);
    event WithdrawnUSDCFromVault(address to, uint256 amount);
    event MZUSDChanged(address newMZUSD);
    event ReservoirUpdated(address newReservoir);

    error NotMZUSD();
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
    /// @param _usdc Address of the USDC token contract (stablecoin backing MZUSD)
    /// @param _mzusd Address of the MZUSD token contract (mintable by vault, 18 decimals, protocol main stablecoin)
    /// @param _reservoir Address of the reservoir contract (for buffer and yield on strategies)
    /// @param accessManager Access manager contract controlling restricted functions
    function initialize(
        address _usdc,
        address _mzusd,
        address _reservoir,
        address accessManager
    ) external initializer {
        if (
            _usdc == address(0) ||
            _mzusd == address(0) ||
            _reservoir == address(0) ||
            accessManager == address(0)
        ) revert ZeroAddress();

        __UUPSUpgradeable_init();
        __AccessManaged_init(accessManager);
        __Pausable_init();
        __ReentrancyGuard_init();

        usdc = IERC20(_usdc);
        mzusd = IMZUSD(_mzusd);
        reservoir = IReservoir(_reservoir);

        idleBufferUSDC = 1_000_000 * 1e6; // 1M USDC
        hysteresisBps = 500; // +-5 %
    }

    function withdraw(
        address to,
        uint256 amount
    ) external whenNotPaused nonReentrant restricted {
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

    function distributeYield(
        uint256 usdcReported
    ) external whenNotPaused nonReentrant restricted {
        if (usdcReported == 0) revert ZeroAmount();
        if (tranches.length == 0) revert NoTranchesAdded();

        // 6 -> 18 decimals scaling (1 USDC == 1 mzUSD)
        uint256 mintedGross = usdcReported * 1e12;

        // Fees are taken post-mint in mzUSD (no USDC movement here)
        uint256 mintedForAllocation = mintedGross;
        uint256 performanceFeeMZUSD;
        uint256 protocolFeeMZUSD;

        // Performance fee (in mzUSD) -> minted straight to the receiver
        if (performanceFeeBps > 0 && performanceFeeReceiver != address(0)) {
            performanceFeeMZUSD = (mintedGross * performanceFeeBps) / BPS;
            if (performanceFeeMZUSD > 0) {
                mzusd.mint(performanceFeeReceiver, performanceFeeMZUSD);
                mintedForAllocation -= performanceFeeMZUSD;
            }
        }
        // Protocol fee (in mzUSD) -> minted straight to the receiver
        if (protocolFeeBps > 0 && protocolFeeReceiver != address(0)) {
            protocolFeeMZUSD = (mintedGross * protocolFeeBps) / BPS;
            if (protocolFeeMZUSD > 0) {
                mzusd.mint(protocolFeeReceiver, protocolFeeMZUSD);
                mintedForAllocation -= protocolFeeMZUSD;
            }
        }
 
        emit FeesPaid(performanceFeeMZUSD, protocolFeeMZUSD);

        // If fees consumed everything, there is nothing to allocate further
        if (mintedForAllocation == 0) {
            emit YieldDistributed(usdcReported, 0);
            return;
        }

        // Mint remaining mzUSD to this Vault so it can fan it out to tranches
        mzusd.mint(address(this), mintedForAllocation);

        // Optional insurance slice from the amount to be allocated to tranches
        uint256 allocatableMZUSD = mintedForAllocation;
        if (insurance != address(0) && insuranceBps > 0) {
            uint256 cut = (allocatableMZUSD * insuranceBps) / BPS;
            if (cut > 0) {
                IERC20(address(mzusd)).safeTransfer(insurance, cut);
                allocatableMZUSD -= cut;
            }
        }
        
        // Compute per-tranche score = weightBps * TVL(18d). We only use ratios
        uint256 trancheCount = tranches.length;
        uint256 totalScore; // sum of scores
        uint256 totalWeightsBps; // sanity - at least one enabled non-zero weight
        uint256[] memory tranchesScores = new uint256[](trancheCount);

        for (uint256 i; i < trancheCount; ++i) {
            TrancheInfo memory tranche = tranches[i];
            if (!tranche.enabled || tranche.weightBps == 0) continue;
            // TVL is expected in 18 decimals (mzUSD units)
            uint256 trancheTVL = ITrancheLike(tranche.tranche).totalAssets();
            // Mixed units (bps * 18d) — OK since we divide by totalScore later
            uint256 score = uint256(tranche.weightBps) * trancheTVL;

            tranchesScores[i] = score;
            totalScore += score;
            totalWeightsBps += tranche.weightBps;
        }
        // If all enabled weights are zero -> meaningless distribution
        if (totalWeightsBps == 0) revert WeightsZero();
        // If TVL is effectively zero across weighted tranches -> cannot split pro-rata
        if (totalScore == 0) revert TVLZero();

        // Pro-rata fan-out by score; integer division leaves small dust
        uint256 totalAllocatedMZUSD;
        for (uint256 i; i < trancheCount; ++i) {
            uint256 score = tranchesScores[i];
            if (score == 0) continue;
            // alloc = allocatable * score / totalScore (18d result)
            uint256 allocationMZUSD = (allocatableMZUSD * score) / totalScore;
            IERC20(address(mzusd)).safeTransfer(tranches[i].tranche, allocationMZUSD);
            totalAllocatedMZUSD += allocationMZUSD;
        }

        // Push rounding remainder to insurance (if set) or the first enabled tranche
        if (allocatableMZUSD > totalAllocatedMZUSD) {
            address dustRecipient = insurance != address(0)
                ? insurance
                : _firstEnabledTranche();
            IERC20(address(mzusd)).safeTransfer(dustRecipient, allocatableMZUSD - totalAllocatedMZUSD);
        }

        emit YieldDistributed(usdcReported, allocatableMZUSD);
    }

    /// @dev Sets the reservoir contract address.
    /// @param _reservoir Address of the reservoir contract (for buffer and yield on strategies)
    function setReservoir(address _reservoir) external restricted {
        if (_reservoir == address(0)) revert ZeroAddress();
        reservoir = IReservoir(_reservoir);
        emit ReservoirUpdated(_reservoir);
    }

    /// @dev Sets the MZUSD contract address.
    /// @param _mzusd Address of the MZUSD token contract (mintable by vault, 18 decimals, protocol main stablecoin)
    function setMZUSD(address _mzusd) external restricted {
        if (_mzusd == address(0)) revert ZeroAddress();
        if (address(mzusd) == _mzusd) return;
        mzusd = IMZUSD(_mzusd);
        emit MZUSDChanged(_mzusd);
    }

    /// @dev Sets performance and protocol fees (in basis points) and their receivers.
    /// @param _performanceFeeBps New performance fee (in basis points)
    /// @param _performanceFeeReceiver Address to receive performance fees (//todo curator?)
    /// @param _protocolFeeBps New protocol fee (in basis points)
    /// @param _protocolFeeReceiver Address to receive protocol fees (//todo treasury?)
    function setFees(
        uint256 _performanceFeeBps,
        address _performanceFeeReceiver,
        uint256 _protocolFeeBps,
        address _protocolFeeReceiver
    ) external restricted {
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
        uint256 weightBps,
        bool enabled
    ) external restricted  {
        if (tranche == address(0)) revert ZeroAddress();
        if (isTranche[tranche]) revert TrancheExists();
        tranches.push(TrancheInfo(tranche, weightBps, enabled));
        isTranche[tranche] = true;
        emit TrancheRegistered(tranche, weightBps, enabled);
    }

    function updateTranche(
        uint256 idx,
        uint256 weightBps,
        bool enabled
    ) external restricted  {
        if (idx >= tranches.length) revert TrancheIndexOOB();
        tranches[idx].weightBps = weightBps;
        tranches[idx].enabled = enabled;
        emit TrancheUpdated(idx, weightBps, enabled);
    }

    function setInsurance(
        address _insurance,
        uint256 bps
    ) external restricted  {
        if (bps > BPS) revert TooBigBps();
        if (_insurance == address(0)) revert ZeroAddress();
        insurance = _insurance;
        insuranceBps = bps;
        emit InsuranceUpdated(_insurance, bps);
    }

    function setBuffer(
        uint256 target,
        uint256 bandBps
    ) external restricted  {
        idleBufferUSDC = target;
        hysteresisBps = bandBps;
        emit BufferUpdated(target, bandBps);
    }

    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
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

     function _authorizeUpgrade(
        address newImpl
    ) internal override restricted {}
}
