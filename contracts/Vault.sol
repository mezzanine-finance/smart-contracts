// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";

import "./interfaces/IVault.sol";
import "./interfaces/IMZUSD.sol";

interface IReservoir {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount, address to) external;
}

interface ITranche {
    function totalAssets() external view returns (uint256);
    function notifyYield(uint256 amount) external;
}

interface IFeeEscrow {
    function lock(
        address beneficiary,
        uint256 amount,
        uint256 unlockEpoch
    ) external;
}

contract Vault is
    Initializable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IVault,
    AccessManagedUpgradeable
{
    using SafeERC20 for IERC20;

    struct TrancheInfo {
        address tranche;
        uint256 weightBps;
        bool enabled;
    }
    TrancheInfo[] public tranches;
    mapping(address => bool) public isTranche;

    uint256 public constant BPS = 10_000;

    IERC20 public usdc;
    IMZUSD public mzusd;
    IReservoir public reservoir;

    uint256 public idleBufferUSDC;
    uint256 public hysteresisBps;

    address public insurance;
    uint256 public insuranceBps;

    uint256 public performanceFeeBps;
    uint256 public protocolFeeBps;
    address public performanceFeeReceiver;
    address public protocolFeeReceiver;

    // epochs
    uint256 public currentEpochId;
    uint256 public epochStart;
    uint256 public minEpochDuration;

    // fee locking
    IFeeEscrow public feeEscrow;
    uint256 public feeLockEpochs;

    event FeesUpdated(
        uint256 performanceBps,
        address performanceReceiver,
        uint256 protocolBps,
        address protocolReceiver
    );
    event FeesPaid(
        uint256 performanceMZUSD,
        uint256 protocolMZUSD,
        uint256 epochId
    );
    event Rebalanced(uint256 sent, uint256 pulled, uint256 idleAfter);
    event YieldDistributed(
        uint256 usdcUsed,
        uint256 mintedMZUSD,
        uint256 epochId
    );
    event TrancheRegistered(address tranche, uint256 weightBps, bool enabled);
    event TrancheUpdated(uint256 idx, uint256 weightBps, bool enabled);
    event InsuranceUpdated(address insurance, uint256 bps);
    event BufferUpdated(uint256 buffer, uint256 hysteresisBps);
    event WithdrawnUSDCFromVault(address to, uint256 amount);
    event MZUSDChanged(address newMZUSD);
    event ReservoirUpdated(address newReservoir);
    event EpochAdvanced(uint256 indexed epochId, uint256 startTs);
    event FeeEscrowUpdated(address escrow, uint256 feeLockEpochs);
    event MinEpochDurationSet(uint256 minEpochDuration);

    error ZeroAmount();
    error InsufficientUSDC();
    error NoTranchesAdded();
    error TVLZero();
    error WeightsZero();
    error TooBigBps();
    error TrancheExists();
    error TrancheIndexOOB();
    error ZeroAddress();
    error EpochTooSoon();

    constructor() {
        _disableInitializers();
    }

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

        idleBufferUSDC = 1_000_000 * 1e6;
        hysteresisBps = 500;

        currentEpochId = 1;
        epochStart = block.timestamp;
        minEpochDuration = 1 days;

        feeLockEpochs = 2;
    }

    //@dev usage by MZUSD to withdraw USDC for redemptions
    function withdraw(
        address to,
        uint256 amount
    ) external nonReentrant whenNotPaused restricted {
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

    //@dev using for rebalancing USDC between vault and reservoir
    function rebalance() external nonReentrant whenNotPaused restricted {
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

    //@dev using for distribute yield to tranches
    function distributeYield(
        uint256 usdcReported
    ) external nonReentrant whenNotPaused restricted {
        if (usdcReported == 0) revert ZeroAmount();
        if (tranches.length == 0) revert NoTranchesAdded();

        uint256 newEpochId = _advanceEpochAndValidate();
        uint256 mintedGross = usdcReported * 1e12;

        (
            uint256 allocatableMZUSD,
            uint256 perfFee,
            uint256 protFee
        ) = _mintAndLockFees(mintedGross, newEpochId);

        emit FeesPaid(perfFee, protFee, newEpochId);

        if (allocatableMZUSD == 0) {
            emit YieldDistributed(usdcReported, 0, newEpochId);
            return;
        }

        mzusd.mint(address(this), allocatableMZUSD);

        uint256 actuallyAllocated = _allocateYieldToTranches(allocatableMZUSD);

        emit YieldDistributed(usdcReported, actuallyAllocated, newEpochId);
    }

    //-----Setters-----
    function setReservoir(address _reservoir) external restricted {
        if (_reservoir == address(0)) revert ZeroAddress();
        reservoir = IReservoir(_reservoir);
        emit ReservoirUpdated(_reservoir);
    }

    function setMZUSD(address _mzusd) external restricted {
        if (_mzusd == address(0)) revert ZeroAddress();
        if (address(mzusd) == _mzusd) return;
        mzusd = IMZUSD(_mzusd);
        emit MZUSDChanged(_mzusd);
    }

    function setFees(
        uint256 _performanceFeeBps,
        address _performanceFeeReceiver,
        uint256 _protocolFeeBps,
        address _protocolFeeReceiver
    ) external restricted {
        //todo question - summary fee could be > BPS?
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

    function setFeeEscrow(
        address _escrow,
        uint256 _feeLockEpochs
    ) external restricted {
        if (_escrow == address(0)) revert ZeroAddress();
        feeEscrow = IFeeEscrow(_escrow);
        feeLockEpochs = _feeLockEpochs;
        emit FeeEscrowUpdated(_escrow, _feeLockEpochs);
    }

    function addTranche(
        address tranche,
        uint256 weightBps,
        bool enabled
    ) external restricted {
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
    ) external restricted {
        if (idx >= tranches.length) revert TrancheIndexOOB();
        tranches[idx].weightBps = weightBps;
        tranches[idx].enabled = enabled;
        emit TrancheUpdated(idx, weightBps, enabled);
    }

    function setInsurance(address _insurance, uint256 bps) external restricted {
        if (bps > BPS) revert TooBigBps();
        if (_insurance == address(0)) revert ZeroAddress();
        insurance = _insurance;
        insuranceBps = bps;
        emit InsuranceUpdated(_insurance, bps);
    }

    function setBuffer(uint256 target, uint256 bandBps) external restricted {
        if (bandBps > BPS) revert TooBigBps();
        if (target == 0) revert ZeroAmount();
        idleBufferUSDC = target;
        hysteresisBps = bandBps;
        emit BufferUpdated(target, bandBps);
    }

    function setEpochConfig(
        uint256 _minEpochDuration,
        bool resetStart
    ) external restricted {
        if (_minEpochDuration == 0) revert ZeroAmount();
        minEpochDuration = _minEpochDuration;
        if (resetStart) {
            epochStart = block.timestamp;
            emit EpochAdvanced(currentEpochId, epochStart);
        }
        emit MinEpochDurationSet(_minEpochDuration);
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
            address _protReceiver,
            address _feeEscrow,
            uint256 _feeLockEpochs
        )
    {
        return (
            performanceFeeBps,
            performanceFeeReceiver,
            protocolFeeBps,
            protocolFeeReceiver,
            address(feeEscrow),
            feeLockEpochs
        );
    }

    function _advanceEpochAndValidate() internal returns (uint256 newEpochId) {
        if (block.timestamp < epochStart + minEpochDuration)
            revert EpochTooSoon();
        currentEpochId += 1;
        epochStart = block.timestamp;
        emit EpochAdvanced(currentEpochId, epochStart);
        return currentEpochId;
    }

    //todo optimize
    function _mintAndLockFees(
        uint256 mintedGross,
        uint256 epochId
    )
        internal
        returns (
            uint256 mintedForAllocation,
            uint256 performanceFeeMZUSD,
            uint256 protocolFeeMZUSD
        )
    {
        mintedForAllocation = mintedGross;

        if (performanceFeeBps > 0 && performanceFeeReceiver != address(0)) {
            performanceFeeMZUSD = (mintedGross * performanceFeeBps) / BPS;
            if (performanceFeeMZUSD > 0) {
                if (address(feeEscrow) != address(0)) {
                    mzusd.mint(address(feeEscrow), performanceFeeMZUSD);
                    feeEscrow.lock(
                        performanceFeeReceiver,
                        performanceFeeMZUSD,
                        epochId + feeLockEpochs
                    );
                } else {
                    mzusd.mint(performanceFeeReceiver, performanceFeeMZUSD);
                }
                mintedForAllocation -= performanceFeeMZUSD;
            }
        }

        if (protocolFeeBps > 0 && protocolFeeReceiver != address(0)) {
            protocolFeeMZUSD = (mintedGross * protocolFeeBps) / BPS;
            if (protocolFeeMZUSD > 0) {
                if (address(feeEscrow) != address(0)) {
                    mzusd.mint(address(feeEscrow), protocolFeeMZUSD);
                    feeEscrow.lock(
                        protocolFeeReceiver,
                        protocolFeeMZUSD,
                        epochId + feeLockEpochs
                    );
                } else {
                    mzusd.mint(protocolFeeReceiver, protocolFeeMZUSD);
                }
                mintedForAllocation -= protocolFeeMZUSD;
            }
        }
    }

    function _allocateYieldToTranches(
        uint256 allocatableMZUSD
    ) internal returns (uint256 actuallyAllocated) {
        uint256 amountForTranches = allocatableMZUSD;

        if (insurance != address(0) && insuranceBps > 0) {
            uint256 cut = (amountForTranches * insuranceBps) / BPS;
            if (cut > 0) {
                IERC20(address(mzusd)).safeTransfer(insurance, cut);
                amountForTranches -= cut;
            }
        }

        uint256 trancheCount = tranches.length;
        uint256 totalScore;
        uint256 totalWeightsBps;
        uint256[] memory scores = new uint256[](trancheCount);

        for (uint256 i = 0; i < trancheCount; i++) {
            TrancheInfo memory t = tranches[i];
            if (!t.enabled || t.weightBps == 0) continue;
            uint256 tvl = ITranche(t.tranche).totalAssets();
            uint256 score = t.weightBps * tvl;
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
            uint256 part = (amountForTranches * score) / totalScore;
            IERC20(address(mzusd)).safeTransfer(tranches[i].tranche, part);
            ITranche(tranches[i].tranche).notifyYield(part);
            allocated += part;
        }

        if (amountForTranches > allocated) {
            address dustRecipient = insurance != address(0)
                ? insurance
                : _firstEnabledTranche();
            IERC20(address(mzusd)).safeTransfer(
                dustRecipient,
                amountForTranches - allocated
            );
        }

        return amountForTranches;
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
        uint256 len = tranches.length;
        for (uint256 i = 0; i < len; i++) {
            if (tranches[i].enabled) return tranches[i].tranche;
        }
        return address(this);
    }

    function _authorizeUpgrade(address newImpl) internal override restricted {}
}
