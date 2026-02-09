# Pause Manager v1

## Overview

`PauseManager` is a centralized registry for category-based pause switches.
Contracts inheriting `PauseManagedUpgradeable` use `whenNotPaused(category)` checks.

All categories are enabled by default and can be paused explicitly.

Effective pause for a call is:

- `globalPaused(category) || contractPaused(target, category)`

Design goals:

- Simple mental model (one category per function path).
- Easy to audit and document.
- Minimal storage and no loops in hot paths.

## Categories

- `DEPOSITS`
- `WITHDRAWALS`
- `TRANSFERS`
- `ADMIN`
- `PROTOCOL`

## PauseManager methods

- `pauseGlobal(category)`
- `unpauseGlobal(category)`
- `pauseContract(target, category)`
- `unpauseContract(target, category)`
- `isPaused(target, category)`
- `globalPaused(category)`
- `contractPaused(target, category)`

Pause/unpause are separate functions so AccessManager can apply stricter delays on unpause.

## How PauseManager works

- Global pause disables a category for all protocol contracts.
- Contract pause disables a category for a specific contract address only.
- Effective result combines both checks (`global || contract`).
- Calls that mutate pause state are `restricted` and should be role-mapped in AccessManager.

## PauseManaged behavior

`whenNotPaused(category)` calls `PauseManager.isPaused(address(this), category)`.
If paused, call reverts with `CategoryPaused(category)`.

## Current category mapping (as implemented)

### MZUSD

- `DEPOSITS`: `deposit`
- `WITHDRAWALS`: `requestWithdrawal`
- `TRANSFERS`: `transfer`, `transferFrom`, `approve`
- `ADMIN`: `setGlobalRedemptionCap`, `setRedemptionWindowDuration`
- `PROTOCOL`: `mint`, `burn`

Note: `setVault` and `setLossManager` are `restricted` but not pause-gated.

### Tranche

- `DEPOSITS`: `deposit`, `mint` (via ERC4626 overrides)
- `WITHDRAWALS`: `requestWithdrawal`, `cancelUnstake`, `claim`, `withdraw`, `redeem`
- `TRANSFERS`: `transfer`, `transferFrom`, `approve`
- `ADMIN`: `setDepositLimits`, `setUnstakeDelayEpochs`
- `PROTOCOL`: `notifyYield`, `finalizeEpoch`, `burnMZUSD`

### Vault

- `WITHDRAWALS`: `withdraw`
- `ADMIN`: `setLossManager`, `setNavOracle`, `setFeeRates`, `setFeeReceivers`,
  `setBuffer`, `setEpochConfig`, `addTranche`, `setYieldDistribution`
- `PROTOCOL`: `distributeYield`, `rebalance`, `advanceEpoch`

### LossManager

- `ADMIN`: `setTrancheOrderAndPairs`, `setMaxLossPerTxUSDC`
- `PROTOCOL`: `applyLoss`

### ReservoirUSDC

- `PROTOCOL`: `deposit`, `withdraw`

Note: `setVault` is `restricted` but not pause-gated.

### PolJuniorTranche

- `WITHDRAWALS`: `withdraw`
- `ADMIN`: `setPolPayout`
- `PROTOCOL`: `notifyYield`, `burnMZUSD`
