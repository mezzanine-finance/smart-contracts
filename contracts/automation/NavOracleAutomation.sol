// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILossManager} from "../interfaces/ILossManager.sol";
import {IMZUSD} from "../interfaces/IMZUSD.sol";
import {ITranche} from "../interfaces/ITranche.sol";
import {IVault} from "../interfaces/IVault.sol";
import {IPauseManager} from "../pause/IPauseManager.sol";
import {PauseCategory} from "../pause/PauseCategory.sol";

/// @title NAV oracle automation
/// @notice Stores oracle NAV snapshots with a veto window, then applies yield or loss via Automation.
/// @dev submitNav is AccessManaged; map it to ORACLE_ROLE in AccessManager, and grant this contract
///      a role that can call IssuanceVault.distributeYield and LossManager.applyLoss. NAV is USDC (6d).
/// @dev Trust model: submitted NAV is trusted oracle input. This contract does not validate NAV truthfulness,
///      it only enforces role-gated submission and optional veto delay before applying protocol accounting.
/// @dev The oracle uses a multi-package oracle solution by Redstone to retrieve NAV and Total Supply simultaoneusly.
/** @dev Description of the oracle solution:
 * Related RedStone feeds can be bundled into a single multi-point package and are then treated as one atomic update unit.
 *
 * Mechanism:
 * - On the node side, prices for both tokens are fetched separately.
 * - They are then combined into a single multi-point package signed once as one payload.
 * - Both the individual feeds and the combined package are broadcast to the Data Distribution Layer.
 * - On the relayer side, an additional guard ensures that feeds belonging to the same package cannot be updated independently on-chain.
 *
 * Guarantee:
 * - If two feeds are packaged together, either both are updated or neither is.
 * - If any token is missing from the multi-point package for any reason, the relayer skips the update for all feeds in that package.
 */
