// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";

// aderyn-fp-next-line(reused-contract-name)
interface IMZUSD is IERC20 {
    function mint(address to, uint256 amount) external;
}
// aderyn-fp-next-line(reused-contract-name)
interface ITranche {
    function totalAssets() external view returns (uint256 assets);
    function notifyYield(uint256 amount) external;
}
interface IReservoir {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount, address to) external;
}

// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract Vault is
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    AccessManagedUpgradeable,
    PauseManagedUpgradeable
{
    /// @notice Info for each registered tranche
    struct TrancheInfo {
        address tranche;
        uint16 weight;
        bool enabled;
    }

    // aderyn-ignore-next-line(large-numeric-literal)
    uint16 public constant BPS = 10_000;
    // Max allowed tranche weight (relative, not bps).
    // aderyn-ignore-next-line(large-numeric-literal)
    uint16 public constant TRANCHE_WEIGHT_LIMIT = 10_000;
    uint256 public constant MZUSD_SCALE = 1e12;
    uint64 public constant MIN_EPOCH_DURATION_LIMIT = 1 hours;
    uint64 public constant MAX_EPOCH_DURATION_LIMIT = 30 days;
    uint16 public constant MAX_TRANCHES = 50;

    TrancheInfo[] public tranches;
    // check if address is registered tranche
    mapping(address => bool) public isTranche;

    IERC20 public immutable usdc; // address of USDC token
    IMZUSD public mzusd; // address of MZUSD token, protocol stablecoin
    IReservoir public reservoir; // address of reservoir contract for idle USDC

    address public performanceFeeReceiver; // receiver of performance/curators fees
    address public protocolFeeReceiver; // receiver of protocols fees

    uint256 public idleBufferUSDC; // target idle USDC buffer in vault

    // epochs + config
    uint64 public epochStart; // start timestamp of current epoch
    uint64 public epochDuration; // duration of each epoch in seconds
    uint64 public currentEpochId; // current epoch ID for yield distribution

    uint16 public hysteresisBps; // hysteresis band around idle buffer target
    uint16 public performanceFeeBps; // portion of yield allocated to performance/curators fees (bps of total yield)
    uint16 public protocolFeeBps; // portion of yield allocated to protocol fees (bps of total yield)

    event FeesUpdated(
        uint256 performanceBps,
        address performanceReceiver,
        uint256 protocolBps,
        address protocolReceiver
    );
    event FeesPaid(uint256 performanceMZUSD, uint256 protocolMZUSD, uint256 epochId);
    event Rebalanced(uint256 sent, uint256 pulled, uint256 idleAfter);
    event YieldDistributed(uint256 usdcUsed, uint256 mintedMZUSD, uint256 epochId);
    event TrancheRegistered(address tranche, uint256 weight, bool enabled);
    event TrancheUpdated(uint256 idx, uint256 weight, bool enabled);
    event BufferUpdated(uint256 buffer, uint256 hysteresisBps);
    event WithdrawnUSDCFromVault(address to, uint256 amount);
    event MZUSDChanged(address newMZUSD);
    event ReservoirUpdated(address newReservoir);
    event EpochAdvanced(uint256 indexed epochId, uint256 startTs);
    event EpochDurationSet(uint256 epochDuration);

    error ZeroAmount();
    error NoTranchesAdded();
    error TVLZero();
    error WeightsZero();
    error TooBigBps();
    error TrancheExists();
    error TrancheIndexOOB();
    error ZeroAddress();
    error EpochTooSoon();
    error InvalidEpochDuration();
    error TooManyTranches();
    error SameValue();
    error MZUSDAlreadySet();
    error NotMZUSD();

    modifier onlyMZUSD() {
        if (msg.sender != address(mzusd)) revert NotMZUSD();
        _;
    }

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _disableInitializers();
    }

    /// @notice Initializer
    /// @param _reservoir - address of reservoir contract
    /// @param accessManager - access manager address for role control
    /// @param pauseManager - pause manager address for category-based pauses
    /// @param _performanceFeeBps - performance/curators fee in bps (can be zero)
    /// @param _performanceFeeReceiver - receiver for performance/curators fees
    /// @param _protocolFeeBps - protocol fee in bps (can be zero)
    /// @param _protocolFeeReceiver - receiver for protocol fees
    function initialize(
        address _reservoir,
        address accessManager,
        address pauseManager,
        uint16 _performanceFeeBps,
        address _performanceFeeReceiver,
        uint16 _protocolFeeBps,
        address _protocolFeeReceiver
    ) external initializer {
        if (_reservoir == address(0) || accessManager == address(0)) revert ZeroAddress();

        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager);
        __ReentrancyGuard_init();

        reservoir = IReservoir(_reservoir);
        _setFees(
            _performanceFeeBps,
            _performanceFeeReceiver,
            _protocolFeeBps,
            _protocolFeeReceiver
        );

        // aderyn-ignore-next-line(large-numeric-literal)
        idleBufferUSDC = 1_000_000 * 1e6;
        hysteresisBps = 500;

        currentEpochId = 1;
        epochStart = uint64(block.timestamp);
        epochDuration = 1 days;
    }

    /// @dev withdraw USDC from vault to specified address
    /// @param to - address to receive withdrawn USDC
    /// @param amount - amount of USDC to withdraw
    /// @dev used for MZUSD redemptions
    /// @dev callable only by the configured MZUSD contract
    function withdraw(
        address to,
        uint256 amount
    ) external onlyMZUSD whenNotPaused(PauseCategory.PROTOCOL) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 idle = usdc.balanceOf(address(this));
        if (idle < amount) {
            reservoir.withdraw(amount - idle, address(this));
        }
        // USDC transfer will revert if balance is insufficient
        usdc.transfer(to, amount);
        emit WithdrawnUSDCFromVault(to, amount);
    }

    //@dev using for rebalancing USDC between vault and reservoir
    function rebalance() external restricted whenNotPaused(PauseCategory.PROTOCOL) {
        _rebalance();
    }

    /// @dev distribute yield reported in USDC to tranches
    /// @param usdcReported - amount of USDC yield to distribute
    /// @dev mints MZUSD at 1:1 with USDC reported
    /// @dev called once per epoch after yield is reported
    /// @dev fees are minted in MZUSD and sent to fee receivers
    /// @dev yield is allocated to tranches based on their weights and TVL
    function distributeYield(
        uint256 usdcReported
    ) external nonReentrant restricted whenNotPaused(PauseCategory.PROTOCOL) {
        if (tranches.length == 0) revert NoTranchesAdded();

        // Always advance epoch on distribution call, even if yield is 0.
        // This prevents epoch-based withdrawal flows from getting stuck.
        uint256 newEpochId = _advanceEpochAndValidate();

        if (usdcReported == 0) {
            emit FeesPaid(0, 0, newEpochId);
            emit YieldDistributed(0, 0, newEpochId);
            return;
        }

        uint256 mintedGross = usdcReported * MZUSD_SCALE;

        (uint256 allocatableMZUSD, uint256 perfFee, uint256 protFee) = _mintFees(mintedGross);
        emit FeesPaid(perfFee, protFee, newEpochId);

        if (allocatableMZUSD == 0) {
            emit YieldDistributed(usdcReported, 0, newEpochId);
            return;
        }

        mzusd.mint(address(this), allocatableMZUSD);
        uint256 actuallyAllocated = _allocateYieldToTranches(allocatableMZUSD);

        emit YieldDistributed(usdcReported, actuallyAllocated, newEpochId);
    }

    //SETTERS
    /// @notice Update reservoir address
    function setReservoir(
        address _reservoir
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (_reservoir == address(0)) revert ZeroAddress();
        if (address(reservoir) == _reservoir) revert SameValue();
        reservoir = IReservoir(_reservoir);
        emit ReservoirUpdated(_reservoir);
    }

    /// @notice Set MZUSD address (one-time).
    function setMZUSD(address _mzusd) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (_mzusd == address(0)) revert ZeroAddress();
        if (address(mzusd) != address(0)) revert MZUSDAlreadySet();
        mzusd = IMZUSD(_mzusd);
        emit MZUSDChanged(_mzusd);
    }

    /// @notice Update fees configuration
    /// @dev Sum of performanceFeeBps and protocolFeeBps must not exceed BPS
    function setFees(
        uint16 _performanceFeeBps,
        address _performanceFeeReceiver,
        uint16 _protocolFeeBps,
        address _protocolFeeReceiver
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        _setFees(
            _performanceFeeBps,
            _performanceFeeReceiver,
            _protocolFeeBps,
            _protocolFeeReceiver
        );

        emit FeesUpdated(
            performanceFeeBps,
            performanceFeeReceiver,
            protocolFeeBps,
            protocolFeeReceiver
        );
    }

    /// @notice Register a new tranche
    function addTranche(
        TrancheInfo calldata info
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (info.tranche == address(0)) revert ZeroAddress();
        if (isTranche[info.tranche]) revert TrancheExists();
        if (tranches.length >= MAX_TRANCHES) revert TooManyTranches();
        if (info.weight > TRANCHE_WEIGHT_LIMIT) revert TooBigBps();

        tranches.push(TrancheInfo(info.tranche, info.weight, info.enabled));
        isTranche[info.tranche] = true;
        emit TrancheRegistered(info.tranche, info.weight, info.enabled);
    }

    /// @notice Update tranche info
    /// @param idx - index of tranche in tranches array
    /// @param weight - new weight for yield allocation
    /// @param enabled - whether tranche is enabled for yield allocation
    function updateTranche(
        uint256 idx,
        uint16 weight,
        bool enabled
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (idx >= tranches.length) revert TrancheIndexOOB();
        if (weight > TRANCHE_WEIGHT_LIMIT) revert TooBigBps();
        tranches[idx].weight = weight;
        tranches[idx].enabled = enabled;
        emit TrancheUpdated(idx, weight, enabled);
    }

    /// @notice Update idle USDC buffer and hysteresis band
    /// @param target - target idle USDC buffer
    /// @param bandBps - hysteresis band in bps
    function setBuffer(
        uint256 target,
        uint16 bandBps
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (bandBps > BPS) revert TooBigBps();
        if (target == 0) revert ZeroAmount();
        idleBufferUSDC = target;
        hysteresisBps = bandBps;
        emit BufferUpdated(target, bandBps);
        _rebalance();
    }

    /// @notice Update epoch duration
    /// @param _epochDuration - new epoch duration in seconds
    /// @param resetStart - whether to reset epoch start timestamp to now
    function setEpochConfig(
        uint64 _epochDuration,
        bool resetStart
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (
            _epochDuration < MIN_EPOCH_DURATION_LIMIT || _epochDuration > MAX_EPOCH_DURATION_LIMIT
        ) {
            revert InvalidEpochDuration();
        }
        epochDuration = _epochDuration;
        if (resetStart) {
            uint64 ts = uint64(block.timestamp);
            epochStart = ts;
            emit EpochAdvanced(currentEpochId, ts);
        }
        emit EpochDurationSet(_epochDuration);
    }

    /// @notice Advances the epoch if enough time has passed.
    /// @dev Heartbeat for periods with zero yield, so other epoch-based flows can progress.
    function advanceEpoch()
        external
        restricted
        whenNotPaused(PauseCategory.PROTOCOL)
        returns (uint256 newEpochId)
    {
        return _advanceEpochAndValidate();
    }

    //GETTERS
    function tranchesLength() external view returns (uint256 length) {
        length = tranches.length;
    }

    function currentIdleUSDC() external view returns (uint256 idleUSDC) {
        idleUSDC = usdc.balanceOf(address(this));
    }

    function getTranches(
        uint256 start,
        uint256 count
    )
        external
        view
        returns (address[] memory tranche, uint16[] memory weights, bool[] memory enabled)
    {
        uint256 len = tranches.length;
        if (start >= len || count == 0) {
            return (new address[](0), new uint16[](0), new bool[](0));
        }

        uint256 end = start + count;
        if (end > len) {
            end = len;
        }
        uint256 size = end - start;

        tranche = new address[](size);
        weights = new uint16[](size);
        enabled = new bool[](size);

        for (uint256 i; i < size; ++i) {
            TrancheInfo memory t = tranches[start + i];
            tranche[i] = t.tranche;
            weights[i] = t.weight;
            enabled[i] = t.enabled;
        }
    }

    function getEpochConfig()
        external
        view
        returns (uint64 epochId, uint64 start, uint64 duration)
    {
        return (currentEpochId, epochStart, epochDuration);
    }

    function getBufferConfig()
        external
        view
        returns (uint256 buffer, uint16 hysteresis, uint256 low, uint256 high)
    {
        (low, high) = _bufferBounds();
        return (idleBufferUSDC, hysteresisBps, low, high);
    }

    //INTERNAL HELPERS
    /// @notice Internal function to set fees
    /// @param _performanceFeeBps - performance/curators fee in bps
    /// @param _performanceFeeReceiver - receiver for performance/curators fees
    /// @param _protocolFeeBps - protocol fee in bps
    /// @param _protocolFeeReceiver - receiver for protocol fees
    /// @dev Sum of _performanceFeeBps and _protocolFeeBps must not exceed BPS
    /// @dev _performanceFeeReceiver and _protocolFeeReceiver must be non-zero and different addresses
    function _setFees(
        uint16 _performanceFeeBps,
        address _performanceFeeReceiver,
        uint16 _protocolFeeBps,
        address _protocolFeeReceiver
    ) internal {
        if (_performanceFeeBps + _protocolFeeBps > BPS) revert TooBigBps();
        if (_performanceFeeReceiver == address(0) || _protocolFeeReceiver == address(0)) {
            revert ZeroAddress();
        }
        performanceFeeBps = _performanceFeeBps;
        performanceFeeReceiver = _performanceFeeReceiver;
        protocolFeeBps = _protocolFeeBps;
        protocolFeeReceiver = _protocolFeeReceiver;
    }

    /// @notice Advance epoch and validate that enough time has passed
    /// @return newEpochId - new epoch ID after advancement
    function _advanceEpochAndValidate() internal returns (uint256 newEpochId) {
        uint64 ts = uint64(block.timestamp);
        if (ts < epochStart + epochDuration) revert EpochTooSoon();

        epochStart = ts;
        newEpochId = ++currentEpochId;
        emit EpochAdvanced(newEpochId, ts);
    }

    /// @notice Mint fees in MZUSD based on minted gross amount
    /// @param mintedGross - gross amount of MZUSD minted for yield distribution
    /// @return mintedForAllocation - amount of MZUSD left for tranche allocation after fees
    /// @return performanceFeeMZUSD - amount of MZUSD minted as performance fee
    /// @return protocolFeeMZUSD - amount of MZUSD minted as protocol fee
    function _mintFees(
        uint256 mintedGross
    )
        internal
        returns (uint256 mintedForAllocation, uint256 performanceFeeMZUSD, uint256 protocolFeeMZUSD)
    {
        performanceFeeMZUSD = _handleFee(performanceFeeBps, performanceFeeReceiver, mintedGross);
        protocolFeeMZUSD = _handleFee(protocolFeeBps, protocolFeeReceiver, mintedGross);

        mintedForAllocation = mintedGross - performanceFeeMZUSD - protocolFeeMZUSD;
    }

    /// @notice Handle fee minting
    /// @param bps - fee in basis points
    /// @param receiver - address to receive the fee
    /// @param mintedGross - gross amount of MZUSD minted for yield distribution
    /// @return feeAmount - amount of MZUSD minted as fee
    function _handleFee(
        uint16 bps,
        address receiver,
        uint256 mintedGross
    ) internal returns (uint256 feeAmount) {
        if (bps == 0 || receiver == address(0)) {
            return 0;
        }

        feeAmount = (mintedGross * bps) / BPS;
        if (feeAmount == 0) {
            return 0;
        }

        mzusd.mint(receiver, feeAmount);
    }

    /// @notice Allocate yield to tranches based on weights and TVL
    /// @param allocatableMZUSD - amount of MZUSD available for allocation to tranches
    /// @return actuallyAllocated - amount of MZUSD actually allocated to tranches
    function _allocateYieldToTranches(
        uint256 allocatableMZUSD
    ) internal returns (uint256 actuallyAllocated) {
        IMZUSD mzusdToken = mzusd;

        uint256 trancheCount = tranches.length;
        uint256 totalScore;
        uint256 totalWeight;
        uint256[] memory scores = new uint256[](trancheCount);

        address firstEnabledTranche;
        TrancheInfo memory t;

        // calculate scores for each tranche and total score
        for (uint256 i; i < trancheCount; ++i) {
            t = tranches[i];
            if (!t.enabled || t.weight == 0) continue;

            if (firstEnabledTranche == address(0)) {
                firstEnabledTranche = t.tranche;
            }

            // score = weight * TVL
            uint256 score = uint256(t.weight) * ITranche(t.tranche).totalAssets();
            scores[i] = score;
            totalScore += score;
            totalWeight += t.weight;
        }

        if (totalWeight == 0) revert WeightsZero();
        if (totalScore == 0) revert TVLZero();

        // allocate yield based on scores
        uint256 allocated;
        for (uint256 i; i < trancheCount; ++i) {
            uint256 score = scores[i];
            if (score == 0) continue;

            t = tranches[i];
            uint256 part = (allocatableMZUSD * score) / totalScore;
            if (i == trancheCount - 1 && allocatableMZUSD - allocated != part) {
                part = allocatableMZUSD - allocated;
            }
            mzusdToken.transfer(t.tranche, part);
            ITranche(t.tranche).notifyYield(part);
            allocated += part;
        }

        return allocatableMZUSD;
    }

    /// @notice Compute buffer bounds based on idle buffer and hysteresis
    function _bufferBounds() internal view returns (uint256 low, uint256 high) {
        uint256 buffer = idleBufferUSDC;
        uint16 bandBps = hysteresisBps;

        low = (buffer * (BPS - bandBps)) / BPS;
        high = (buffer * (BPS + bandBps)) / BPS;
    }

    function _rebalance() internal {
        uint256 idle = usdc.balanceOf(address(this));
        (uint256 low, uint256 high) = _bufferBounds();

        uint256 sent;
        uint256 pulled;
        if (idle > high) {
            sent = idle - idleBufferUSDC;
            usdc.approve(address(reservoir), sent);
            reservoir.deposit(sent);
        } else if (idle < low) {
            pulled = idleBufferUSDC - idle;
            reservoir.withdraw(pulled, address(this));
        }
        emit Rebalanced(sent, pulled, usdc.balanceOf(address(this)));
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address newImpl) internal override restricted {}
}
