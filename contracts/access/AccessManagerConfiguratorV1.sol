// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

// aderyn-fp-next-line(reused-contract-name)
interface IAccessManagerMinimal {
    function ADMIN_ROLE() external view returns (uint64 roleId);
    function grantRole(uint64 roleId, address account, uint32 executionDelay) external;
    function revokeRole(uint64 roleId, address account) external;
    function setTargetFunctionRole(
        address target,
        bytes4[] calldata selectors,
        uint64 roleId
    ) external;
    function setGrantDelay(uint64 roleId, uint32 newDelay) external;
}

interface IEmergencyLevelManager {
    function syncLevel() external;
    function escalateTo(uint8 newLevel) external;
    function relaxTo(uint8 newLevel) external;
}

/// @title AccessManagerConfiguratorV1
/// @notice Bootstraps AccessManager delays and role grants for EmergencyLevels v1.
/// @dev Designed for one-time use during deployment.
contract AccessManagerConfiguratorV1 {
    uint64 public constant VAULT_WITHDRAW_ROLE = 1;
    uint64 public constant VAULT_ROLE = 2;
    uint64 public constant LOSS_MANAGER_ROLE = 3;
    uint64 public constant UPGRADE_ROLE = 4;
    uint64 public constant PROTOCOL_ADMIN_ROLE = 5;

    uint64 public constant EMERGENCY_ESCALATE_ROLE = 100;
    uint64 public constant EMERGENCY_RELAX_ROLE = 101;

    address public immutable owner;
    bool public configured;

    error NotOwner();
    error AlreadyConfigured();
    error ZeroAddress();
    error EmptyTranches();
    error InvalidDelay();
    event Configured(address accessManager, address controller);

    // aderyn-fp-next-line(modifier-used-only-once)
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    /// @notice Configure AccessManager and apply L0 rules via the controller.
    /// @dev Admin operations are slowed via ADMIN_ROLE execution delay and grant delays,
    ///      while target admin delays stay at defaults to keep emergency escalation fast.
    /// @param accessManager Address of the AccessManager instance.
    /// @param controller Emergency level controller (EmergencyLevelManager).
    /// @param admin AccessManager admin multisig (has ADMIN_ROLE).
    /// @param guardian Fast-path guardian (escalation only).
    /// @param governor Slow-path governor (relaxation and upgrades).
    /// @param mzusd MZUSD token address.
    /// @param vault Vault address.
    /// @param reservoir Reservoir address.
    /// @param lossManager LossManager address.
    /// @param tranches List of tranche addresses.
    /// @param relaxDelay Seconds for de-escalation delay.
    /// @param upgradeDelay Seconds for upgrade delay.
    /// @param adminDelay Seconds for AccessManager admin operations delay.
    function configure(
        address accessManager,
        address controller,
        address admin,
        address guardian,
        address governor,
        address mzusd,
        address vault,
        address reservoir,
        address lossManager,
        address[] calldata tranches,
        uint32 relaxDelay,
        uint32 upgradeDelay,
        uint32 adminDelay
        // aderyn-fp-next-line(centralization-risk)
    ) external onlyOwner {
        if (configured) revert AlreadyConfigured();
        if (
            accessManager == address(0) ||
            controller == address(0) ||
            admin == address(0) ||
            guardian == address(0) ||
            governor == address(0) ||
            mzusd == address(0) ||
            vault == address(0) ||
            reservoir == address(0) ||
            lossManager == address(0)
        ) {
            revert ZeroAddress();
        }
        if (tranches.length == 0) revert EmptyTranches();
        for (uint256 i = 0; i < tranches.length; i++) {
            if (tranches[i] == address(0)) revert ZeroAddress();
        }
        if (relaxDelay == 0 || upgradeDelay < relaxDelay || adminDelay < upgradeDelay) {
            revert InvalidDelay();
        }

        IAccessManagerMinimal manager = IAccessManagerMinimal(accessManager);
        // aderyn-fp-next-line(reentrancy-state-change)
        uint64 adminRole = manager.ADMIN_ROLE();

        _configureControllerRoles(manager, controller, adminRole);
        _grantProtocolRoles(
            manager,
            adminRole,
            admin,
            guardian,
            governor,
            mzusd,
            vault,
            lossManager,
            relaxDelay,
            upgradeDelay,
            adminDelay
        );
        _setDelays(manager, adminRole, upgradeDelay, adminDelay);
        // aderyn-fp-next-line(reentrancy-state-change)
        IEmergencyLevelManager(controller).syncLevel();
        // aderyn-fp-next-line(reentrancy-state-change)
        manager.revokeRole(adminRole, address(this));
        configured = true;
        emit Configured(accessManager, controller);
    }

    function _configureControllerRoles(
        IAccessManagerMinimal manager,
        address controller,
        uint64 adminRole
    ) internal {
        bytes4[] memory selectors = new bytes4[](1);

        selectors[0] = IEmergencyLevelManager.escalateTo.selector;
        manager.setTargetFunctionRole(controller, selectors, EMERGENCY_ESCALATE_ROLE);

        selectors[0] = IEmergencyLevelManager.relaxTo.selector;
        manager.setTargetFunctionRole(controller, selectors, EMERGENCY_RELAX_ROLE);

        selectors[0] = IEmergencyLevelManager.syncLevel.selector;
        manager.setTargetFunctionRole(controller, selectors, adminRole);

        selectors[0] = UUPSUpgradeable.upgradeToAndCall.selector;
        manager.setTargetFunctionRole(controller, selectors, UPGRADE_ROLE);

        manager.grantRole(adminRole, controller, 0);
    }

    function _grantProtocolRoles(
        IAccessManagerMinimal manager,
        uint64 adminRole,
        address admin,
        address guardian,
        address governor,
        address mzusd,
        address vault,
        address lossManager,
        uint32 relaxDelay,
        uint32 upgradeDelay,
        uint32 adminDelay
    ) internal {
        manager.grantRole(adminRole, admin, adminDelay);
        manager.grantRole(PROTOCOL_ADMIN_ROLE, admin, 0);
        manager.grantRole(EMERGENCY_ESCALATE_ROLE, guardian, 0);
        manager.grantRole(EMERGENCY_RELAX_ROLE, governor, relaxDelay);

        manager.grantRole(VAULT_ROLE, vault, 0);
        manager.grantRole(VAULT_WITHDRAW_ROLE, mzusd, 0);
        manager.grantRole(LOSS_MANAGER_ROLE, lossManager, 0);
        manager.grantRole(UPGRADE_ROLE, governor, upgradeDelay);
    }

    function _setDelays(
        IAccessManagerMinimal manager,
        uint64 adminRole,
        uint32 upgradeDelay,
        uint32 adminDelay
    ) internal {
        manager.setGrantDelay(adminRole, adminDelay);
        manager.setGrantDelay(UPGRADE_ROLE, upgradeDelay);
    }
}
