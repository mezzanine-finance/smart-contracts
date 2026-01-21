# Access Control and Roles (Phase 1)

## Overview
Access control is centralized in OpenZeppelin `AccessManager`. Any function using the
`restricted` modifier is gated by AccessManager role checks on a per-function selector
basis. This document captures the minimal roles needed today and the recommended
separation for safe operations.

Pause behavior is handled separately by PauseManager. See `documentation/pause-manager.md`
for categories and pause rules.

## Design goals
- Keep the role set minimal while enforcing least privilege.
- Allow fast emergency pauses, but require a delay before unpausing.
- Avoid giving automation/oracle actors full admin permissions.

## Roles (logical)
Role IDs can be any `uint64`; names below are logical groupings.

- `ADMIN_ROLE` (governance multisig)
  - Protocol config, upgrades, and sensitive settings.

- `PAUSER_ROLE` (guardian or same multisig)
  - Can pause categories (global or per-contract).
  - No unpause permissions.

- `UNPAUSER_ROLE` (multisig)
  - Can unpause categories.
  - Recommended: execution delay enforced via AccessManager.

- `VAULT_ROLE` (Vault contract address)
  - Lets Vault call protocol-critical functions on other contracts.

- `LOSS_MANAGER_ROLE` (LossManager contract address)
  - Lets LossManager advance epochs in Vault.

- `AUTOMATION_ROLE` (NavOracleAutomation contract address)
  - Lets automation apply yield/loss (calls Vault/LossManager).

- `ORACLE_ROLE` (oracle EOAs)
  - Lets oracles submit NAV snapshots to NavOracleAutomation.

- `UPGRADER_ROLE` (governance multisig)
  - Restricts `upgradeToAndCall` on UUPS contracts.
  - Recommended: execution delay enforced via AccessManager.

## Role mapping by contract
### PauseManager (UUPS)
- `pauseGlobal`, `pauseContract` → `PAUSER_ROLE`
- `unpauseGlobal`, `unpauseContract` → `UNPAUSER_ROLE` (delayed)
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### MZUSD (UUPS)
- `mint` → only the configured Vault address
- `burn` → only the configured LossManager address
- `setGlobalRedemptionCap`, `setRedemptionWindowDuration` → `ADMIN_ROLE`
- `setLossManager` (one-time, not pausable) → `ADMIN_ROLE`
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### Vault (UUPS)
- `distributeYield` → `AUTOMATION_ROLE` (or `ADMIN_ROLE` if no automation)
- `rebalance` → `ADMIN_ROLE`
- `withdraw` → only the configured MZUSD address (no AccessManager role)
- `advanceEpoch` → `LOSS_MANAGER_ROLE`
- `setReservoir`, `setMZUSD` (one-time), `setFees`, `setBuffer`, `setEpochConfig`,
  `addTranche`, `updateTranche` → `ADMIN_ROLE`
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### Tranche (UUPS)
- `notifyYield` → `VAULT_ROLE`
- `setUnstakeDelayEpochs`, `setDepositLimits` → `ADMIN_ROLE`
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### PolJuniorTranche (UUPS)
- `notifyYield` → `VAULT_ROLE`
- `withdraw`, `redeem`, `setPolPayout` → `ADMIN_ROLE`
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### ReservoirUSDC (UUPS)
- `deposit`, `withdraw` → only the configured Vault address
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### LossManager (UUPS)
- `applyLoss` → `AUTOMATION_ROLE` (or `ADMIN_ROLE` if no automation)
- `setTrancheOrderAndGroups`, `setMaxLossPerTxUSDC` → `ADMIN_ROLE`
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### NavOracleAutomation (non-upgradeable)
- `submitNav` → `ORACLE_ROLE`
- `rejectPendingNav`, `setVetoPeriod` → `ADMIN_ROLE`

## Cross-contract grants (must exist)
- Vault address must hold `VAULT_ROLE` to call:
  - `Tranche.notifyYield` and `PolJuniorTranche.notifyYield`

- LossManager address must hold `LOSS_MANAGER_ROLE` to call:
  - `Vault.advanceEpoch`

- NavOracleAutomation address must hold `AUTOMATION_ROLE` to call:
  - `Vault.distributeYield`
  - `LossManager.applyLoss`

## Minimal separation recommendation
If governance wants “one multisig”, keep `ADMIN_ROLE`, `UNPAUSER_ROLE`, and
`PAUSER_ROLE` on the same multisig but enforce a delay on unpause and upgrades.
If possible, separate `PAUSER_ROLE` to a faster-acting guardian.

## Notes
- All user entry points (deposits, withdrawals, transfers) are not AccessManager-gated,
  but are protected by PauseManager categories.
- AccessManager configuration is the source of truth for roles; avoid granting `ADMIN_ROLE`
  to automation or oracle actors unless strictly necessary.
- Core wiring is fixed: `Vault.mzusd` is set once, and `Vault.withdraw` accepts calls
  only from that MZUSD address.
- LossManager is initialized with a Vault address; updates require an upgrade.
- MZUSD is configured with a LossManager address once; updates require an upgrade.
