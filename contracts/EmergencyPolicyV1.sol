// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

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

    // Shared selectors
    bytes4 internal constant SELECTOR_SET_AUTHORITY =
        bytes4(keccak256(bytes("setAuthority(address)")));
    bytes4 internal constant SELECTOR_UPGRADE_TO_AND_CALL =
        bytes4(keccak256(bytes("upgradeToAndCall(address,bytes)")));
    bytes4 internal constant SELECTOR_APPROVE =
        bytes4(keccak256(bytes("approve(address,uint256)")));
    bytes4 internal constant SELECTOR_TRANSFER =
        bytes4(keccak256(bytes("transfer(address,uint256)")));
    bytes4 internal constant SELECTOR_TRANSFER_FROM =
        bytes4(keccak256(bytes("transferFrom(address,address,uint256)")));

    // MZUSD selectors
    bytes4 internal constant MZUSD_DEPOSIT = bytes4(keccak256(bytes("deposit(uint256)")));
    bytes4 internal constant MZUSD_REQUEST_WITHDRAWAL =
        bytes4(keccak256(bytes("requestWithdrawal(uint256)")));
    bytes4 internal constant MZUSD_MINT = bytes4(keccak256(bytes("mint(address,uint256)")));
    bytes4 internal constant MZUSD_BURN = bytes4(keccak256(bytes("burn(address,uint256)")));
    bytes4 internal constant MZUSD_SET_HOURLY_CAP =
        bytes4(keccak256(bytes("setGlobalHourlyRedemptionCap(uint256)")));
    bytes4 internal constant MZUSD_SET_WINDOW =
        bytes4(keccak256(bytes("setRedemptionWindowDuration(uint256)")));
    bytes4 internal constant MZUSD_SET_VAULT = bytes4(keccak256(bytes("setVault(address)")));
    bytes4 internal constant MZUSD_RESCUE_ETH =
        bytes4(keccak256(bytes("rescueETH(address,uint256)")));

    // Reservoir selectors
    bytes4 internal constant RESERVOIR_DEPOSIT = bytes4(keccak256(bytes("deposit(uint256)")));
    bytes4 internal constant RESERVOIR_WITHDRAW =
        bytes4(keccak256(bytes("withdraw(uint256,address)")));

    // Vault selectors
    bytes4 internal constant VAULT_WITHDRAW = bytes4(keccak256(bytes("withdraw(address,uint256)")));
    bytes4 internal constant VAULT_REBALANCE = bytes4(keccak256(bytes("rebalance()")));
    bytes4 internal constant VAULT_DISTRIBUTE_YIELD =
        bytes4(keccak256(bytes("distributeYield(uint256)")));
    bytes4 internal constant VAULT_SET_RESERVOIR =
        bytes4(keccak256(bytes("setReservoir(address)")));
    bytes4 internal constant VAULT_SET_MZUSD = bytes4(keccak256(bytes("setMZUSD(address)")));
    bytes4 internal constant VAULT_SET_FEES =
        bytes4(keccak256(bytes("setFees(uint256,address,uint256,address)")));
    bytes4 internal constant VAULT_ADD_TRANCHE =
        bytes4(keccak256(bytes("addTranche((address,uint16,bool))")));
    bytes4 internal constant VAULT_UPDATE_TRANCHE =
        bytes4(keccak256(bytes("updateTranche(uint256,uint256,bool)")));
    bytes4 internal constant VAULT_SET_INSURANCE =
        bytes4(keccak256(bytes("setInsurance(address,uint256)")));
    bytes4 internal constant VAULT_SET_BUFFER =
        bytes4(keccak256(bytes("setBuffer(uint256,uint256)")));
    bytes4 internal constant VAULT_SET_EPOCH_CONFIG =
        bytes4(keccak256(bytes("setEpochConfig(uint256,bool)")));

    // Tranche selectors
    bytes4 internal constant TRANCHE_DEPOSIT = bytes4(keccak256(bytes("deposit(uint256,address)")));
    bytes4 internal constant TRANCHE_MINT = bytes4(keccak256(bytes("mint(uint256,address)")));
    bytes4 internal constant TRANCHE_REQUEST_WITHDRAWAL =
        bytes4(keccak256(bytes("requestWithdrawal(uint256)")));
    bytes4 internal constant TRANCHE_CANCEL_UNSTAKE =
        bytes4(keccak256(bytes("cancelUnstake(uint256,uint256)")));
    bytes4 internal constant TRANCHE_CLAIM = bytes4(keccak256(bytes("claim(uint256)")));
    bytes4 internal constant TRANCHE_WITHDRAW =
        bytes4(keccak256(bytes("withdraw(uint256,address,address)")));
    bytes4 internal constant TRANCHE_REDEEM =
        bytes4(keccak256(bytes("redeem(uint256,address,address)")));
    bytes4 internal constant TRANCHE_FINALIZE_EPOCH =
        bytes4(keccak256(bytes("finalizeEpoch(uint256)")));
    bytes4 internal constant TRANCHE_NOTIFY_YIELD =
        bytes4(keccak256(bytes("notifyYield(uint256)")));
    bytes4 internal constant TRANCHE_SET_UNSTAKE_DELAY =
        bytes4(keccak256(bytes("setUnstakeDelayEpochs(uint256)")));
    bytes4 internal constant TRANCHE_SET_DEPOSIT_LIMITS =
        bytes4(keccak256(bytes("setDepositLimits(bool,uint256,uint256)")));
    bytes4 internal constant TRANCHE_SWEEP_POL = bytes4(keccak256(bytes("sweepPol()")));
    bytes4 internal constant TRANCHE_SET_POL_PAYOUT =
        bytes4(keccak256(bytes("setPolPayout(address)")));

    // LossManager selectors
    bytes4 internal constant LOSS_APPLY = bytes4(keccak256(bytes("applyLoss(uint256)")));
    bytes4 internal constant LOSS_SET_TRANCHE_ORDER =
        bytes4(keccak256(bytes("setTrancheOrder(address[])")));
    bytes4 internal constant LOSS_SET_MAX_LOSS =
        bytes4(keccak256(bytes("setMaxLossPerTxUSDC(uint256)")));

    uint256 internal constant MZUSD_RULES_COUNT = 13;
    uint256 internal constant RESERVOIR_RULES_COUNT = 4;
    uint256 internal constant VAULT_RULES_COUNT = 13;
    uint256 internal constant TRANCHE_RULES_COUNT = 18;
    uint256 internal constant LOSS_MANAGER_RULES_COUNT = 5;

    /// @notice MZUSD rules: ingress only in L0, egress in L0/L1, no user ops in L2.
    /// @dev L2 keeps only emergency/admin actions (rescue/upgrade/authority) and loss burns.
    function rulesMZUSD() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](MZUSD_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(MZUSD_DEPOSIT, RoleKind.Public, MASK_L0);
        rules[idx++] = RuleDef(MZUSD_REQUEST_WITHDRAWAL, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(SELECTOR_APPROVE, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(SELECTOR_TRANSFER, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(SELECTOR_TRANSFER_FROM, RoleKind.Public, MASK_L0_L1);

        rules[idx++] = RuleDef(MZUSD_MINT, RoleKind.Vault, MASK_L0);
        rules[idx++] = RuleDef(MZUSD_BURN, RoleKind.LossManager, MASK_L0_L1_L2);

        rules[idx++] = RuleDef(MZUSD_SET_HOURLY_CAP, RoleKind.ProtocolAdmin, MASK_L0_L1);
        rules[idx++] = RuleDef(MZUSD_SET_WINDOW, RoleKind.ProtocolAdmin, MASK_L0_L1);
        rules[idx++] = RuleDef(MZUSD_SET_VAULT, RoleKind.ProtocolAdmin, MASK_L0);

        rules[idx++] = RuleDef(MZUSD_RESCUE_ETH, RoleKind.ProtocolAdmin, MASK_L0_L1_L2);
        rules[idx++] = RuleDef(SELECTOR_SET_AUTHORITY, RoleKind.AccessAdmin, MASK_L2);
        rules[idx++] = RuleDef(SELECTOR_UPGRADE_TO_AND_CALL, RoleKind.Upgrade, MASK_L2);
    }

    /// @notice Reservoir rules: liquidity ops only in L0/L1, upgrades and authority only in L2.
    function rulesReservoir() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](RESERVOIR_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(RESERVOIR_DEPOSIT, RoleKind.Vault, MASK_L0);
        rules[idx++] = RuleDef(RESERVOIR_WITHDRAW, RoleKind.Vault, MASK_L0_L1);
        rules[idx++] = RuleDef(SELECTOR_SET_AUTHORITY, RoleKind.AccessAdmin, MASK_L2);
        rules[idx++] = RuleDef(SELECTOR_UPGRADE_TO_AND_CALL, RoleKind.Upgrade, MASK_L2);
    }

    /// @notice Vault rules: rebalancing/yield only in L0; withdrawals allowed in L0/L1.
    /// @dev All config changes are L0-only; upgrades/authority are L2-only.
    function rulesVault() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](VAULT_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(VAULT_WITHDRAW, RoleKind.VaultWithdraw, MASK_L0_L1);
        rules[idx++] = RuleDef(VAULT_REBALANCE, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(VAULT_DISTRIBUTE_YIELD, RoleKind.ProtocolAdmin, MASK_L0);

        rules[idx++] = RuleDef(VAULT_SET_RESERVOIR, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(VAULT_SET_MZUSD, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(VAULT_SET_FEES, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(VAULT_ADD_TRANCHE, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(VAULT_UPDATE_TRANCHE, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(VAULT_SET_INSURANCE, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(VAULT_SET_BUFFER, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(VAULT_SET_EPOCH_CONFIG, RoleKind.ProtocolAdmin, MASK_L0);

        rules[idx++] = RuleDef(SELECTOR_SET_AUTHORITY, RoleKind.AccessAdmin, MASK_L2);
        rules[idx++] = RuleDef(SELECTOR_UPGRADE_TO_AND_CALL, RoleKind.Upgrade, MASK_L2);
    }

    /// @notice Tranche rules: user egress in L0/L1, ingress only in L0.
    /// @dev Finalization is allowed in L1 to let users claim; upgrades/authority are L2-only.
    function rulesTranche() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](TRANCHE_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(TRANCHE_DEPOSIT, RoleKind.Public, MASK_L0);
        rules[idx++] = RuleDef(TRANCHE_REQUEST_WITHDRAWAL, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(TRANCHE_CANCEL_UNSTAKE, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(TRANCHE_CLAIM, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(TRANCHE_WITHDRAW, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(TRANCHE_REDEEM, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(SELECTOR_APPROVE, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(SELECTOR_TRANSFER, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(SELECTOR_TRANSFER_FROM, RoleKind.Public, MASK_L0_L1);

        rules[idx++] = RuleDef(TRANCHE_FINALIZE_EPOCH, RoleKind.Public, MASK_L0_L1);
        rules[idx++] = RuleDef(TRANCHE_NOTIFY_YIELD, RoleKind.Vault, MASK_L0);
        rules[idx++] = RuleDef(TRANCHE_SET_UNSTAKE_DELAY, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(TRANCHE_SET_DEPOSIT_LIMITS, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(TRANCHE_SWEEP_POL, RoleKind.ProtocolAdmin, MASK_L0);
        rules[idx++] = RuleDef(TRANCHE_SET_POL_PAYOUT, RoleKind.ProtocolAdmin, MASK_L0);

        rules[idx++] = RuleDef(SELECTOR_SET_AUTHORITY, RoleKind.AccessAdmin, MASK_L2);
        rules[idx++] = RuleDef(SELECTOR_UPGRADE_TO_AND_CALL, RoleKind.Upgrade, MASK_L2);
    }

    /// @notice LossManager rules: loss application always available; order changes only in L0/L2.
    function rulesLossManager() internal pure returns (RuleDef[] memory rules) {
        rules = new RuleDef[](LOSS_MANAGER_RULES_COUNT);
        uint256 idx;

        rules[idx++] = RuleDef(LOSS_APPLY, RoleKind.ProtocolAdmin, MASK_L0_L1_L2);
        rules[idx++] = RuleDef(LOSS_SET_TRANCHE_ORDER, RoleKind.ProtocolAdmin, MASK_L0_L2);
        rules[idx++] = RuleDef(LOSS_SET_MAX_LOSS, RoleKind.ProtocolAdmin, MASK_L0_L1_L2);
        rules[idx++] = RuleDef(SELECTOR_SET_AUTHORITY, RoleKind.AccessAdmin, MASK_L2);
        rules[idx++] = RuleDef(SELECTOR_UPGRADE_TO_AND_CALL, RoleKind.Upgrade, MASK_L2);
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
