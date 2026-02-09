// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {IPauseManager} from "./IPauseManager.sol";
import {PauseCategory} from "./PauseCategory.sol";

/// @title PauseManagedUpgradeable
/// @notice Base contract for category-based pause checks via PauseManager.
/// @dev PauseManager address is configured once during initialization in v1.
///      Rotation is not exposed by this base contract and must be designed explicitly if needed.
abstract contract PauseManagedUpgradeable is Initializable {
    /// @dev Kept private to avoid direct state mutation from inheritors; use pauseManager() getter for reads.
    IPauseManager private _pauseManager;

    event PauseManagerUpdated(address indexed newManager);

    error PauseManagerZeroAddress();
    error CategoryPaused(PauseCategory category);

    /// @notice Initialize PauseManaged with a PauseManager address.
    /// @dev One-time wiring in v1; no public/external setter is provided for post-init replacement.
    function __PauseManaged_init(address pauseManager_) internal onlyInitializing {
        _setPauseManager(pauseManager_);
    }

    /// @notice Returns the current PauseManager address.
    /// @dev Exposed for integrations and cross-contract consistency checks.
    function pauseManager() public view returns (address) {
        return address(_pauseManager);
    }

    /// @notice Internal setter for PauseManager address.
    function _setPauseManager(address pauseManager_) internal {
        if (pauseManager_ == address(0)) revert PauseManagerZeroAddress();
        _pauseManager = IPauseManager(pauseManager_);
        emit PauseManagerUpdated(pauseManager_);
    }

    /// @notice Reverts if a category is paused (global or per-contract).
    modifier whenNotPaused(PauseCategory category) {
        if (_pauseManager.isPaused(address(this), category)) {
            revert CategoryPaused(category);
        }
        _;
    }

    uint256[49] private __gap;
}
