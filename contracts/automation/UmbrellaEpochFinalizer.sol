// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import {ITranche} from "../interfaces/ITranche.sol";
import {IVault} from "../interfaces/IVault.sol";

/// @title Umbrella epoch finalizer
/// @notice Chainlink Automation helper that advances an epoch cursor and finalizes when needed.
/// @dev By design this processes at most one epoch per upkeep tx. If there is a backlog,
/// each missed epoch consumes one upkeep transaction until the cursor catches up.
contract UmbrellaEpochFinalizer is AutomationCompatibleInterface {
    uint256 public constant MIN_EPOCH_ID = 1;

    /// @notice Tranche that this finalizer services.
    ITranche public immutable tranche;
    /// @notice Next epoch id that keeper scan starts from.
    uint256 public nextEpochId;

    error NoWork();
    error InvalidState();
    error ZeroAddress();
    error InvalidEpoch();

    /// @param tranche_ Tranche served by this automation helper.
    /// @param startEpoch_ Initial cursor epoch.
    /// @dev Start cursor selection is operationally sensitive:
    /// set it higher than the oldest unfinalized epoch only if intentional,
    /// otherwise older epochs can be skipped by this helper.
    constructor(address tranche_, uint256 startEpoch_) {
        if (tranche_ == address(0)) revert ZeroAddress();
        if (startEpoch_ < MIN_EPOCH_ID) revert InvalidEpoch();
        tranche = ITranche(tranche_);
        nextEpochId = startEpoch_;
    }

    /// @notice Checks whether upkeep should process the current cursor epoch.
    /// @param checkData Unused; kept only for Chainlink Automation compatibility.
    /// @return upkeepNeeded True when cursor is behind current epoch (either finalize or advance step is needed).
    /// @return performData Empty; action is derived from on-chain state in performUpkeep.
    function checkUpkeep(
        bytes calldata checkData
    ) external view returns (bool upkeepNeeded, bytes memory performData) {
        checkData;
        address vault = tranche.vault();
        uint256 current = IVault(vault).currentEpochId();
        if (current <= 1) return (false, "");
        if (nextEpochId >= current) return (false, "");
        return (true, "");
    }

    /// @notice Finalizes cursor epoch if needed, otherwise advances cursor by one epoch.
    /// @param performData Unused; kept only for Chainlink Automation compatibility.
    /// @dev Action is derived from on-chain state to avoid data manipulation via calldata.
    function performUpkeep(bytes calldata performData) external {
        performData;
        address vault = tranche.vault();
        uint256 current = IVault(vault).currentEpochId();
        if (current <= 1) revert InvalidState();
        if (nextEpochId >= current) revert NoWork();
        if (tranche.umbrellaSharesByEpoch(nextEpochId) > 0) {
            tranche.finalizeEpoch(nextEpochId);
        }
        ++nextEpochId;
    }
}
