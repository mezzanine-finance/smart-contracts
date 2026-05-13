// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IPauseManager} from "./IPauseManager.sol";
import {PauseCategory} from "./PauseCategory.sol";

/// @title PauseManager
/// @notice Centralized pause registry with per-category global and per-contract switches.
/// @dev All categories are enabled by default and can be paused via AccessManager-controlled calls.
///      Pause and unpause are separate methods so AccessManager can enforce different delays.
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract PauseManager is AccessManagedUpgradeable, UUPSUpgradeable, IPauseManager {
    mapping(PauseCategory => bool) private _globalPaused;
    mapping(address => mapping(PauseCategory => bool)) private _contractPaused;

    event GlobalPauseSet(PauseCategory indexed category, bool paused, address indexed caller);
    event ContractPauseSet(
        address indexed target,
        PauseCategory indexed category,
        bool paused,
        address indexed caller
    );

    error ZeroAddress();
    error AlreadyPaused(PauseCategory category);
    error AlreadyUnpaused(PauseCategory category);
    error ContractAlreadyPaused(address target, PauseCategory category);
    error ContractAlreadyUnpaused(address target, PauseCategory category);

    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the PauseManager.
    /// @param accessManager AccessManager address for pause authorization; must be non-zero.
    function initialize(address accessManager) external initializer {
        if (accessManager == address(0)) revert ZeroAddress();
        __AccessManaged_init(accessManager);
    }

    /// @notice Returns true when the category is paused for the target.
    /// @param target Contract address to check.
    /// @param category Pause category to check.
    /// @return True if globally paused or contract-specifically paused for the category.
    /// @dev Global pause takes precedence over contract-specific pause.
    function isPaused(address target, PauseCategory category) external view returns (bool) {
        if (_globalPaused[category]) return true;
        return _contractPaused[target][category];
    }

    /// @notice Returns true if a category is paused globally.
    /// @param category Pause category to check.
    /// @return True if the category is globally paused.
    function globalPaused(PauseCategory category) external view returns (bool) {
        return _globalPaused[category];
    }

    /// @notice Returns true if a category is paused for a specific contract.
    /// @param target Contract address to check.
    /// @param category Pause category to check.
    /// @return True if the category is paused for the specific contract.
    function contractPaused(address target, PauseCategory category) external view returns (bool) {
        return _contractPaused[target][category];
    }

    /// @notice Pause a category for all contracts.
    /// @param category Pause category to activate.
    function pauseGlobal(PauseCategory category) external restricted {
        if (_globalPaused[category]) revert AlreadyPaused(category);
        _globalPaused[category] = true;
        emit GlobalPauseSet(category, true, msg.sender);
    }

    /// @notice Unpause a category for all contracts.
    /// @param category Pause category to deactivate.
    /// @dev Configure AccessManager with an execution delay for this method.
    function unpauseGlobal(PauseCategory category) external restricted {
        if (!_globalPaused[category]) revert AlreadyUnpaused(category);
        _globalPaused[category] = false;
        emit GlobalPauseSet(category, false, msg.sender);
    }

    /// @notice Pause a category for a specific contract.
    /// @param target Contract address to pause; must be non-zero.
    /// @param category Pause category to activate.
    function pauseContract(address target, PauseCategory category) external restricted {
        if (target == address(0)) revert ZeroAddress();
        if (_contractPaused[target][category]) revert ContractAlreadyPaused(target, category);
        _contractPaused[target][category] = true;
        emit ContractPauseSet(target, category, true, msg.sender);
    }

    /// @notice Unpause a category for a specific contract.
    /// @param target Contract address to unpause; must be non-zero.
    /// @param category Pause category to deactivate.
    /// @dev Configure AccessManager with an execution delay for this method.
    function unpauseContract(address target, PauseCategory category) external restricted {
        if (target == address(0)) revert ZeroAddress();
        if (!_contractPaused[target][category]) revert ContractAlreadyUnpaused(target, category);
        _contractPaused[target][category] = false;
        emit ContractPauseSet(target, category, false, msg.sender);
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
