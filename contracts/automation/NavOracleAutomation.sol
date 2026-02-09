// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILossManager} from "../interfaces/ILossManager.sol";
import {IVault} from "../interfaces/IVault.sol";

/// @title NAV oracle automation
/// @notice Stores oracle NAV snapshots with a veto window, then applies yield or loss via Automation.
/// @dev submitNav is AccessManaged; map it to ORACLE_ROLE in AccessManager, and grant this contract
///      a role that can call Vault.distributeYield and LossManager.applyLoss. NAV is USDC (6d).
/// @dev Trust model: submitted NAV is trusted oracle input. This contract does not validate NAV truthfulness,
///      it only enforces role-gated submission and optional veto delay before applying protocol accounting.
contract NavOracleAutomation is AutomationCompatibleInterface, AccessManaged {
    uint256 public constant SCALE = 1e12; // MZUSD 18d -> USDC 6d
    uint256 public constant MAX_VETO_PERIOD = 5 days;

    IERC20 public immutable mzusd;
    address public immutable vault;
    address public immutable lossManager;

    // Packed storage:
    // slot 0: pendingDeltaUSDC (16 bytes) + pendingReadyAt (8 bytes) + pendingIsYield (1 byte) + vetoPeriod (4 bytes)
    // uint128 comfortably covers practical USDC (6d) deltas with wide headroom.
    uint128 public pendingDeltaUSDC;
    // uint64 timestamp and uint32 durations match protocol style (Vault epoch config) and are ample.
    uint64 public pendingReadyAt;
    // Direction is stored separately to avoid signed-int casts/abs math during upkeep execution.
    bool public pendingIsYield;
    uint32 public vetoPeriod;

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

    error PendingNavExists();
    error NoPendingNav();
    error NotReady(uint256 readyAt);
    error InvalidVetoPeriod();
    error ValueTooLarge();
    error ZeroAddress();

    constructor(
        address accessManager,
        address mzusd_,
        address vault_,
        address lossManager_,
        uint256 vetoPeriod_
    ) AccessManaged(accessManager) {
        if (
            accessManager == address(0) ||
            mzusd_ == address(0) ||
            vault_ == address(0) ||
            lossManager_ == address(0)
        ) {
            revert ZeroAddress();
        }
        mzusd = IERC20(mzusd_);
        vault = vault_;
        lossManager = lossManager_;
        _setVetoPeriod(vetoPeriod_);
    }

    /// @notice Submit a NAV snapshot (USDC 6 decimals) and record total supply.
    /// @dev Reverts if a pending NAV exists. If vetoPeriod is 0, applies immediately.
    /// @param navUSDC NAV snapshot in USDC (6 decimals).
    function submitNav(uint256 navUSDC) external restricted {
        if (hasPendingNav()) revert PendingNavExists();

        // aderyn-fp-next-line(reentrancy-state-change)
        uint256 totalSupplyMZ = mzusd.totalSupply();
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

    /// @notice Rejects the pending NAV snapshot during the veto window.
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

    /// @notice Chainlink Automation check: pending NAV exists and veto period elapsed.
    /// @param checkData Unused; kept only for Chainlink Automation compatibility.
    /// @return upkeepNeeded True when a pending NAV exists and veto delay elapsed.
    /// @return performData Empty; action is derived from on-chain state in performUpkeep.
    function checkUpkeep(
        bytes calldata checkData
    ) external view returns (bool upkeepNeeded, bytes memory performData) {
        checkData;
        if (!hasPendingNav()) return (false, "");
        if (block.timestamp < pendingReadyAt) return (false, "");
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

    /// @dev External calls to Vault/LossManager; pending state cleared afterward.
    function _applyPending() internal {
        bool isYield = pendingIsYield;
        uint256 deltaUSDC = pendingDeltaUSDC;
        uint256 readyAt = pendingReadyAt;

        if (isYield) {
            IVault(vault).distributeYield(deltaUSDC);
        } else {
            ILossManager(lossManager).applyLoss(deltaUSDC);
        }

        emit NavApplied(isYield, deltaUSDC, readyAt);
        _clearPending();
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
}
