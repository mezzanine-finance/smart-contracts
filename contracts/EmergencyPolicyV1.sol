// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {LossManager} from "./LossManager.sol";
import {MZUSD} from "./MZUSD.sol";
import {ReservoirUSDC} from "./ReservoirUSDC.sol";
import {Tranche} from "./Tranche.sol";
import {Vault} from "./Vault.sol";

/// @title EmergencyPolicyV1
/// @notice Hardcoded emergency access policy for Phase 1.
/// @dev L0 = normal operations, L1 = pause ingress (egress allowed), L2 = full stop.
library EmergencyPolicyV1 {
    enum RoleKind {
        Public,
        VaultWithdraw,
        Vault,
        LossManager,
        ProtocolAdmin,
        AccessAdmin,
        Upgrade
    }

    struct RuleDef {
        bytes4 selector;
        RoleKind role;
        uint8 allowedMask; // bit0=L0, bit1=L1, bit2=L2
    }

    uint8 internal constant MASK_L0 = 1 << 0;
    uint8 internal constant MASK_L1 = 1 << 1;
    uint8 internal constant MASK_L2 = 1 << 2;

    uint8 internal constant MASK_L0_L1 = MASK_L0 | MASK_L1;
    uint8 internal constant MASK_L0_L1_L2 = MASK_L0 | MASK_L1 | MASK_L2;
    uint8 internal constant MASK_L0_L2 = MASK_L0 | MASK_L2;

    uint256 internal constant MZUSD_RULES_COUNT = 13;
    uint256 internal constant RESERVOIR_RULES_COUNT = 4;
    uint256 internal constant VAULT_RULES_COUNT = 13;
    uint256 internal constant TRANCHE_RULES_COUNT = 16;
    uint256 internal constant LOSS_MANAGER_RULES_COUNT = 5;

    /// @notice MZUSD rules: ingress only in L0, egress in L0/L1, no user ops in L2.
    /// @dev L2 keeps only emergency/admin actions (rescue/upgrade/authority) and loss burns.
    function rulesMZUSD() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](MZUSD_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(MZUSD.deposit.selector, RoleKind.Public, MASK_L0);
        rules[idx++] = RuleDef(MZUSD.requestWithdrawal.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(MZUSD.approve.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(MZUSD.transfer.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(MZUSD.transferFrom.selector, RoleKind.Public, MASK_L0_L1);

        rules[idx++] = RuleDef(MZUSD.mint.selector, RoleKind.Vault, MASK_L0);
        rules[idx++] = RuleDef(MZUSD.burn.selector, RoleKind.LossManager, MASK_L0_L1_L2);

        rules[idx++] = RuleDef(
            MZUSD.setGlobalHourlyRedemptionCap.selector,
            RoleKind.ProtocolAdmin,
            MASK_L0_L1
        );
        rules[idx++] = RuleDef(
            MZUSD.setRedemptionWindowDuration.selector,
            RoleKind.ProtocolAdmin,
            MASK_L0_L1
        );
        rules[idx++] = RuleDef(MZUSD.setVault.selector, RoleKind.ProtocolAdmin, MASK_L0);

        rules[idx++] = RuleDef(MZUSD.rescueETH.selector, RoleKind.ProtocolAdmin, MASK_L0_L1_L2);
        rules[idx++] = RuleDef(
            AccessManagedUpgradeable.setAuthority.selector,
            RoleKind.AccessAdmin,
            MASK_L2
        );
        rules[idx++] = RuleDef(
            UUPSUpgradeable.upgradeToAndCall.selector,
            RoleKind.Upgrade,
            MASK_L0_L1_L2
        );
    }

    /// @notice Reservoir rules: liquidity ops only in L0/L1, upgrades timelocked across all levels.
    function rulesReservoir() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](RESERVOIR_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(ReservoirUSDC.deposit.selector, RoleKind.Vault, MASK_L0);
        rules[idx++] = RuleDef(ReservoirUSDC.withdraw.selector, RoleKind.Vault, MASK_L0_L1);
        rules[idx++] = RuleDef(
            AccessManagedUpgradeable.setAuthority.selector,
            RoleKind.AccessAdmin,
            MASK_L2
        );
        rules[idx++] = RuleDef(
            UUPSUpgradeable.upgradeToAndCall.selector,
            RoleKind.Upgrade,
            MASK_L0_L1_L2
        );
    }

    /// @notice Vault rules: rebalancing/yield only in L0; withdrawals allowed in L0/L1.
    /// @dev All config changes are L0-only; upgrades are timelocked across all levels.
    function rulesVault() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](VAULT_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(Vault.withdraw.selector, RoleKind.VaultWithdraw, MASK_L0_L1);
        rules[idx++] = RuleDef(Vault.rebalance.selector, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(Vault.distributeYield.selector, RoleKind.ProtocolAdmin, MASK_L0);

        rules[idx++] = RuleDef(Vault.setReservoir.selector, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(Vault.setMZUSD.selector, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(Vault.setFees.selector, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(Vault.addTranche.selector, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(Vault.updateTranche.selector, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(Vault.setInsurance.selector, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(Vault.setBuffer.selector, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(Vault.setEpochConfig.selector, RoleKind.ProtocolAdmin, MASK_L0);

        rules[idx++] = RuleDef(
            AccessManagedUpgradeable.setAuthority.selector,
            RoleKind.AccessAdmin,
            MASK_L2
        );
        rules[idx++] = RuleDef(
            UUPSUpgradeable.upgradeToAndCall.selector,
            RoleKind.Upgrade,
            MASK_L0_L1_L2
        );
    }

    /// @notice Tranche rules: user egress in L0/L1, ingress only in L0.
    /// @dev Finalization is allowed in L1 to let users claim; upgrades are timelocked across all levels.
    function rulesTranche() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](TRANCHE_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(Tranche.deposit.selector, RoleKind.Public, MASK_L0);
        rules[idx++] = RuleDef(Tranche.mint.selector, RoleKind.Public, MASK_L0);
        rules[idx++] = RuleDef(Tranche.requestWithdrawal.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(Tranche.cancelUnstake.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(Tranche.claim.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(Tranche.withdraw.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(Tranche.redeem.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(MZUSD.approve.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(MZUSD.transfer.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(MZUSD.transferFrom.selector, RoleKind.Public, MASK_L0_L1);

        rules[idx++] = RuleDef(Tranche.finalizeEpoch.selector, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(Tranche.notifyYield.selector, RoleKind.Vault, MASK_L0);
        rules[idx++] = RuleDef(
            Tranche.setUnstakeDelayEpochs.selector,
            RoleKind.ProtocolAdmin,
            MASK_L0
        );
        rules[idx++] = RuleDef(Tranche.setDepositLimits.selector, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(
            AccessManagedUpgradeable.setAuthority.selector,
            RoleKind.AccessAdmin,
            MASK_L2
        );
        rules[idx++] = RuleDef(
            UUPSUpgradeable.upgradeToAndCall.selector,
            RoleKind.Upgrade,
            MASK_L0_L1_L2
        );
    }

    /// @notice LossManager rules: loss application always available; order changes only in L0/L2.
    function rulesLossManager() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](LOSS_MANAGER_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(
            LossManager.applyLoss.selector,
            RoleKind.ProtocolAdmin,
            MASK_L0_L1_L2
        );
        rules[idx++] = RuleDef(
            LossManager.setTrancheOrder.selector,
            RoleKind.ProtocolAdmin,
            MASK_L0_L2
        );
        rules[idx++] = RuleDef(
            LossManager.setMaxLossPerTxUSDC.selector,
            RoleKind.ProtocolAdmin,
            MASK_L0_L1_L2
        );
        rules[idx++] = RuleDef(
            AccessManagedUpgradeable.setAuthority.selector,
            RoleKind.AccessAdmin,
            MASK_L2
        );
        rules[idx++] = RuleDef(
            UUPSUpgradeable.upgradeToAndCall.selector,
            RoleKind.Upgrade,
            MASK_L0_L1_L2
        );
    }

    function rulesCountMZUSD() internal pure returns (uint256) {
        return MZUSD_RULES_COUNT;
    }

    function rulesCountReservoir() internal pure returns (uint256) {
        return RESERVOIR_RULES_COUNT;
    }

    function rulesCountVault() internal pure returns (uint256) {
        return VAULT_RULES_COUNT;
    }

    function rulesCountTranche() internal pure returns (uint256) {
        return TRANCHE_RULES_COUNT;
    }

    function rulesCountLossManager() internal pure returns (uint256) {
        return LOSS_MANAGER_RULES_COUNT;
    }
}
