// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";

// aderyn-fp-next-line(reused-contract-name)
interface IVault {
    function currentEpochId() external view returns (uint256);
}

// aderyn-fp-next-line(reused-contract-name)
interface ITranche {
    function vault() external view returns (address);
    function umbrellaSharesByEpoch(uint256) external view returns (uint256);
    function finalizedEpochs(
        uint256
    ) external view returns (uint256 totalShares, uint256 totalAssets, bool isFinalized);
    function finalizeEpoch(uint256) external;
}

/// @title Umbrella epoch finalizer
/// @notice Chainlink Automation-style helper that finalizes the previous epoch on a tranche.
contract UmbrellaEpochFinalizer is AutomationCompatibleInterface {
    /// @notice Tranche that this finalizer services.
    address public immutable TRANCHE;

    error NoWork();
    error StaleEpoch();
    error InvalidState();
    error ZeroAddress();

    constructor(address tranche_) {
        if (tranche_ == address(0)) revert ZeroAddress();
        TRANCHE = tranche_;
    }

    /// @notice Checks whether the previous epoch is ready to be finalized.
    /// @dev Parameter is an unused data passed by Automation.
    /// @return upkeepNeeded True when the previous epoch has umbrella shares and is not finalized.
    /// @return performData ABI-encoded epochId to finalize.
    function checkUpkeep(
        bytes calldata /* checkData */
    ) external view returns (bool upkeepNeeded, bytes memory performData) {
        address vault = ITranche(TRANCHE).vault();
        uint256 current = IVault(vault).currentEpochId();
        if (current <= 1) return (false, "");

        uint256 candidate = current - 1;
        if (ITranche(TRANCHE).umbrellaSharesByEpoch(candidate) == 0) return (false, "");

        (, , bool isFinalized) = ITranche(TRANCHE).finalizedEpochs(candidate);
        if (isFinalized) return (false, "");

        return (true, abi.encode(candidate));
    }

    /// @notice Finalizes the previous epoch if still eligible.
    /// @param performData ABI-encoded epochId from checkUpkeep.
    function performUpkeep(bytes calldata performData) external {
        uint256 epochId = abi.decode(performData, (uint256));

        address vault = ITranche(TRANCHE).vault();
        uint256 current = IVault(vault).currentEpochId();
        if (current <= 1) revert InvalidState();

        uint256 candidate = current - 1;
        if (epochId != candidate) revert StaleEpoch();

        if (ITranche(TRANCHE).umbrellaSharesByEpoch(candidate) == 0) revert NoWork();

        (, , bool isFinalized) = ITranche(TRANCHE).finalizedEpochs(candidate);
        if (isFinalized) revert NoWork();

        ITranche(TRANCHE).finalizeEpoch(epochId);
    }
}
