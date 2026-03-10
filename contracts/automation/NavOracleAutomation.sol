// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILossManager} from "../interfaces/ILossManager.sol";
import {IMZUSD} from "../interfaces/IMZUSD.sol";
import {IVault} from "../interfaces/IVault.sol";

/// @title NAV oracle automation
/// @notice Stores oracle NAV snapshots with a veto window, then applies yield or loss via Automation.
/// @dev submitNav is AccessManaged; map it to ORACLE_ROLE in AccessManager, and grant this contract
///      a role that can call IssuanceVault.distributeYield and LossManager.applyLoss. NAV is USDC (6d).
/// @dev Trust model: submitted NAV is trusted oracle input. This contract does not validate NAV truthfulness,
///      it only enforces role-gated submission and optional veto delay before applying protocol accounting.
contract NavOracleAutomation is AutomationCompatibleInterface, AccessManaged {
    uint256 public constant SCALE = 1e12; // MZUSD 18d -> USDC 6d
    uint256 public constant MAX_VETO_PERIOD = 5 days;
    uint32 public constant DEFAULT_MAX_ANSWER_STALENESS = 1 hours;

    IERC20 public immutable mzusd;
    address public immutable vault;
    address public immutable lossManager;
    AggregatorV3Interface public navOracle;
    AggregatorV3Interface public totalSupplyOracle;

    // Packed storage:
    // slot 0: pendingDeltaUSDC (16 bytes) + pendingReadyAt (8 bytes) + pendingIsYield (1 byte)
    //         + vetoPeriod (4 bytes) + maxAnswerStaleness (4 bytes)
    // uint128 comfortably covers practical USDC (6d) deltas with wide headroom.
    uint128 public pendingDeltaUSDC;
    // uint64 timestamp and uint32 durations match protocol style (IssuanceVault epoch config) and are ample.
    uint64 public pendingReadyAt;
    // Direction is stored separately to avoid signed-int casts/abs math during upkeep execution.
    bool public pendingIsYield;
    uint32 public vetoPeriod;
    uint32 public maxAnswerStaleness;

    event NavSubmitted(
        uint256 navUSDC,
        uint256 totalSupplyMZ,
        bool isYield,
        uint256 deltaUSDC,
        uint256 submittedAt,
        uint256 readyAt
    );
    event NavRejected(bool isYield, uint256 deltaUSDC, uint256 readyAt);
    event NavApplied(bool isYield, uint256 deltaUSDC, uint256 readyAt);
    event VetoPeriodUpdated(uint256 newPeriod);
    event OraclesUpdated(address indexed navOracle, address indexed totalSupplyOracle);
    event MaxAnswerStalenessUpdated(uint256 newMaxAnswerStaleness);

    error PendingNavExists();
    error NoPendingNav();
    error NotReady(uint256 readyAt);
    error InvalidVetoPeriod();
    error InvalidAnswerStaleness();
    error InvalidOracleAnswer(int256 answer);
    error InvalidOracleTimestamp(address oracle, uint256 updatedAt);
    error StaleOracleAnswer(
        address oracle,
        uint256 updatedAt,
        uint256 currentTimestamp,
        uint256 maxAnswerStaleness
    );
    error ValueTooLarge();
    error ZeroAddress();

    constructor(
        address lossManager_,
        uint256 vetoPeriod_
    ) AccessManaged(_resolveAuthority(lossManager_)) {
        ILossManager manager = ILossManager(lossManager_);
        address vault_ = manager.vault();
        address mzusd_ = manager.mzusd();

        mzusd = IERC20(mzusd_);
        vault = vault_;
        lossManager = lossManager_;
        _setVetoPeriod(vetoPeriod_);
        _setMaxAnswerStaleness(DEFAULT_MAX_ANSWER_STALENESS);
    }

    function _resolveAuthority(address lossManager_) private view returns (address accessManager) {
        address mzusd_ = ILossManager(lossManager_).mzusd();
        accessManager = IMZUSD(mzusd_).authority();
        if (accessManager == address(0)) revert ZeroAddress();
    }

    /// @notice Submit NAV and total supply snapshots from oracle feeds.
    /// @dev Reverts if a pending NAV exists. If vetoPeriod is 0, applies immediately.
    function submitNav() external restricted {
        if (hasPendingNav()) revert PendingNavExists();

        (uint256 navUSDC, uint256 totalSupplyMZ) = _readFreshAnswer(navOracle, totalSupplyOracle);
        if (block.timestamp > type(uint64).max) {
            revert ValueTooLarge();
        }
        (bool isYield, uint256 deltaUSDC) = _deltaUSDC(navUSDC, totalSupplyMZ);

        uint64 submittedAt = uint64(block.timestamp);
        uint256 readyAt = uint256(submittedAt) + uint256(vetoPeriod);
        if (readyAt > type(uint64).max) revert ValueTooLarge();

        if (deltaUSDC > type(uint128).max) revert ValueTooLarge();
        pendingDeltaUSDC = uint128(deltaUSDC);
        // Snapshot readiness for this pending NAV; changing vetoPeriod later
        // does not shift already submitted snapshots.
        pendingReadyAt = uint64(readyAt);
        pendingIsYield = isYield;

        emit NavSubmitted(navUSDC, totalSupplyMZ, isYield, deltaUSDC, submittedAt, readyAt);

        if (vetoPeriod == 0) {
            _applyPending();
        }
    }

    /// @notice Rejects the pending NAV snapshot during the veto window or before NAV is applied.
    function rejectPendingNav() external restricted {
        if (!hasPendingNav()) revert NoPendingNav();
        emit NavRejected(pendingIsYield, pendingDeltaUSDC, pendingReadyAt);
        _clearPending();
    }

    /// @notice Update the veto period for future submissions.
    /// @param newPeriod New veto period in seconds.
    function setVetoPeriod(uint256 newPeriod) external restricted {
        _setVetoPeriod(newPeriod);
        emit VetoPeriodUpdated(newPeriod);
    }

    /// @notice Update NAV and total supply oracle data feed addresses.
    /// @param newNavOracle Address of AggregatorV3-compatible NAV oracle.
    /// @param newTotalSupplyOracle Address of AggregatorV3-compatible total supply oracle.
    function setOracles(address newNavOracle, address newTotalSupplyOracle) external restricted {
        if (newNavOracle == address(0)) revert ZeroAddress();
        if (newTotalSupplyOracle == address(0)) revert ZeroAddress();
        navOracle = AggregatorV3Interface(newNavOracle);
        totalSupplyOracle = AggregatorV3Interface(newTotalSupplyOracle);
        emit OraclesUpdated(newNavOracle, newTotalSupplyOracle);
    }

    /// @notice Set maximum accepted oracle answer age.
    /// @param newMaxAnswerStaleness Maximum staleness in seconds.
    function setMaxAnswerStaleness(uint32 newMaxAnswerStaleness) external restricted {
        _setMaxAnswerStaleness(newMaxAnswerStaleness);
        emit MaxAnswerStalenessUpdated(newMaxAnswerStaleness);
    }

    /// @notice Chainlink Automation check: pending NAV exists, veto period elapsed,
    ///         and downstream calls will not revert.
    /// @param checkData Unused; kept only for Chainlink Automation compatibility.
    /// @return upkeepNeeded True when a pending NAV is ready and can be applied without reverting.
    /// @return performData Empty; action is derived from on-chain state in performUpkeep.
    function checkUpkeep(
        bytes calldata checkData
    ) external view returns (bool upkeepNeeded, bytes memory performData) {
        checkData;
        if (!hasPendingNav()) return (false, "");
        if (block.timestamp < pendingReadyAt) return (false, "");

        // Both distributeYield and applyLoss advance the epoch, which reverts if
        // the current epoch has not fully elapsed yet.
        IVault v = IVault(vault);
        if (block.timestamp < v.epochStart() + v.epochDuration()) return (false, "");

        if (pendingIsYield) {
            // distributeYield reverts when no tranches are registered.
            if (v.getTrancheOrder().length == 0) return (false, "");
        } else {
            // applyLoss reverts when the loss exceeds the per-tx cap.
            uint256 maxLoss = ILossManager(lossManager).maxLossPerTxUSDC();
            if (maxLoss != 0 && pendingDeltaUSDC > maxLoss) return (false, "");
        }

        return (true, "");
    }

    /// @notice Applies pending NAV after the veto period.
    /// @param performData Unused; kept only for Chainlink Automation compatibility.
    /// @dev Action is derived from on-chain state to avoid data manipulation via calldata.
    function performUpkeep(bytes calldata performData) external {
        performData;
        if (!hasPendingNav()) revert NoPendingNav();
        uint256 readyAt = pendingReadyAt;
        if (block.timestamp < readyAt) revert NotReady(readyAt);
        _applyPending();
    }

    /// @notice Returns true when a NAV snapshot is currently pending.
    /// @dev Kept as an explicit getter for external integrations.
    function hasPendingNav() public view returns (bool) {
        return pendingReadyAt != 0;
    }

    /// @dev External calls to IssuanceVault/LossManager; pending state is cleared first
    function _applyPending() internal {
        bool isYield = pendingIsYield;
        uint256 deltaUSDC = pendingDeltaUSDC;
        uint256 readyAt = pendingReadyAt;

        _clearPending();

        if (isYield) {
            IVault(vault).distributeYield(deltaUSDC);
        } else {
            ILossManager(lossManager).applyLoss(deltaUSDC);
        }

        emit NavApplied(isYield, deltaUSDC, readyAt);
    }

    function _deltaUSDC(
        uint256 navUSDC,
        uint256 totalSupplyMZ
    ) internal pure returns (bool isYield, uint256 deltaUSDC) {
        uint256 totalSupplyUSDC = totalSupplyMZ / SCALE;
        if (navUSDC >= totalSupplyUSDC) {
            isYield = true;
            deltaUSDC = navUSDC - totalSupplyUSDC;
        } else {
            isYield = false;
            deltaUSDC = totalSupplyUSDC - navUSDC;
        }
    }

    function _clearPending() internal {
        pendingDeltaUSDC = 0;
        pendingReadyAt = 0;
        pendingIsYield = false;
    }

    function _setVetoPeriod(uint256 newPeriod) internal {
        if (newPeriod > MAX_VETO_PERIOD) revert InvalidVetoPeriod();
        vetoPeriod = uint32(newPeriod);
    }

    function _setMaxAnswerStaleness(uint32 newMaxAnswerStaleness) internal {
        if (newMaxAnswerStaleness == 0) revert InvalidAnswerStaleness();
        maxAnswerStaleness = newMaxAnswerStaleness;
    }

    function _readFreshAnswer(
        AggregatorV3Interface navOracle_,
        AggregatorV3Interface totalSupplyOracle_
    ) internal view returns (uint256 navUSDC, uint256 totalSupplyMZ) {
        if (address(navOracle_) == address(0)) revert ZeroAddress();
        if (address(totalSupplyOracle_) == address(0)) revert ZeroAddress();

        (, int256 navAnswer, , uint256 navUpdatedAt, ) = navOracle_.latestRoundData();
        if (navAnswer <= 0) revert InvalidOracleAnswer(navAnswer);
        if (navUpdatedAt == 0 || navUpdatedAt > block.timestamp) {
            revert InvalidOracleTimestamp(address(navOracle_), navUpdatedAt);
        }
        if (block.timestamp - navUpdatedAt > uint256(maxAnswerStaleness)) {
            revert StaleOracleAnswer(
                address(navOracle_),
                navUpdatedAt,
                block.timestamp,
                maxAnswerStaleness
            );
        }
        navUSDC = uint256(navAnswer);

        (, int256 supplyAnswer, , uint256 supplyUpdatedAt, ) = totalSupplyOracle_.latestRoundData();
        if (supplyAnswer <= 0) revert InvalidOracleAnswer(supplyAnswer);
        if (supplyUpdatedAt == 0 || supplyUpdatedAt > block.timestamp) {
            revert InvalidOracleTimestamp(address(totalSupplyOracle_), supplyUpdatedAt);
        }
        if (block.timestamp - supplyUpdatedAt > uint256(maxAnswerStaleness)) {
            revert StaleOracleAnswer(
                address(totalSupplyOracle_),
                supplyUpdatedAt,
                block.timestamp,
                maxAnswerStaleness
            );
        }
        totalSupplyMZ = uint256(supplyAnswer);
    }
}
