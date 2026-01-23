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
- `LossManager.navOracle` must be set to the `NavOracleAutomation` address (gates `applyLoss`).
- `MZUSD.lossManager` must be set to the `LossManager` address (gates `burn`).
- `MZUSD.vault` is immutable (gates `mint`).
- `Tranche.vault` is set at initialization (gates `notifyYield`).

## Chainlink Automation
- Register `checkUpkeep(bytes)` and `performUpkeep(bytes)` on the deployed `NavOracleAutomation`.
- Ensure the automation registry can call `performUpkeep` (no AccessManager role required).

## Notes
- NAV is submitted in USDC (6 decimals); MZUSD total supply is 18 decimals and is scaled down by 1e12.
- If `vetoPeriod` is `0`, `submitNav` applies immediately (no veto).
- Zero-yield (`NAV == totalSupplyUSDC`) still calls `Vault.distributeYield(0)`.
  - The current `Vault` accepts zero, advances the epoch, and emits events.
