// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";

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

contract Vault is ReentrancyGuardUpgradeable, UUPSUpgradeable, AccessManagedUpgradeable {
    /// @notice Info for each registered tranche
    struct TrancheInfo {
        address tranche;
        uint16 weightBps;
        bool enabled;
    }

    // aderyn-ignore-next-line(large-numeric-literal)
    uint16 public constant BPS = 10_000;
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

    address public insurance; // address of insurance contract for tranche yield insurance allocation
    address public performanceFeeReceiver; // receiver of performance/curators fees
    address public protocolFeeReceiver; // receiver of protocols fees

    uint256 public idleBufferUSDC; // target idle USDC buffer in vault

    // precomputed buffer bounds
    uint256 public bufferLowUSDC; // lower bound for idle USDC before pulling from reservoir
    uint256 public bufferHighUSDC; // upper bound for idle USDC before sending to reservoir

    // epochs + config
    uint64 public epochStart; // start timestamp of current epoch
    uint64 public epochDuration; // duration of each epoch in seconds
    uint64 public currentEpochId; // current epoch ID for yield distribution

    uint16 public hysteresisBps; // hysteresis band around idle buffer target
    //todo discuss is insurance needed?
    uint16 public insuranceBps; // portion of yield allocated to insurance (bps of total yield)
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
    error ZeroAddressWhileFeeIsOnPerformance();
    error ZeroAddressWhileFeeIsOnProtocol();
    error EthTransferFailed(address to, uint256 attemptedAmount);

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _disableInitializers();
    }

    /// @notice Initializer
    /// @param _reservoir - address of reservoir contract
    /// @param accessManager - access manager address for role control
    function initialize(address _reservoir, address accessManager) external initializer {
        if (_reservoir == address(0) || accessManager == address(0)) {
            revert ZeroAddress();
        }

        __AccessManaged_init(accessManager);
        __ReentrancyGuard_init();

        reservoir = IReservoir(_reservoir);

        // aderyn-ignore-next-line(large-numeric-literal)
        idleBufferUSDC = 1_000_000 * 1e6;
        hysteresisBps = 500;

        currentEpochId = 1;
        epochStart = uint64(block.timestamp);
        epochDuration = 1 days;

        _updateBufferBounds();
    }

    /// @dev withdraw USDC from vault to specified address
    /// @param to - address to receive withdrawn USDC
    /// @param amount - amount of USDC to withdraw
    /// @dev used for MZUSD redemptions
    function withdraw(address to, uint256 amount) external restricted {
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
    function rebalance() external restricted {
        uint256 idle = usdc.balanceOf(address(this));
        uint256 low = bufferLowUSDC;
        uint256 high = bufferHighUSDC;

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

    /// @dev distribute yield reported in USDC to tranches
    /// @param usdcReported - amount of USDC yield to distribute
    /// @dev mints MZUSD at 1:1 with USDC reported
    /// @dev called once per epoch after yield is reported
    /// @dev fees are minted in MZUSD and sent to fee receivers
    /// @dev yield is allocated to tranches based on their weights and TVL
    /// @dev portion of yield can be allocated to insurance if configured
    function distributeYield(uint256 usdcReported) external nonReentrant restricted {
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
    function setReservoir(address _reservoir) external restricted {
        if (_reservoir == address(0)) revert ZeroAddress();
        if (address(reservoir) == _reservoir) revert SameValue();
        reservoir = IReservoir(_reservoir);
        emit ReservoirUpdated(_reservoir);
    }

    /// @notice Update MZUSD address
    function setMZUSD(address _mzusd) external restricted {
        if (_mzusd == address(0)) revert ZeroAddress();
        if (address(mzusd) == _mzusd) revert SameValue();
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
    ) external restricted {
        if (_performanceFeeBps + _protocolFeeBps > BPS) revert TooBigBps();
        if (_performanceFeeBps > 0 && _performanceFeeReceiver == address(0))
            revert ZeroAddressWhileFeeIsOnPerformance();
        if (_protocolFeeBps > 0 && _protocolFeeReceiver == address(0))
            revert ZeroAddressWhileFeeIsOnProtocol();

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

    /// @notice Register a new tranche
    function addTranche(TrancheInfo calldata info) external restricted {
        if (info.tranche == address(0)) revert ZeroAddress();
        if (isTranche[info.tranche]) revert TrancheExists();
        if (tranches.length >= MAX_TRANCHES) revert TooManyTranches();
        if (info.weightBps > BPS) revert TooBigBps();

        tranches.push(TrancheInfo(info.tranche, info.weightBps, info.enabled));
        isTranche[info.tranche] = true;
        emit TrancheRegistered(info.tranche, info.weightBps, info.enabled);
    }

    /// @notice Update tranche info
    /// @param idx - index of tranche in tranches array
    /// @param weightBps - new weight in bps
    /// @param enabled - whether tranche is enabled for yield allocation
    function updateTranche(uint256 idx, uint16 weightBps, bool enabled) external restricted {
        if (idx >= tranches.length) revert TrancheIndexOOB();
        if (weightBps > BPS) revert TooBigBps();
        tranches[idx].weightBps = weightBps;
        tranches[idx].enabled = enabled;
        emit TrancheUpdated(idx, weightBps, enabled);
    }

    /// @notice Update insurance address and bps
    /// @param _insurance - new insurance address
    /// @param bps - new insurance bps
    function setInsurance(address _insurance, uint16 bps) external restricted {
        if (_insurance == address(0)) revert ZeroAddress();
        if (_insurance == insurance) revert SameValue();
        if (bps > BPS) revert TooBigBps();
        insurance = _insurance;
        insuranceBps = bps;
        emit InsuranceUpdated(_insurance, bps);
    }

    /// @notice Update idle USDC buffer and hysteresis band
    /// @param target - target idle USDC buffer
    /// @param bandBps - hysteresis band in bps
    function setBuffer(uint256 target, uint16 bandBps) external restricted {
        if (bandBps > BPS) revert TooBigBps();
        if (target == 0) revert ZeroAmount();
        idleBufferUSDC = target;
        hysteresisBps = bandBps;
        _updateBufferBounds();
        emit BufferUpdated(target, bandBps);
    }

    /// @notice Update epoch duration
    /// @param _epochDuration - new epoch duration in seconds
    /// @param resetStart - whether to reset epoch start timestamp to now
    function setEpochConfig(uint64 _epochDuration, bool resetStart) external restricted {
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
    function advanceEpoch() external restricted returns (uint256 newEpochId) {
        return _advanceEpochAndValidate();
    }

    //GETTERS
    function tranchesLength() external view returns (uint256 length) {
        length = tranches.length;
    }

    function currentIdleUSDC() external view returns (uint256 idleUSDC) {
        idleUSDC = usdc.balanceOf(address(this));
    }

    function bufferBounds() external view returns (uint256 low, uint256 high) {
        return (bufferLowUSDC, bufferHighUSDC);
    }

    /// @notice Get tranche info by index
    /// @param idx - index of tranche in tranches array
    /// @return tranche - tranche address
    /// @return weightBps - tranche weight in bps
    /// @return enabled - whether tranche is enabled for yield allocation
    function getTrancheInfo(
        uint256 idx
    ) external view returns (address tranche, uint256 weightBps, bool enabled) {
        TrancheInfo memory t = tranches[idx];
        return (t.tranche, t.weightBps, t.enabled);
    }

    /// @notice Get current fees configuration
    function getFeesConfig()
        external
        view
        returns (uint256 _perfBps, address _perfReceiver, uint256 _protBps, address _protReceiver)
    {
        return (performanceFeeBps, performanceFeeReceiver, protocolFeeBps, protocolFeeReceiver);
    }

    //INTERNAL HELPERS
    /// @notice Advance epoch and validate that enough time has passed
    /// @return newEpochId - new epoch ID after advancement
    function _advanceEpochAndValidate() internal returns (uint256 newEpochId) {
        uint256 ts = block.timestamp;
        if (ts < uint256(epochStart) + epochDuration) revert EpochTooSoon();

        uint64 epochId = currentEpochId + 1;
        currentEpochId = epochId;
        epochStart = uint64(ts);

        emit EpochAdvanced(epochId, ts);
        return epochId;
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
        uint256 amountForTranches = allocatableMZUSD;

        // handle insurance cut
        address insurance_ = insurance;
        uint16 insuranceBps_ = insuranceBps;
        IMZUSD mzusdToken = mzusd;

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
        TrancheInfo memory t;

        // calculate scores for each tranche and total score
        for (uint256 i; i < trancheCount; i++) {
            t = tranches[i];
            if (!t.enabled || t.weightBps == 0) continue;

            if (firstEnabledTranche == address(0)) {
                firstEnabledTranche = t.tranche;
            }

            // score = weightBps * TVL
            uint256 score = uint256(t.weightBps) * ITranche(t.tranche).totalAssets();
            scores[i] = score;
            totalScore += score;
            totalWeightsBps += t.weightBps;
        }

        if (totalWeightsBps == 0) revert WeightsZero();
        if (totalScore == 0) revert TVLZero();

        // allocate yield based on scores
        uint256 allocated;
        for (uint256 i; i < trancheCount; ++i) {
            uint256 score = scores[i];
            if (score == 0) continue;

            t = tranches[i];
            uint256 part = (amountForTranches * score) / totalScore;
            if (i == trancheCount - 1 && amountForTranches - allocated != part) {
                part = amountForTranches - allocated;
            }
            mzusdToken.transfer(t.tranche, part);
            ITranche(t.tranche).notifyYield(part);
            allocated += part;
        }

        return amountForTranches;
    }

    /// @notice Update buffer bounds based on idle buffer and hysteresis
    function _updateBufferBounds() internal {
        uint256 buffer = idleBufferUSDC;
        uint16 bandBps = hysteresisBps;

        uint256 low = (buffer * (BPS - bandBps)) / BPS;
        uint256 high = (buffer * (BPS + bandBps)) / BPS;

        bufferLowUSDC = low;
        bufferHighUSDC = high;
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
    function _authorizeUpgrade(address newImpl) internal override restricted {}
}
