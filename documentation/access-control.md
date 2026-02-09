# Access Control and Roles (Phase 1)

## Overview

Access control is centered in OpenZeppelin `AccessManager` for all functions marked `restricted`.
Some protocol-critical paths additionally use direct caller checks (`onlyVault`, `onlyMZUSD`, etc).

Pause behavior is handled separately via `PauseManager` categories.

## Design goals

- Keep the role set minimal while enforcing least privilege.
- Allow fast emergency pauses, but require a delay before unpausing.
- Avoid giving automation/oracle actors broad admin permissions.

## Logical roles

Role IDs are configurable `uint64` values in deployment config.

- `ADMIN_ROLE`
  - Governance multisig role for core configuration and sensitive admin actions.
- `PAUSER_ROLE`
  - Can pause categories globally/per-contract (typically guardian or multisig).
- `UNPAUSER_ROLE`
  - Can unpause categories (recommended with execution delay and stricter governance path).
- `UPGRADER_ROLE`
  - Can call `upgradeToAndCall` on UUPS contracts (recommended with delay).
- `KEEPER_ROLE`
  - Calls `Vault.rebalance()` to move idle USDC between Vault and Reservoir.
- `RESERVOIR_WITHDRAW_ROLE`
  - Can call `ReservoirUSDC.withdraw` (Vault + approved operators).
- `ORACLE_ROLE`
  - Can call `NavOracleAutomation.submitNav`.
- `BURNER_ROLE`
  - Can call `MZUSD.burn` (typically Tranche and PolJuniorTranche contracts).

## Contract-level mapping

### PauseManager (UUPS)

- `pauseGlobal`, `pauseContract` -> `PAUSER_ROLE`
- `unpauseGlobal`, `unpauseContract` -> `UNPAUSER_ROLE`
- `upgradeToAndCall` -> `UPGRADER_ROLE`

### MZUSD (UUPS)

- `mint` -> only configured Vault (`onlyVault`)
- `burn` -> `BURNER_ROLE` (`restricted`, plus `PROTOCOL` pause gate)
- `setGlobalRedemptionCap`, `setRedemptionWindowDuration` -> `ADMIN_ROLE`
- `setVault` (one-time) -> `ADMIN_ROLE`
- `upgradeToAndCall` -> `UPGRADER_ROLE`

### Vault (UUPS)

- `distributeYield` -> only configured `navOracle`
- `withdraw` -> only configured MZUSD (`onlyMZUSD`)
- `advanceEpoch` -> only configured `lossManager`
- `rebalance` -> `KEEPER_ROLE`
- `setLossManager`, `setNavOracle`, `setFeeRates`, `setFeeReceivers`, `setBuffer`,
  `setEpochConfig`, `addTranche`, `setYieldDistribution` -> `ADMIN_ROLE`
- `upgradeToAndCall` -> `UPGRADER_ROLE`

### Tranche (UUPS)

- `notifyYield` -> only configured `vault`
- `burnMZUSD` -> only `IVault(vault).lossManager()`
- `setUnstakeDelayEpochs`, `setDepositLimits`, `setDepositLimitEnabled` -> `ADMIN_ROLE`
- `finalizeEpoch` -> public (pause-gated, not `restricted`)
- `upgradeToAndCall` -> `UPGRADER_ROLE`

### PolJuniorTranche (UUPS)

- `notifyYield` -> only configured `vault`
- `burnMZUSD` -> only `IVault(vault).lossManager()`
- `withdraw`, `setPolPayout` -> `ADMIN_ROLE`
- `upgradeToAndCall` -> `UPGRADER_ROLE`

### ReservoirUSDC (UUPS)

- `deposit` -> open (pause-gated)
- `withdraw` -> `RESERVOIR_WITHDRAW_ROLE`
- `setVault` -> `ADMIN_ROLE`
- `upgradeToAndCall` -> `UPGRADER_ROLE`

### LossManager (UUPS)

- `applyLoss` -> only current `IVault(vault).navOracle()`
- `setTrancheOrderAndPairs`, `setMaxLossPerTxUSDC` -> `ADMIN_ROLE`
- `upgradeToAndCall` -> `UPGRADER_ROLE`

### NavOracleAutomation (non-upgradeable)

- `submitNav` -> `ORACLE_ROLE`
- `rejectPendingNav`, `setVetoPeriod` -> `ADMIN_ROLE`

## Cross-contract grants and wiring

- `Vault` and approved operators must hold `RESERVOIR_WITHDRAW_ROLE` for `ReservoirUSDC.withdraw`.
- Keeper addresses must hold `KEEPER_ROLE` for `Vault.rebalance`.
- Tranche/PolJuniorTranche addresses that burn on losses must hold `BURNER_ROLE` on MZUSD.
- Oracle submitter addresses must hold `ORACLE_ROLE` on `NavOracleAutomation`.

Direct-check wiring:

- `Vault.mzusd` and `Vault.reservoir` are immutable constructor params.
- `Vault.lossManager` is one-time (`setLossManager`).
- `Vault.navOracle` is updatable (`setNavOracle`) with strict cross-reference checks.
- `LossManager.vault` is immutable; `applyLoss` resolves NAV authority from `Vault.navOracle()`.
- `MZUSD.vault` is one-time and gates `mint`.
- `Tranche.vault`, `PolJuniorTranche.vault` are immutable and gate `notifyYield`.

## Minimal separation recommendation

If governance operates with one multisig, keep `ADMIN_ROLE`, `UNPAUSER_ROLE`, and
`UPGRADER_ROLE` on that multisig and enforce delays on unpause/upgrade actions.
If possible, separate `PAUSER_ROLE` to a faster guardian path.

## Operational notes

- AccessManager target-function role mapping is the source of truth for `restricted` methods.
- User entrypoints remain non-`restricted` but are pause-gated by category.
- Recommended practice: keep delays on unpause and upgrade roles, and separate pauser from admin when possible.
