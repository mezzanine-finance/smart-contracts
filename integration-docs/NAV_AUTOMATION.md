# NAV Oracle Automation Configuration

## Overview

`NavOracleAutomation` stores oracle NAV snapshots (USDC 6 decimals), enforces a veto window, and then
applies yield (`Vault.distributeYield`) or loss (`LossManager.applyLoss`) through Chainlink Automation.
Each submission also records the MZUSD total supply so NAV and supply are synchronized.

## Required AccessManager roles

- ORACLE_ROLE (suggested id `6`):
    - Grant to the oracle caller.
    - Map `NavOracleAutomation.submitNav(uint256)` to ORACLE_ROLE.
- ADMIN_ROLE:
    - Map `NavOracleAutomation.rejectPendingNav()` and `setVetoPeriod(uint256)` to ADMIN_ROLE.

## Required wiring (direct checks)

- `Vault.navOracle` must be set to the `NavOracleAutomation` address (gates `distributeYield`).
- `LossManager.vault` must point to the same `Vault`; `applyLoss` checks `Vault.navOracle` dynamically.
- `MZUSD.vault` must be set once to the `Vault` address (gates `mint`).
- `Tranche.vault` is an immutable constructor param (gates `notifyYield`).

## Updating NAV oracle (rotation rules)

`Vault.setNavOracle` is updatable (not one-time), but the new oracle must pass strict checks:

- `newOracle.vault()` must equal current `Vault` address.
- `newOracle.lossManager()` must equal current `Vault.lossManager`.
- `newOracle.mzusd()` must equal current `Vault.mzusd`.
- Address must be a contract (`code.length > 0`), non-zero, and different from current.

Recommended rotation sequence:

1. Resolve pending NAV on old oracle first (`performUpkeep` when ready or `rejectPendingNav`).
2. Deploy new `NavOracleAutomation` with the same `lossManager` (other refs are derived on-chain).
3. Grant/migrate `ORACLE_ROLE` and automation permissions for the new oracle.
4. Call `Vault.setNavOracle(newOracle)`.
5. Revoke old oracle permissions and decommission old automation job.

## Chainlink Automation

- Register `checkUpkeep(bytes)` and `performUpkeep(bytes)` on the deployed `NavOracleAutomation`.
- Ensure the automation registry can call `performUpkeep` (no AccessManager role required).
- `checkData`/`performData` are intentionally unused; upkeep action is derived from contract state.

## Notes

- Trust model: NAV value is trusted oracle input. The protocol does not cryptographically verify
  NAV truthfulness on-chain; safety relies on oracle role governance and optional veto delay.
- NAV is submitted in USDC (6 decimals); MZUSD total supply is 18 decimals and is scaled down by 1e12.
- Pending readiness is snapshotted as `pendingReadyAt` at submission time.
  Changing `vetoPeriod` later affects only future submissions.
- Pending storage is compact and keeps only `delta`, `isYield`, and `readyAt`.
  Full `(navUSDC, totalSupplyMZ)` context is emitted in `NavSubmitted`.
- If `vetoPeriod` is `0`, `submitNav` applies immediately (no veto).
- Zero-yield (`NAV == totalSupplyUSDC`) still calls `Vault.distributeYield(0)`.
    - The current `Vault` accepts zero, advances the epoch, and emits events.
