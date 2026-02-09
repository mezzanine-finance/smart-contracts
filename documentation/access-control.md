# Access Control and Roles (Phase 1)

## Overview

Access control is centralized in OpenZeppelin `AccessManager` for all functions that use
the `restricted` modifier. Some critical flows are **not** AccessManager-gated and instead
use direct address checks (e.g. `onlyVault`, `onlyMZUSD`, `onlyLossManager`, `onlyNavOracle`).
This document captures the current access surface and the recommended separation for
safe operations.

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

- `ORACLE_ROLE` (oracle EOAs)
    - Lets oracles submit NAV snapshots to NavOracleAutomation.

- `UPGRADER_ROLE` (governance multisig)
    - Restricts `upgradeToAndCall` on UUPS contracts.
    - Recommended: execution delay enforced via AccessManager.

- `KEEPER_ROLE` (keeper / automation bot)
    - Calls `Vault.rebalance()` to move idle USDC between Vault and Reservoir.

- `RESERVOIR_WITHDRAW_ROLE` (Vault + curators addresses)
    - Lets Vault and designated protocol operators call `ReservoirUSDC.withdraw`.

## Role mapping by contract

### PauseManager (UUPS)

- `pauseGlobal`, `pauseContract` → `PAUSER_ROLE`
- `unpauseGlobal`, `unpauseContract` → `UNPAUSER_ROLE` (delayed)
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### MZUSD (UUPS)

- `mint` → only the configured Vault address
- `burn` → `BURNER_ROLE` (typically tranche contracts that LossManager burns through)
- `setGlobalRedemptionCap`, `setRedemptionWindowDuration` → `ADMIN_ROLE`
- `setVault` (one-time, not pausable) → `ADMIN_ROLE`
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### Vault (UUPS)

- `distributeYield` → only the configured `navOracle` address
- `rebalance` → `KEEPER_ROLE`
- `withdraw` → only the configured MZUSD address (no AccessManager role)
- `advanceEpoch` → only the configured `lossManager` address
- `setLossManager` (one-time), `setNavOracle` (updatable),
  `setFeeRates`, `setFeeReceivers`, `setBuffer`, `setEpochConfig`, `addTranche`,
  `updateTranche`
  → `ADMIN_ROLE`
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### Tranche (UUPS)

- `notifyYield` → only the configured `vault` address
- `setUnstakeDelayEpochs`, `setDepositLimits`, `setDepositLimitEnabled` → `ADMIN_ROLE`
- `finalizeEpoch` → public (no AccessManager role; paused via `PROTOCOL` category)
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### PolJuniorTranche (UUPS)

- `notifyYield` → only the configured `vault` address
- `withdraw`, `setPolPayout` → `ADMIN_ROLE`
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### ReservoirUSDC (UUPS)

- `deposit` → not AccessManager-gated (PauseManager only)
- `withdraw` → `RESERVOIR_WITHDRAW_ROLE` (Vault + curators/strategists)
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### LossManager (UUPS)

- `applyLoss` → only the configured `navOracle` address
- `setTrancheOrderAndPairs`, `setMaxLossPerTxUSDC`, `setNavOracle` → `ADMIN_ROLE`
- `upgradeToAndCall` → `UPGRADER_ROLE` (delayed)

### NavOracleAutomation (non-upgradeable)

- `submitNav` → `ORACLE_ROLE`
- `rejectPendingNav`, `setVetoPeriod` → `ADMIN_ROLE`

## Cross-contract grants (must exist)

- Vault + designated operators must hold `RESERVOIR_WITHDRAW_ROLE` to call:
  - `ReservoirUSDC.withdraw`
- Keeper / automation bots must hold `KEEPER_ROLE` to call:
  - `Vault.rebalance`

## Direct address checks (must be wired)

- `Vault.mzusd` is immutable (constructor param) and gates `Vault.withdraw`.
- `Vault.reservoir` is immutable (constructor param) and used for rebalance/withdraw liquidity pulls.
- `Vault.lossManager` is set once via `setLossManager` and gates `Vault.advanceEpoch`.
- `Vault.navOracle` is updatable via `setNavOracle` and gates `Vault.distributeYield`.
  Update requires the new oracle to reference the same `vault`, `lossManager`, and `mzusd`.
- `LossManager.navOracle` is set via `setNavOracle` and gates `LossManager.applyLoss`.
- `MZUSD.vault` is set once via `setVault` and gates `MZUSD.mint`.
- `Tranche.vault` is an immutable constructor param and gates `Tranche.notifyYield`.
- `LossManager.vault` is an immutable constructor param and is used by `LossManager.applyLoss`.
- `PolJuniorTranche.vault` is an immutable constructor param and gates `PolJuniorTranche.notifyYield`.

## Minimal separation recommendation

If governance wants “one multisig”, keep `ADMIN_ROLE`, `UNPAUSER_ROLE`, and
`PAUSER_ROLE` on the same multisig but enforce a delay on unpause and upgrades.
If possible, separate `PAUSER_ROLE` to a faster-acting guardian.

## Notes

- All user entry points (deposits, withdrawals, transfers) are not AccessManager-gated,
  but are protected by PauseManager categories.
- AccessManager configuration is the source of truth for `restricted` functions; avoid
  granting `ADMIN_ROLE` to automation or oracle actors unless strictly necessary.
- Core wiring is fixed: `Vault.mzusd`/`Vault.reservoir` are immutable and
  `Vault.lossManager` is a one-time assignment; updates require an upgrade.
