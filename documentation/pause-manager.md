# Pause Manager v1

## Overview
PauseManager is a centralized registry that controls whether a category of actions is paused.
Contracts that should respect pauses inherit PauseManagedUpgradeable and wrap functions with
`whenNotPaused(category)`. All categories are enabled by default and can be disabled explicitly.

Design goals:
- Simple mental model (no scopes, no bitmasks, one category per function).
- Easy to audit and document.
- Minimal storage and no loops in hot paths.

## Categories
The protocol uses the following categories:
- `DEPOSITS`: user ingress and minting of receipt shares.
- `WITHDRAWALS`: user egress flows and claims.
- `TRANSFERS`: ERC20 transfer/approve/transferFrom.
- `ADMIN`: configuration and parameter updates.
- `PROTOCOL`: yield distribution, loss handling, epoch maintenance, and other protocol flows.

## How PauseManager works
- Global pause: disables a category for all contracts.
- Contract pause: disables a category only for one contract address.
- Effective pause is `globalPaused || contractPaused`.

PauseManager is AccessManager-controlled; only authorized callers can pause/unpause.
Pause and unpause are separate methods so AccessManager can enforce an execution delay
specifically for unpause operations.

### Core methods
- `pauseGlobal(category)`
- `unpauseGlobal(category)` (configure AccessManager to apply a delay)
- `pauseContract(target, category)`
- `unpauseContract(target, category)` (configure AccessManager to apply a delay)
- `isPaused(target, category)`
- `globalPaused(category)`
- `contractPaused(target, category)`

## How PauseManaged works
Contracts call `whenNotPaused(category)` in the target functions. The modifier
calls `PauseManager.isPaused(address(this), category)` and reverts with
`CategoryPaused(category)` if the category is disabled.

## Intended category mapping 
This mapping is the intended target for core contracts once PauseManaged is wired in.

### MZUSD
- `DEPOSITS`: `deposit`
- `WITHDRAWALS`: `requestWithdrawal`
- `TRANSFERS`: `transfer`, `transferFrom`, `approve`
- `ADMIN`: `setGlobalRedemptionCap`, `setRedemptionWindowDuration`
- `PROTOCOL`: `mint`, `burn`

### Tranche
- `DEPOSITS`: `deposit`, `mint`
- `WITHDRAWALS`: `requestWithdrawal`, `cancelUnstake`, `claim`, `withdraw`, `redeem`
- `TRANSFERS`: `transfer`, `transferFrom`, `approve`
- `ADMIN`: `setDepositLimits`, `setUnstakeDelayEpochs`
- `PROTOCOL`: `notifyYield`, `finalizeEpoch`

### Vault
- `ADMIN`: `setMZUSD`, `setReservoir`, `setFees`, `setBuffer`, `setEpochConfig`,
  `addTranche`, `updateTranche`, `setInsurance`
- `PROTOCOL`: `distributeYield`, `rebalance`, `withdraw`, `advanceEpoch`

### LossManager
- `ADMIN`: `setTrancheOrderAndGroups`, `setMaxLossPerTxUSDC`, `setVault`
- `PROTOCOL`: `applyLoss`

### ReservoirUSDC
- `PROTOCOL`: `deposit`, `withdraw`

### PolJuniorTranche
- `DEPOSITS`: `deposit`, `mint`
- `WITHDRAWALS`: `withdraw`, `redeem`
- `TRANSFERS`: `transfer`, `transferFrom`, `approve`
- `ADMIN`: `setPolPayout`
- `PROTOCOL`: `notifyYield`
