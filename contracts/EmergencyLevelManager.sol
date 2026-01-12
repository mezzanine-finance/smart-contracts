// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// solhint-disable-next-line max-line-length
import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {EmergencyPolicyV1} from "./EmergencyPolicyV1.sol";

interface IAccessManagerMinimal {
    function setTargetFunctionRole(
        address target,
        bytes4[] calldata selectors,
        uint64 roleId
    ) external;
    function ADMIN_ROLE() external view returns (uint64);
    function PUBLIC_ROLE() external view returns (uint64);
}

/// @title EmergencyLevelManager
/// @notice Applies hardcoded emergency access rules by level via AccessManager.
/// @dev L0 = normal, L1 = ingress paused (egress allowed), L2 = full stop.
contract EmergencyLevelManager is Initializable, AccessManagedUpgradeable, UUPSUpgradeable {
    uint8 public constant MAX_LEVEL = 2;
    uint64 public constant VAULT_WITHDRAW_ROLE = 1;
    uint64 public constant VAULT_ROLE = 2;
    uint64 public constant LOSS_MANAGER_ROLE = 3;
    uint64 public constant UPGRADE_ROLE = 4;
    uint64 public constant PROTOCOL_ADMIN_ROLE = 5;
    uint64 public constant DISABLED_ROLE = type(uint64).max - 1;

    IAccessManagerMinimal public accessManager;
    address public mzusd;
    address public vault;
    address public reservoir;
    address public lossManager;
    address[] public tranches;
    uint8 public currentLevel;

    event LevelChanged(uint8 indexed previousLevel, uint8 indexed newLevel);

    error InvalidLevel(uint8 level);
    error ZeroAddress();
    error EmptyTranches();
    error LevelNotIncreased(uint8 current, uint8 requested);
    error LevelNotDecreased(uint8 current, uint8 requested);
    error InvalidRoleKind();

    function initialize(
        address accessManager_,
        address mzusd_,
        address vault_,
        address reservoir_,
        address lossManager_,
        address[] calldata tranches_,
        uint8 initialLevel
    ) external initializer {
        if (
            accessManager_ == address(0) ||
            mzusd_ == address(0) ||
            vault_ == address(0) ||
            reservoir_ == address(0) ||
            lossManager_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (tranches_.length == 0) revert EmptyTranches();
        if (initialLevel > MAX_LEVEL) revert InvalidLevel(initialLevel);

        __AccessManaged_init(accessManager_);
        __UUPSUpgradeable_init();

        accessManager = IAccessManagerMinimal(accessManager_);
        mzusd = mzusd_;
        vault = vault_;
        reservoir = reservoir_;
        lossManager = lossManager_;
        currentLevel = initialLevel;

        for (uint256 i = 0; i < tranches_.length; i++) {
            if (tranches_[i] == address(0)) revert ZeroAddress();
            tranches.push(tranches_[i]);
        }
    }

    function tranchesLength() external view returns (uint256) {
        return tranches.length;
    }

    function totalRulesCount() public view returns (uint256) {
        return
            EmergencyPolicyV1.rulesCountMZUSD() +
            EmergencyPolicyV1.rulesCountReservoir() +
            EmergencyPolicyV1.rulesCountVault() +
            EmergencyPolicyV1.rulesCountLossManager() +
            EmergencyPolicyV1.rulesCountTranche() * tranches.length;
    }

    /// @notice Escalate to a higher emergency level.
    function escalateTo(uint8 newLevel) external restricted {
        if (newLevel > MAX_LEVEL) revert InvalidLevel(newLevel);
        uint8 current = currentLevel;
        if (newLevel <= current) revert LevelNotIncreased(current, newLevel);
        _applyLevel(newLevel);
    }

    /// @notice Relax to a lower emergency level.
    function relaxTo(uint8 newLevel) external restricted {
        if (newLevel > MAX_LEVEL) revert InvalidLevel(newLevel);
        uint8 current = currentLevel;
        if (newLevel >= current) revert LevelNotDecreased(current, newLevel);
        _applyLevel(newLevel);
    }

    /// @notice Re-apply the current level rules.
    function syncLevel() external restricted {
        _applyRulesForLevel(currentLevel);
    }

    function _applyLevel(uint8 newLevel) internal {
        _applyRulesForLevel(newLevel);
        uint8 previous = currentLevel;
        currentLevel = newLevel;
        emit LevelChanged(previous, newLevel);
    }

    function _applyRulesForLevel(uint8 level) internal {
        _applyRules(mzusd, EmergencyPolicyV1.rulesMZUSD(), level);
        _applyRules(reservoir, EmergencyPolicyV1.rulesReservoir(), level);
        _applyRules(vault, EmergencyPolicyV1.rulesVault(), level);
        _applyRules(lossManager, EmergencyPolicyV1.rulesLossManager(), level);

        EmergencyPolicyV1.RuleDef[] memory trancheRules = EmergencyPolicyV1.rulesTranche();
        uint256 trancheCount = tranches.length;
        for (uint256 i = 0; i < trancheCount; i++) {
            _applyRules(tranches[i], trancheRules, level);
        }
    }

    function _applyRules(
        address target,
        EmergencyPolicyV1.RuleDef[] memory rules,
        uint8 level
    ) internal {
        uint64 publicRole = accessManager.PUBLIC_ROLE();
        uint64 adminRole = accessManager.ADMIN_ROLE();

        uint256 publicCount;
        uint256 vaultWithdrawCount;
        uint256 vaultCount;
        uint256 lossManagerCount;
        uint256 protocolAdminCount;
        uint256 adminCount;
        uint256 upgradeCount;
        uint256 disabledCount;

        uint256 rulesLen = rules.length;
        for (uint256 i = 0; i < rulesLen; i++) {
            EmergencyPolicyV1.RuleDef memory rule = rules[i];
            uint64 roleId = _resolveRoleId(rule.role, publicRole, adminRole);
            if (!_isAllowed(level, rule.allowedMask)) {
                roleId = DISABLED_ROLE;
            }

            if (roleId == publicRole) {
                publicCount++;
            } else if (roleId == VAULT_WITHDRAW_ROLE) {
                vaultWithdrawCount++;
            } else if (roleId == VAULT_ROLE) {
                vaultCount++;
            } else if (roleId == LOSS_MANAGER_ROLE) {
                lossManagerCount++;
            } else if (roleId == PROTOCOL_ADMIN_ROLE) {
                protocolAdminCount++;
            } else if (roleId == adminRole) {
                adminCount++;
            } else if (roleId == UPGRADE_ROLE) {
                upgradeCount++;
            } else if (roleId == DISABLED_ROLE) {
                disabledCount++;
            }
        }

        bytes4[] memory publicSelectors = new bytes4[](publicCount);
        bytes4[] memory vaultWithdrawSelectors = new bytes4[](vaultWithdrawCount);
        bytes4[] memory vaultSelectors = new bytes4[](vaultCount);
        bytes4[] memory lossManagerSelectors = new bytes4[](lossManagerCount);
        bytes4[] memory protocolAdminSelectors = new bytes4[](protocolAdminCount);
        bytes4[] memory adminSelectors = new bytes4[](adminCount);
        bytes4[] memory upgradeSelectors = new bytes4[](upgradeCount);
        bytes4[] memory disabledSelectors = new bytes4[](disabledCount);

        uint256 publicIdx;
        uint256 vaultWithdrawIdx;
        uint256 vaultIdx;
        uint256 lossIdx;
        uint256 protocolAdminIdx;
        uint256 adminIdx;
        uint256 upgradeIdx;
        uint256 disabledIdx;

        for (uint256 i = 0; i < rulesLen; i++) {
            EmergencyPolicyV1.RuleDef memory rule = rules[i];
            uint64 roleId = _resolveRoleId(rule.role, publicRole, adminRole);
            if (!_isAllowed(level, rule.allowedMask)) {
                roleId = DISABLED_ROLE;
            }

            if (roleId == publicRole) {
                publicSelectors[publicIdx++] = rule.selector;
            } else if (roleId == VAULT_WITHDRAW_ROLE) {
                vaultWithdrawSelectors[vaultWithdrawIdx++] = rule.selector;
            } else if (roleId == VAULT_ROLE) {
                vaultSelectors[vaultIdx++] = rule.selector;
            } else if (roleId == LOSS_MANAGER_ROLE) {
                lossManagerSelectors[lossIdx++] = rule.selector;
            } else if (roleId == PROTOCOL_ADMIN_ROLE) {
                protocolAdminSelectors[protocolAdminIdx++] = rule.selector;
            } else if (roleId == adminRole) {
                adminSelectors[adminIdx++] = rule.selector;
            } else if (roleId == UPGRADE_ROLE) {
                upgradeSelectors[upgradeIdx++] = rule.selector;
            } else if (roleId == DISABLED_ROLE) {
                disabledSelectors[disabledIdx++] = rule.selector;
            }
        }

        _setTargetRole(target, publicSelectors, publicRole);
        _setTargetRole(target, vaultWithdrawSelectors, VAULT_WITHDRAW_ROLE);
        _setTargetRole(target, vaultSelectors, VAULT_ROLE);
        _setTargetRole(target, lossManagerSelectors, LOSS_MANAGER_ROLE);
        _setTargetRole(target, protocolAdminSelectors, PROTOCOL_ADMIN_ROLE);
        _setTargetRole(target, adminSelectors, adminRole);
        _setTargetRole(target, upgradeSelectors, UPGRADE_ROLE);
        _setTargetRole(target, disabledSelectors, DISABLED_ROLE);
    }

    function _setTargetRole(address target, bytes4[] memory selectors, uint64 role) internal {
        if (selectors.length == 0) return;
        accessManager.setTargetFunctionRole(target, selectors, role);
    }

    function _resolveRoleId(
        EmergencyPolicyV1.RoleKind kind,
        uint64 publicRole,
        uint64 adminRole
    ) internal pure returns (uint64) {
        if (kind == EmergencyPolicyV1.RoleKind.Public) return publicRole;
        if (kind == EmergencyPolicyV1.RoleKind.VaultWithdraw) return VAULT_WITHDRAW_ROLE;
        if (kind == EmergencyPolicyV1.RoleKind.Vault) return VAULT_ROLE;
        if (kind == EmergencyPolicyV1.RoleKind.LossManager) return LOSS_MANAGER_ROLE;
        if (kind == EmergencyPolicyV1.RoleKind.ProtocolAdmin) return PROTOCOL_ADMIN_ROLE;
        if (kind == EmergencyPolicyV1.RoleKind.AccessAdmin) return adminRole;
        if (kind == EmergencyPolicyV1.RoleKind.Upgrade) return UPGRADE_ROLE;
        revert InvalidRoleKind();
    }

    function _isAllowed(uint8 level, uint8 mask) internal pure returns (bool) {
        return (mask & (uint8(1) << level)) != 0;
    }

    function _authorizeUpgrade(address) internal override restricted {}
}
