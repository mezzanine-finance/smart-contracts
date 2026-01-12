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
  - Grant ADMIN_ROLE (or equivalent) to the `NavOracleAutomation` contract so it can call:
    - `Vault.distributeYield(uint256)`
    - `LossManager.applyLoss(uint256)`

## Required target mappings
- `Vault.distributeYield(uint256)` -> ADMIN_ROLE (or ProtocolAdmin role in your policy).
- `LossManager.applyLoss(uint256)` -> ADMIN_ROLE (or ProtocolAdmin role in your policy).
- `MZUSD.burn(address,uint256)` -> LOSS_MANAGER_ROLE (LossManager must hold this role).
- `MZUSD.mint(address,uint256)` + `Tranche.notifyYield(uint256)` -> VAULT_ROLE (Vault must hold this role).

## Chainlink Automation
- Register `checkUpkeep(bytes)` and `performUpkeep(bytes)` on the deployed `NavOracleAutomation`.
- Ensure the automation registry can call `performUpkeep` (no AccessManager role required).

## Notes
- NAV is submitted in USDC (6 decimals); MZUSD total supply is 18 decimals and is scaled down by 1e12.
- If `vetoPeriod` is `0`, `submitNav` applies immediately (no veto).
- Zero-yield (`NAV == totalSupplyUSDC`) still calls `Vault.distributeYield(0)`.
  - The current `Vault` reverts on zero; pending NAV will remain until `Vault` is updated.
