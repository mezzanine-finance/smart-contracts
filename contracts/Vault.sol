// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";

interface IMZUSD {
    function mint(address to, uint256 amount) external;
}

interface IReservoir {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount, address to) external;
}

interface ITranche {
    function totalAssets() external view returns (uint256);
    function notifyYield(uint256 amount) external;
}


contract Vault is
    Initializable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    AccessManagedUpgradeable
{
    struct TrancheInfo {
        address tranche;
        uint16 weightBps;
        bool enabled;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MZUSD_SCALE = 1e12;
    uint256 public constant MIN_EPOCH_DURATION_LIMIT = 1 hours;
    uint256 public constant MAX_EPOCH_DURATION_LIMIT = 30 days;
    uint256 public constant MAX_TRANCHES = 50;

    TrancheInfo[] public tranches;
    mapping(address => bool) public isTranche;

    IERC20 public immutable usdc;
    IMZUSD public mzusd;
    IReservoir public reservoir;

    address public insurance;
    address public performanceFeeReceiver;
    address public protocolFeeReceiver;


    uint256 public idleBufferUSDC;
    uint256 public currentEpochId;

    // precomputed buffer bounds
    uint256 public bufferLowUSDC;
    uint256 public bufferHighUSDC;

    // epochs
    uint64 public epochStart;
    uint64 public epochDuration;


    uint16 public hysteresisBps;
    uint16 public insuranceBps;
    uint16 public performanceFeeBps;
    uint16 public protocolFeeBps;

    event FeesUpdated(
        uint256 performanceBps,
        address performanceReceiver,
        uint256 protocolBps,
        address protocolReceiver
    );
    event FeesPaid(uint256 performanceMZUSD, uint256 protocolMZUSD, uint256 epochId);
    event Rebalanced(uint256 sent, uint256 pulled, uint256 idleAfter);
    event YieldDistributed(uint256 usdcUsed, uint256 mintedMZUSD, uint256 epochId);
    event TrancheRegistered(address tranche, uint256 weightBps, bool enabled);
    event TrancheUpdated(uint256 idx, uint256 weightBps, bool enabled);
    event InsuranceUpdated(address insurance, uint256 bps);
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
    error ZeroAddressAndZeroBpsPerformance();
    error ZeroAddressAndZeroBpsProtocol();

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _disableInitializers();
    }

    function initialize(
        address _mzusd,
        address _reservoir,
        address accessManager
    ) external initializer {
        if (_mzusd == address(0) || _reservoir == address(0) || accessManager == address(0)) {
            revert ZeroAddress();
        }

        __UUPSUpgradeable_init();
        __AccessManaged_init(accessManager);
        __Pausable_init();
        __ReentrancyGuard_init();

        mzusd = IMZUSD(_mzusd);
        reservoir = IReservoir(_reservoir);

        idleBufferUSDC = 1_000_000 * 1e6;
        hysteresisBps = 500;

        currentEpochId = 1;
        epochStart = uint64(block.timestamp);
        epochDuration = 1 days;


        _updateBufferBounds();
    }

    function withdraw(address to, uint256 amount) external whenNotPaused nonReentrant restricted {
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
    function rebalance() external nonReentrant whenNotPaused restricted {
        uint256 idle = usdc.balanceOf(address(this));
        uint256 low = bufferLowUSDC;
        uint256 high = bufferHighUSDC;

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

    function distributeYield(uint256 usdcReported) external whenNotPaused nonReentrant restricted {
        if (usdcReported == 0) revert ZeroAmount();
        if (tranches.length == 0) revert NoTranchesAdded();

        uint256 newEpochId = _advanceEpochAndValidate();

        uint256 mintedGross = usdcReported * MZUSD_SCALE;

        (uint256 allocatableMZUSD, uint256 perfFee, uint256 protFee) = _mintFees(
            mintedGross
        );

        emit FeesPaid(perfFee, protFee, newEpochId);

        if (allocatableMZUSD == 0) {
            emit YieldDistributed(usdcReported, 0, newEpochId);
            return;
        }

        mzusd.mint(address(this), allocatableMZUSD);

        uint256 actuallyAllocated = _allocateYieldToTranches(allocatableMZUSD);

        emit YieldDistributed(usdcReported, actuallyAllocated, newEpochId);
    }

    function setReservoir(address _reservoir) external restricted {
        if (_reservoir == address(0)) revert ZeroAddress();
        if (address(reservoir) == _reservoir) revert SameValue();
        reservoir = IReservoir(_reservoir);
        emit ReservoirUpdated(_reservoir);
    }

    function setMZUSD(address _mzusd) external restricted {
        if (_mzusd == address(0)) revert ZeroAddress();
        if (address(mzusd) == _mzusd) revert SameValue();
        mzusd = IMZUSD(_mzusd);
        emit MZUSDChanged(_mzusd);
    }

    function setFees(
        uint256 _performanceFeeBps,
        address _performanceFeeReceiver,
        uint256 _protocolFeeBps,
        address _protocolFeeReceiver
    ) external restricted {
        if (_performanceFeeBps + _protocolFeeBps > BPS)
            revert TooBigBps();
        if (_performanceFeeBps > 0 && _performanceFeeReceiver == address(0))
            revert ZeroAddressAndZeroBpsPerformance();
        if (_protocolFeeBps > 0 && _protocolFeeReceiver == address(0))
            revert ZeroAddressAndZeroBpsProtocol();

        performanceFeeBps = uint16(_performanceFeeBps);
        performanceFeeReceiver = _performanceFeeReceiver;
        protocolFeeBps = uint16(_protocolFeeBps);
        protocolFeeReceiver = _protocolFeeReceiver;

        emit FeesUpdated(
            performanceFeeBps,
            performanceFeeReceiver,
            protocolFeeBps,
            protocolFeeReceiver
        );
    }


    function addTranche(TrancheInfo calldata info) external restricted {
        if (info.tranche == address(0)) revert ZeroAddress();
        if (isTranche[info.tranche]) revert TrancheExists();
        if (tranches.length >= MAX_TRANCHES) revert TooManyTranches();
        if (info.weightBps > BPS) revert TooBigBps();

        tranches.push(TrancheInfo(info.tranche, info.weightBps, info.enabled));
        isTranche[info.tranche] = true;
        emit TrancheRegistered(info.tranche, info.weightBps, info.enabled);
    }

    function updateTranche(uint256 idx, uint256 weightBps, bool enabled) external restricted {
        if (idx >= tranches.length) revert TrancheIndexOOB();
        if (weightBps > BPS) revert TooBigBps();
        tranches[idx].weightBps = uint16(weightBps);
        tranches[idx].enabled = enabled;
        emit TrancheUpdated(idx, weightBps, enabled);
    }

    function setInsurance(address _insurance, uint256 bps) external restricted {
        if (_insurance == address(0)) revert ZeroAddress();
        if (_insurance == insurance) revert SameValue();
        if (bps > BPS) revert TooBigBps();
        insurance = _insurance;
        insuranceBps = uint16(bps);
        emit InsuranceUpdated(_insurance, bps);
    }

    function setBuffer(uint256 target, uint256 bandBps) external restricted {
        if (bandBps > BPS) revert TooBigBps();
        if (target == 0) revert ZeroAmount();
        idleBufferUSDC = target;
        hysteresisBps = uint16(bandBps);
        _updateBufferBounds();
        emit BufferUpdated(target, bandBps);
    }

    function setEpochConfig(uint256 _epochDuration, bool resetStart) external restricted {
        if (
            _epochDuration < MIN_EPOCH_DURATION_LIMIT ||
            _epochDuration > MAX_EPOCH_DURATION_LIMIT
        ) {
            revert InvalidEpochDuration();
        }
        epochDuration = uint64(_epochDuration);
        if (resetStart) {
            uint256 ts = block.timestamp;
            epochStart = uint64(ts);
            emit EpochAdvanced(currentEpochId, ts);
        }
        emit EpochDurationSet(_epochDuration);
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
        return (bufferLowUSDC, bufferHighUSDC);
    }

    function getTrancheInfo(
        uint256 idx
    ) external view returns (address tranche, uint256 weightBps, bool enabled) {
        TrancheInfo memory t = tranches[idx];
        return (t.tranche, t.weightBps, t.enabled);
    }

    function getFeesConfig()
        external
        view
        returns (
            uint256 _perfBps,
            address _perfReceiver,
            uint256 _protBps,
            address _protReceiver
        )
    {
        return (
            performanceFeeBps,
            performanceFeeReceiver,
            protocolFeeBps,
            protocolFeeReceiver
        );
    }

    function _advanceEpochAndValidate() internal returns (uint256 newEpochId) {
        uint256 ts = block.timestamp;
        uint256 duration = epochDuration;

        if (ts < uint256(epochStart) + duration) revert EpochTooSoon();

        uint256 epochId = currentEpochId + 1;
        currentEpochId = epochId;
        epochStart = uint64(ts);

        emit EpochAdvanced(epochId, ts);
        return epochId;
    }

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

    function _mintFees(
        uint256 mintedGross
    )
        internal
        returns (uint256 mintedForAllocation, uint256 performanceFeeMZUSD, uint256 protocolFeeMZUSD)
    {
        performanceFeeMZUSD = _handleFee(
            performanceFeeBps,
            performanceFeeReceiver,
            mintedGross
        );
        protocolFeeMZUSD = _handleFee(protocolFeeBps, protocolFeeReceiver, mintedGross);

        mintedForAllocation = mintedGross - performanceFeeMZUSD - protocolFeeMZUSD;
    }

    function _allocateYieldToTranches(
        uint256 allocatableMZUSD
    ) internal returns (uint256 actuallyAllocated) {
        uint256 amountForTranches = allocatableMZUSD;

        address insurance_ = insurance;
        uint16 insuranceBps_ = insuranceBps;
        IERC20 mzusdToken = IERC20(address(mzusd));

        if (insurance_ != address(0) && insuranceBps_ > 0) {
            uint256 cut = (amountForTranches * insuranceBps_) / BPS;
            if (cut > 0) {
                mzusdToken.transfer(insurance_, cut);
                amountForTranches -= cut;
            }
        }

        uint256 trancheCount = tranches.length;
        uint256 totalScore;
        uint256 totalWeightsBps;
        uint256[] memory scores = new uint256[](trancheCount);

        address firstEnabledTranche;

        for (uint256 i = 0; i < trancheCount; i++) {
            TrancheInfo storage t = tranches[i];
            if (!t.enabled || t.weightBps == 0) continue;

            if (firstEnabledTranche == address(0)) {
                firstEnabledTranche = t.tranche;
            }

            uint256 tvl = ITranche(t.tranche).totalAssets();
            uint256 score = uint256(t.weightBps) * tvl;
            scores[i] = score;
            totalScore += score;
            totalWeightsBps += t.weightBps;
        }

        if (totalWeightsBps == 0) revert WeightsZero();
        if (totalScore == 0) revert TVLZero();

        uint256 allocated;
        for (uint256 i = 0; i < trancheCount; i++) {
            uint256 score = scores[i];
            if (score == 0) continue;

            TrancheInfo storage t = tranches[i];
            uint256 part = (amountForTranches * score) / totalScore;
            mzusdToken.transfer(t.tranche, part);
            ITranche(t.tranche).notifyYield(part);
            allocated += part;
        }

        if (amountForTranches > allocated) {
            address dustRecipient = insurance_ != address(0) ? insurance_ : firstEnabledTranche;
            if (dustRecipient == address(0)) {
                dustRecipient = address(this);
            }
            mzusdToken.transfer(dustRecipient, amountForTranches - allocated);
        }

        return amountForTranches;
    }

    function _updateBufferBounds() internal {
        uint256 buffer = idleBufferUSDC;
        uint16 bandBps = hysteresisBps;

        uint256 low = (buffer * (BPS - bandBps)) / BPS;
        uint256 high = (buffer * (BPS + bandBps)) / BPS;

        bufferLowUSDC = low;
        bufferHighUSDC = high;
    }

    function _approveIfNeeded(IERC20 token, address spender, uint256 amount) internal {
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance < amount) {
            token.approve(spender, amount);
        }
    }

    function _firstEnabledTranche() internal view returns (address _tranche) {
        uint256 len = tranches.length;
        for (uint256 i = 0; i < len; i++) {
            if (tranches[i].enabled) return tranches[i].tranche;
        }
        return address(this);
    }

    function _authorizeUpgrade(address newImpl) internal override restricted {}
}
