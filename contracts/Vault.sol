// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";
import "./interfaces/IMZUSD.sol";
import "./interfaces/IReservoir.sol";
import "./interfaces/ITranche.sol";
import "./interfaces/ILossManager.sol";
import "./interfaces/INavOracleAutomation.sol";
/// @title Vault
/// @notice Protocol treasury that mints MZUSD, manages yield distribution, buffers USDC for withdrawals/insurance,
///         and coordinates with the Reservoir where strategies live.
/// @dev This Vault is not an ERC4626 vault and does not mint user shares or represent deposits.
/// @dev Tranches are the ERC4626-like vaults for users.
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract Vault is
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    AccessManagedUpgradeable,
    PauseManagedUpgradeable
{
    /// @notice Info for each registered tranche.
    struct TrancheInfo {
        address tranche;
        uint16 riskPremiumBps;
        bool enabled;
    }

    // aderyn-ignore-next-line(large-numeric-literal)
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_TOTAL_FEE_BPS = 5_000;
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

    //IMMUTABLE
    IERC20 public immutable usdc; // address of USDC token
    IMZUSD public immutable mzusd; // address of MZUSD token, protocol stablecoin
    IReservoir public immutable reservoir; // address of reservoir contract for idle USDC
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
    uint16 public baseRewardBps; // portion of yield allocated to the base reward pool
    address public lossManager; // canonical loss manager (set once)
    address public navOracle; // canonical NAV automation address
    uint64 public pendingEpochDuration; // queued duration to apply on next epoch

    event FeesUpdated(
        uint256 performanceBps,
        address performanceReceiver,
        uint256 protocolBps,
        address protocolReceiver
    );
    event FeesPaid(uint256 performanceMZUSD, uint256 protocolMZUSD, uint256 epochId);
    event Rebalanced(uint256 sent, uint256 pulled, uint256 idleAfter);
    event YieldDistributed(uint256 usdcUsed, uint256 mintedMZUSD, uint256 epochId);
    event TrancheRegistered(address tranche);
    event TrancheUpdated(uint256 idx, uint256 riskPremiumBps, bool enabled);
    event BufferUpdated(uint256 buffer, uint256 hysteresisBps);
    event WithdrawnUSDCFromVault(address to, uint256 amount);
    event LossManagerUpdated(address newLossManager);
    event NavOracleUpdated(address newNavOracle);
    event EpochAdvanced(uint256 indexed epochId, uint256 startTs);
    event EpochDurationSet(uint256 epochDuration);
    event EpochDurationQueued(uint256 epochDuration);
    event YieldDistributionUpdated(uint16 baseRewardBps, uint16[] riskPremiumsBps, bool[] enabled);

    error AllocationMismatch(uint256 allocated, uint256 expected);
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
    error LossManagerAlreadySet();
    error LossManagerNotSet();
    error NotMZUSD();
    error NotLossManager();
    error NotNavOracle();
    error InvalidMZUSDDecimals(uint8 actualDecimals);
    error InvalidMZUSDUSDC(address actualUSDC);
    error InvalidLossManagerVault(address actualVault);
    error InvalidLossManagerMZUSD(address actualMZUSD);
    error InvalidNavOracleVault(address actualVault);
    error InvalidNavOracleLossManager(address actualLossManager);
    error InvalidNavOracleMZUSD(address actualMZUSD);
    error InvalidMZUSDAccessManager(address actualAccessManager);
    error InvalidMZUSDPauseManager(address actualPauseManager);
    error InvalidReservoirAccessManager(address actualAccessManager);
    error InvalidReservoirPauseManager(address actualPauseManager);
    error AddressHasNoCode(address candidate);
    error InvalidReservoirUSDC(address actualUSDC);
    error ReservoirEmpty();
    error InvalidYieldDistribution();
    error LengthMismatch();

    modifier onlyMZUSD() {
        if (msg.sender != address(mzusd)) revert NotMZUSD();
        _;
    }

    modifier onlyLossManager() {
        if (msg.sender != lossManager) revert NotLossManager();
        _;
    }

    modifier onlyNavOracle() {
        if (msg.sender != navOracle) revert NotNavOracle();
        _;
    }

    constructor(address _mzusd, address _reservoir) {
        (IMZUSD token, address tokenUSDC) = _validateConstructorParams(_mzusd, _reservoir);

        mzusd = token;
        usdc = IERC20(tokenUSDC);
        reservoir = IReservoir(_reservoir);
        _disableInitializers();
    }

    /// @notice Initialize the Vault.
    /// @param _performanceFeeBps Performance/curator fee in bps (0 allowed).
    /// @param _performanceFeeReceiver Recipient of performance/curator fees.
    /// @param _protocolFeeBps Protocol fee in bps (0 allowed).
    /// @param _protocolFeeReceiver Recipient of protocol fees.
    /// @dev _protocolFeeReceiver and _performanceFeeReceiver could be same addresses.
    function initialize(
        uint16 _performanceFeeBps,
        address _performanceFeeReceiver,
        uint16 _protocolFeeBps,
        address _protocolFeeReceiver
    ) external initializer {
        (address accessManager, address pauseManager_) = _resolveAndValidateCoreManagers();

        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);
        __ReentrancyGuard_init();

        _setFeeRates(_performanceFeeBps, _protocolFeeBps);
        _setFeeReceivers(_performanceFeeReceiver, _protocolFeeReceiver);

        // aderyn-ignore-next-line(large-numeric-literal)
        idleBufferUSDC = 1_000_000 * 1e6;
        hysteresisBps = 500;

        currentEpochId = 1;
        epochStart = uint64(block.timestamp);
        epochDuration = 1 days;
    }

    /// @notice Withdraw USDC to a recipient (used for MZUSD redemptions).
    /// @param to USDC recipient.
    /// @param amount USDC amount (6 decimals).
    /// @dev Callable only by the configured MZUSD contract.
    function withdraw(
        address to,
        uint256 amount
    ) external onlyMZUSD whenNotPaused(PauseCategory.WITHDRAWALS) {
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

    /// @notice Rebalance idle USDC between Vault and Reservoir.
    function rebalance() external restricted whenNotPaused(PauseCategory.PROTOCOL) {
        _rebalance();
    }

    /// @notice Distribute yield (reported in USDC) to tranches.
    /// @param usdcReported USDC yield to distribute (6 decimals).
    /// @dev Mints MZUSD 1:1 with reported USDC, advances epoch, mints fees,
    ///      and allocates by TVL and risk premium.
    function distributeYield(
        uint256 usdcReported
    ) external nonReentrant onlyNavOracle whenNotPaused(PauseCategory.PROTOCOL) {
        if (tranches.length == 0) revert NoTranchesAdded();

        // Always advance epoch on distribution call, even if yield is 0.
        // This means yield can only be distributed once per epoch, and only at epoch start.
        // Epochs are not necessarily contiguous; there can be an arbitrary pause between epochs
        // until a distribution (or explicit advance) is triggered.
        uint256 newEpochId = _advanceEpochAndValidate();

        // NAV reporter is trusted: no extra balance checks are performed here.
        // usdcReported is assumed to be correct for the accounting flows that follow.
        if (usdcReported == 0) {
            emit FeesPaid(0, 0, newEpochId);
            emit YieldDistributed(0, 0, newEpochId);
            return;
        }

        uint256 mintedGross = usdcReported * MZUSD_SCALE;

        (uint256 allocatableMZUSD, uint256 perfFee, uint256 protFee) = _handleFees(mintedGross);
        emit FeesPaid(perfFee, protFee, newEpochId);

        if (allocatableMZUSD == 0) {
            emit YieldDistributed(usdcReported, 0, newEpochId);
            return;
        }

        // Allocation model: mint allocatable MZUSD to the Vault, then transfer to tranches.
        // Dust is assigned to the last non-zero tranche, so the Vault should end with no MZUSD.
        mzusd.mint(address(this), allocatableMZUSD);
        uint256 actuallyAllocated = _allocateYieldToTranches(allocatableMZUSD);

        emit YieldDistributed(usdcReported, actuallyAllocated, newEpochId);
    }

    //SETTERS
    /// @notice Set LossManager address (one-time).
    function setLossManager(
        address _lossManager
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (_lossManager == address(0)) revert ZeroAddress();
        if (lossManager != address(0)) revert LossManagerAlreadySet();
        if (_lossManager.code.length == 0) revert AddressHasNoCode(_lossManager);
        address lmVault = ILossManager(_lossManager).vault();
        if (lmVault != address(this)) revert InvalidLossManagerVault(lmVault);
        address lmMZUSD = ILossManager(_lossManager).mzusd();
        if (lmMZUSD != address(mzusd)) revert InvalidLossManagerMZUSD(lmMZUSD);
        lossManager = _lossManager;
        emit LossManagerUpdated(_lossManager);
    }

    /// @notice Update NAV oracle automation address.
    function setNavOracle(
        address _navOracle
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (_navOracle == address(0)) revert ZeroAddress();
        if (navOracle == _navOracle) revert SameValue();
        if (lossManager == address(0)) revert LossManagerNotSet();
        if (_navOracle.code.length == 0) revert AddressHasNoCode(_navOracle);

        INavOracleAutomation oracle = INavOracleAutomation(_navOracle);
        address oracleVault = oracle.vault();
        if (oracleVault != address(this)) revert InvalidNavOracleVault(oracleVault);
        address oracleLossManager = oracle.lossManager();
        if (oracleLossManager != lossManager) {
            revert InvalidNavOracleLossManager(oracleLossManager);
        }
        address oracleMZUSD = oracle.mzusd();
        if (oracleMZUSD != address(mzusd)) revert InvalidNavOracleMZUSD(oracleMZUSD);

        navOracle = _navOracle;
        emit NavOracleUpdated(_navOracle);
    }

    /// @notice Update fee rates (bps).
    /// @dev Sum of performanceFeeBps and protocolFeeBps must not exceed MAX_TOTAL_FEE_BPS
    function setFeeRates(
        uint16 _performanceFeeBps,
        uint16 _protocolFeeBps
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        _setFeeRates(_performanceFeeBps, _protocolFeeBps);

        emit FeesUpdated(
            performanceFeeBps,
            performanceFeeReceiver,
            protocolFeeBps,
            protocolFeeReceiver
        );
    }

    /// @notice Update fee receivers.
    function setFeeReceivers(
        address _performanceFeeReceiver,
        address _protocolFeeReceiver
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        _setFeeReceivers(_performanceFeeReceiver, _protocolFeeReceiver);

        emit FeesUpdated(
            performanceFeeBps,
            performanceFeeReceiver,
            protocolFeeBps,
            protocolFeeReceiver
        );
    }

    /// @notice Register a new tranche.
    /// @dev Tranche is disabled by default as adding of new tranche requires to reset yield distribution via setYieldDistribution().
    function addTranche(address _tranche) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (_tranche == address(0)) revert ZeroAddress();
        if (isTranche[_tranche]) revert TrancheExists();
        if (tranches.length >= MAX_TRANCHES) revert TooManyTranches();

        tranches.push(TrancheInfo(_tranche, 0, false));
        isTranche[_tranche] = true;
        emit TrancheRegistered(_tranche);
    }

    // /// @notice Update tranche info.
    // /// @param idx Tranche index in `tranches`.
    // /// @param riskPremiumBps New riskPremiumBps for yield allocation.
    // /// @param enabled Whether the tranche receives allocations.
    // function updateTranche(
    //     uint256 idx,
    //     uint16 riskPremiumBps,
    //     bool enabled
    // ) external restricted whenNotPaused(PauseCategory.ADMIN) {
    //     if (idx >= tranches.length) revert TrancheIndexOOB();
    //     tranches[idx].riskPremiumBps = riskPremiumBps;
    //     tranches[idx].enabled = enabled;
    //     emit TrancheUpdated(idx, riskPremiumBps, enabled);
    // }

    /// @notice Update base reward and risk premium distribution across all tranches.
    /// @param _baseRewardBps Base reward pool share in bps.
    /// @param _riskPremiumsBps Risk premium in bps for each tranche (length must match tranches array).
    /// @param _enabled Whether each tranche receives allocations (length must match tranches array).
    /// @dev Enforces invariant: _baseRewardBps + sum(_riskPremiumsBps) == BPS (10_000).
    function setYieldDistribution(
        uint16 _baseRewardBps,
        uint16[] calldata _riskPremiumsBps,
        bool[] calldata _enabled
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        uint256 len = tranches.length;
        if (_riskPremiumsBps.length != len || _enabled.length != len) revert LengthMismatch();

        uint256 total = _baseRewardBps;
        for (uint256 i; i < len; ++i) {
            tranches[i].riskPremiumBps = _riskPremiumsBps[i];
            tranches[i].enabled = _enabled[i];
            total += _riskPremiumsBps[i];
        }
        if (total != BPS) revert InvalidYieldDistribution();

        baseRewardBps = _baseRewardBps;

        emit YieldDistributionUpdated(_baseRewardBps, _riskPremiumsBps, _enabled);
    }

    /// @notice Update idle USDC buffer and hysteresis band.
    /// @param target Target idle USDC buffer (6 decimals).
    /// @param bandBps Hysteresis band in bps.
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

    /// @notice Queue epoch duration update for next epoch.
    /// @dev AccessManager should enforce an execution delay for this method.
    /// @param _epochDuration New epoch duration in seconds.
    function setEpochConfig(
        uint64 _epochDuration
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (
            _epochDuration < MIN_EPOCH_DURATION_LIMIT || _epochDuration > MAX_EPOCH_DURATION_LIMIT
        ) {
            revert InvalidEpochDuration();
        }
        pendingEpochDuration = _epochDuration;
        emit EpochDurationQueued(_epochDuration);
    }

    /// @notice Advances the epoch if enough time has passed.
    /// @dev Heartbeat for periods with zero yield, so other epoch-based flows can progress.
    function advanceEpoch()
        external
        onlyLossManager
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

    /// @notice Get tranche info in paginated manner.
    /// @param start The starting tranche index.
    /// @param count The number of tranches to return.
    /// @return tranche The tranche addresses.
    /// @return riskPremiumBpsArr The tranche risk premium (bps).
    /// @return enabled The tranche enabled flags.
    function getTranches(
        uint256 start,
        uint256 count
    )
        external
        view
        returns (address[] memory tranche, uint16[] memory riskPremiumBpsArr, bool[] memory enabled)
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
        riskPremiumBpsArr = new uint16[](size);
        enabled = new bool[](size);

        for (uint256 i; i < size; ++i) {
            TrancheInfo memory t = tranches[start + i];
            tranche[i] = t.tranche;
            riskPremiumBpsArr[i] = t.riskPremiumBps;
            enabled[i] = t.enabled;
        }
    }

    ///@notice Get current epoch configuration.
    ///@return epochId Current epoch ID.
    ///@return start Current epoch start timestamp.
    ///@return duration Current epoch duration in seconds.
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
    /// @notice Validate constructor parameters.
    /// @param _mzusd MZUSD token address.
    /// @param _reservoir Reservoir contract address.
    /// @return token Validated MZUSD token interface.
    /// @return tokenUSDC MZUSD's USDC address.
    function _validateConstructorParams(
        address _mzusd,
        address _reservoir
    ) internal view returns (IMZUSD token, address tokenUSDC) {
        if (_mzusd == address(0) || _reservoir == address(0)) revert ZeroAddress();

        token = IMZUSD(_mzusd);
        uint8 decimals = token.decimals();
        if (decimals != 18) revert InvalidMZUSDDecimals(decimals);

        tokenUSDC = token.usdc();
        if (tokenUSDC == address(0)) revert InvalidMZUSDUSDC(tokenUSDC);

        address reservoirUSDC = IReservoir(_reservoir).usdc();
        if (reservoirUSDC != tokenUSDC) revert InvalidReservoirUSDC(reservoirUSDC);
    }

    /// @notice Resolve and validate AccessManager and PauseManager from MZUSD/Reservoir.
    /// @dev Enforces that MZUSD and Reservoir are wired to the same authority and pause manager.
    function _resolveAndValidateCoreManagers()
        internal
        view
        returns (address accessManager, address pauseManager_)
    {
        accessManager = mzusd.authority();
        if (accessManager == address(0)) {
            revert InvalidMZUSDAccessManager(accessManager);
        }

        pauseManager_ = mzusd.pauseManager();
        if (pauseManager_ == address(0)) {
            revert InvalidMZUSDPauseManager(pauseManager_);
        }

        address reservoirAccessManager = reservoir.authority();
        if (reservoirAccessManager != accessManager) {
            revert InvalidReservoirAccessManager(reservoirAccessManager);
        }

        address reservoirPauseManager = reservoir.pauseManager();
        if (reservoirPauseManager != pauseManager_) {
            revert InvalidReservoirPauseManager(reservoirPauseManager);
        }
    }

    /// @notice Internal function to set fee rates.
    /// @param _performanceFeeBps Performance/curator fee in bps.
    /// @param _protocolFeeBps Protocol fee in bps.
    /// @dev Sum of _performanceFeeBps and _protocolFeeBps must not exceed MAX_TOTAL_FEE_BPS
    function _setFeeRates(uint16 _performanceFeeBps, uint16 _protocolFeeBps) internal {
        if (_performanceFeeBps + _protocolFeeBps > MAX_TOTAL_FEE_BPS) revert TooBigBps();
        performanceFeeBps = _performanceFeeBps;
        protocolFeeBps = _protocolFeeBps;
    }

    /// @notice Internal function to set fee receivers.
    /// @param _performanceFeeReceiver Recipient of performance/curator fees.
    /// @param _protocolFeeReceiver Recipient of protocol fees.
    /// @dev _performanceFeeReceiver and _protocolFeeReceiver must be non-zero.
    /// @dev _performanceFeeReceiver and _protocolFeeReceiver could be same addresses.
    function _setFeeReceivers(
        address _performanceFeeReceiver,
        address _protocolFeeReceiver
    ) internal {
        if (_performanceFeeReceiver == address(0) || _protocolFeeReceiver == address(0)) {
            revert ZeroAddress();
        }
        performanceFeeReceiver = _performanceFeeReceiver;
        protocolFeeReceiver = _protocolFeeReceiver;
    }

    /// @notice Advance epoch and validate that enough time has passed.
    /// @return newEpochId New epoch ID after advancement.
    function _advanceEpochAndValidate() internal returns (uint256 newEpochId) {
        uint64 ts = uint64(block.timestamp);
        if (ts < epochStart + epochDuration) revert EpochTooSoon();

        epochStart = ts;
        newEpochId = ++currentEpochId;
        emit EpochAdvanced(newEpochId, ts);

        uint64 queuedDuration = pendingEpochDuration;
        if (queuedDuration != 0) {
            epochDuration = queuedDuration;
            pendingEpochDuration = 0;
            emit EpochDurationSet(queuedDuration);
        }
    }

    /// @notice Mint fees in MZUSD based on the gross minted amount.
    /// @param mintedGross Gross MZUSD minted for yield distribution (18 decimals).
    /// @return mintedForAllocation MZUSD remaining for tranche allocation after fees.
    /// @return performanceFeeMZUSD MZUSD minted as the performance fee.
    /// @return protocolFeeMZUSD MZUSD minted as the protocol fee.
    function _handleFees(
        uint256 mintedGross
    )
        internal
        returns (uint256 mintedForAllocation, uint256 performanceFeeMZUSD, uint256 protocolFeeMZUSD)
    {
        performanceFeeMZUSD = _mintFee(performanceFeeBps, performanceFeeReceiver, mintedGross);
        protocolFeeMZUSD = _mintFee(protocolFeeBps, protocolFeeReceiver, mintedGross);

        mintedForAllocation = mintedGross - performanceFeeMZUSD - protocolFeeMZUSD;
    }

    /// @notice Mint a fee in MZUSD.
    /// @param bps Fee in basis points.
    /// @param receiver Recipient of the fee.
    /// @param mintedGross Gross MZUSD minted for yield distribution (18 decimals).
    /// @return feeAmount MZUSD minted as the fee.
    function _mintFee(
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

    /// @notice Allocate yield to tranches based on weights and TVL.
    /// @param allocatableMZUSD MZUSD available for allocation (18 decimals).
    /// @return actuallyAllocated MZUSD actually allocated to tranches.
    /// @dev Tranches are expected to be ERC4626 vaults over MZUSD (18 decimals),
    ///      so totalAssets() is already in MZUSD units. If multi-asset tranches are
    ///      introduced later, normalize units before scoring.
    function _allocateYieldToTranches(
        uint256 allocatableMZUSD
    ) internal returns (uint256 actuallyAllocated) {
        IMZUSD mzusdToken = mzusd;

        uint256 trancheCount = tranches.length;
        uint256 basePool = (allocatableMZUSD * baseRewardBps) / BPS;
        uint256[] memory trancheTvls = new uint256[](trancheCount);
        uint256 totalTvl;
        uint256 lastNonZeroIndex;

        TrancheInfo memory t;
        uint256 trancheTvl;

        for (uint256 i; i < trancheCount; ++i) {
            t = tranches[i];
            // score = TVL
            trancheTvl = ITranche(t.tranche).totalAssets();
            if (!t.enabled || trancheTvl == 0) continue;
            trancheTvls[i] = trancheTvl;
            totalTvl += trancheTvl;
            // Track the last tranche that actually participates in allocation.
            // Dust will be assigned there to avoid leftover MZUSD on the Vault.
            lastNonZeroIndex = i;
        }

        if (totalTvl == 0) revert TVLZero();

        // allocate yield based on TVL and Risk premium
        uint256 allocated;
        uint256 baseShare;
        uint256 riskPremiumShare;
        uint256 totalShare;

        for (uint256 i; i < trancheCount; ++i) {
            trancheTvl = trancheTvls[i];
            t = tranches[i];
            if (trancheTvl == 0) continue;

            baseShare = (basePool * trancheTvl) / totalTvl;
            riskPremiumShare = (allocatableMZUSD * t.riskPremiumBps) / BPS;
            totalShare = baseShare + riskPremiumShare;

            if (i == lastNonZeroIndex) {
                // Assign any rounding dust to the last participating tranche.
                totalShare = allocatableMZUSD - allocated;
            }
            if (totalShare == 0) {
                continue;
            }
            mzusdToken.transfer(t.tranche, totalShare);
            ITranche(t.tranche).notifyYield(totalShare);
            allocated += totalShare;
        }

        // Defensive check: allocation should consume the full allocatable amount.
        // If this ever fails, it prevents silent leftover MZUSD on the Vault.
        if (allocated != allocatableMZUSD) {
            revert AllocationMismatch(allocated, allocatableMZUSD);
        }
        return allocatableMZUSD;
    }

    /// @notice Compute buffer bounds based on idle buffer and hysteresis.
    function _bufferBounds() internal view returns (uint256 low, uint256 high) {
        uint256 buffer = idleBufferUSDC;
        uint16 bandBps = hysteresisBps;

        low = (buffer * (BPS - bandBps)) / BPS;
        high = (buffer * (BPS + bandBps)) / BPS;
    }

    /// @notice Rebalance idle USDC against the target buffer and hysteresis band.
    /// @dev Sends excess to Reservoir or pulls when below the low bound.
    /// @dev When there is no much money in Reservoir, it will pull whatever is available.
    /// @dev If Reservoir is empty, it reverts.
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
            uint256 need = idleBufferUSDC - idle;
            uint256 available = usdc.balanceOf(address(reservoir));
            if (available == 0) revert ReservoirEmpty();
            pulled = available < need ? available : need;
            reservoir.withdraw(pulled, address(this));
        }
        emit Rebalanced(sent, pulled, usdc.balanceOf(address(this)));
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address newImpl) internal override restricted {}
}