contract NavOracleAutomation is AutomationCompatibleInterface, AccessManaged {
    uint256 public constant ORACLE_SCALE = 1e2; // oracle answers (8d) -> USDC (6d)
    uint256 public constant MAX_VETO_PERIOD = 5 days;
    uint32 public constant DEFAULT_MAX_ANSWER_STALENESS = 30 minutes;
    address private constant VIRTUAL_SHARES_RECEIVER = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable mzusd;
    address public immutable vault;
    address public immutable lossManager;
    IPauseManager public immutable pauseManager;
    AggregatorV3Interface public navOracle;
    AggregatorV3Interface public totalSupplyOracle;

    // Packed storage (31 bytes → 1 slot):
    // pendingDeltaUSDC (16) + pendingReadyAt (6) + pendingIsYield (1)
    // + vetoPeriod (4) + maxAnswerStaleness (4)
    // uint128 comfortably covers practical USDC (6d) deltas with wide headroom.
    uint128 public pendingDeltaUSDC;
    // uint48 timestamp is ample for ~8.9 million years; fits in one slot with surrounding fields.
    uint48 public pendingReadyAt;
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
    error OraclesNotInSync();
    error ValueTooLarge();
    error ZeroAddress();
    error SameValue();

    /// @notice Wire NAV oracle automation to the LossManager and set the initial veto period.
    /// @param lossManager_ LossManager address; its MZUSD/vault/authority references are inherited.
    /// @param vetoPeriod_ Initial veto period in seconds applied to pending NAV submissions.
    constructor(
        address lossManager_,
        uint256 vetoPeriod_
    ) AccessManaged(_resolveAuthority(lossManager_)) {
        ILossManager manager = ILossManager(lossManager_);
        address vault_ = manager.vault();
        address mzusd_ = manager.mzusd();

        address pauseManager_ = IMZUSD(mzusd_).pauseManager();
        if (pauseManager_ == address(0)) revert ZeroAddress();

        mzusd = IERC20(mzusd_);
        vault = vault_;
        lossManager = lossManager_;
        pauseManager = IPauseManager(pauseManager_);
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

        (bool isYield, uint256 deltaUSDC) = _deltaUSDC(navUSDC, totalSupplyMZ);

        uint48 submittedAt = uint48(block.timestamp);
        uint256 readyAt = uint256(submittedAt) + uint256(vetoPeriod);

        if (deltaUSDC > type(uint128).max) revert ValueTooLarge();
        pendingDeltaUSDC = uint128(deltaUSDC);
        // Snapshot readiness for this pending NAV; changing vetoPeriod later
        // does not shift already submitted snapshots.
        pendingReadyAt = uint48(readyAt);
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
        if (uint256(vetoPeriod) == newPeriod) revert SameValue();
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
        if (maxAnswerStaleness == newMaxAnswerStaleness) revert SameValue();
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

        // Both paths touch the vault (distributeYield directly, applyLoss via advanceEpoch),
        // so a PROTOCOL pause on the vault blocks either action.
        if (pauseManager.isPaused(vault, PauseCategory.PROTOCOL)) return (false, "");

        // Both paths also touch MZUSD under a PROTOCOL pause guard: distributeYield mints
        // MZUSD, while applyLoss burns it. A PROTOCOL pause on MZUSD blocks either action.
        if (pauseManager.isPaused(address(mzusd), PauseCategory.PROTOCOL)) return (false, "");

        if (pendingIsYield) {
            // distributeYield reverts when no tranches are registered, and the allocation step
            // reverts with TVLZero when no tranche contributes eligible TVL. Mirror the same
            // skip filter that IssuanceVault._allocateYieldToTranches applies: a tranche must
            // be enabled, have at least one share held outside VIRTUAL_SHARES_RECEIVER, and not
            // be PROTOCOL-paused, otherwise its totalAssets are excluded from eligible TVL.
            uint256 trancheCount = v.tranchesLength();
            if (trancheCount == 0) return (false, "");
            (address[] memory order, , bool[] memory enabled) = v.getTranches(0, trancheCount);
            uint256 totalTvl;
            for (uint256 i; i < trancheCount; ++i) {
                address tr = order[i];
                if (
                    !enabled[i] ||
                    IERC20(tr).totalSupply() == IERC20(tr).balanceOf(VIRTUAL_SHARES_RECEIVER) ||
                    pauseManager.isPaused(tr, PauseCategory.PROTOCOL)
                ) continue;
                totalTvl += ITranche(tr).totalAssets();
            }
            if (totalTvl == 0) return (false, "");
        } else {
            // applyLoss checks PROTOCOL pause on the LossManager.
            if (pauseManager.isPaused(lossManager, PauseCategory.PROTOCOL)) return (false, "");
            // applyLoss reverts when the loss exceeds the per-tx cap.
            uint256 maxLoss = ILossManager(lossManager).maxLossPerTxUSDC();
            if (maxLoss != 0 && pendingDeltaUSDC > maxLoss) return (false, "");
        }

        return (true, "");
    }

    /// @notice Applies pending NAV after the veto period.
    /// @param performData Unused; kept only for Chainlink Automation compatibility.
    /// @dev Action is derived from on-chain state to avoid data manipulation via calldata.
    function performUpkeep(bytes calldata performData) external restricted {
        performData;
        if (!hasPendingNav()) revert NoPendingNav();
        uint256 readyAt = pendingReadyAt;
        if (block.timestamp < readyAt) revert NotReady(readyAt);
        _applyPending();
    }

    /// @notice Returns true when a NAV snapshot is currently pending.
    /// @return True if a pending NAV exists (pendingReadyAt != 0).
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

    /// @dev Both `nav` and `totalSupply` are oracle answers reported with 8 decimals in the
    ///      same USD-denominated unit, so the delta is taken in 8-decimal space and only then
    ///      scaled down to USDC (6 decimals). Rounding stays conservative: yield rounds down
    ///      (distribute no more than covered) and loss rounds up (never under-apply a loss).
    function _deltaUSDC(
        uint256 nav,
        uint256 totalSupply
    ) internal pure returns (bool isYield, uint256 deltaUSDC) {
        if (nav >= totalSupply) {
            isYield = true;
            deltaUSDC = (nav - totalSupply) / ORACLE_SCALE;
        } else {
            isYield = false;
            deltaUSDC = (totalSupply - nav + ORACLE_SCALE - 1) / ORACLE_SCALE;
        }
    }

    function _clearPending() internal {
        pendingDeltaUSDC = 0;
        pendingReadyAt = 0;
        pendingIsYield = false;
    }

    function _setVetoPeriod(uint256 newPeriod) internal {
        if (newPeriod > MAX_VETO_PERIOD) revert InvalidVetoPeriod();
        _assertStalenessBound(maxAnswerStaleness, newPeriod);
        vetoPeriod = uint32(newPeriod);
    }

    function _setMaxAnswerStaleness(uint32 newMaxAnswerStaleness) internal {
        if (newMaxAnswerStaleness == 0) revert InvalidAnswerStaleness();
        _assertStalenessBound(newMaxAnswerStaleness, vetoPeriod);
        maxAnswerStaleness = newMaxAnswerStaleness;
    }

    /// @dev Enforces `staleness < max(veto, epochDuration)` so that same report
    ///      can't be applied in different epochs.
    function _assertStalenessBound(uint256 staleness, uint256 veto) internal view {
        uint256 epochDur = IVault(vault).epochDuration();
        uint256 bound = veto > epochDur ? veto : epochDur;
        if (staleness >= bound) revert InvalidAnswerStaleness();
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
        // Both oracles should always be updated in the same transaction
        if (navUpdatedAt != supplyUpdatedAt) revert OraclesNotInSync();
        totalSupplyMZ = uint256(supplyAnswer);
    }
}
