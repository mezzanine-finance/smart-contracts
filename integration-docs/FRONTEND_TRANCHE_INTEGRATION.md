# Tranche Front-End Integration (Deposit / Withdraw / Cancel)

This guide covers current on-chain flows for user tranches.
Metrics (APR/APY/TVL) are typically sourced from subgraph/indexer, with on-chain fallback notes below.

## TL;DR behavior

- Standard user tranches are ERC4626 vaults over `MZUSD` (18 decimals).
- `PolJuniorTranche` is admin-only (no ERC4626 shares), do not expose it as a public user vault.
- Withdrawal UX depends on `directWithdrawEnabled()`:
  - `true`: `requestWithdrawal(shares)` redeems immediately (equivalent end result to `redeem` to self).
  - `false`: `requestWithdrawal(shares)` enters umbrella flow (wait + finalize + claim).

When `directWithdrawEnabled() == false`, direct `withdraw()`/`redeem()` paths revert by design.

## Contracts needed per tranche page

Standard tranche page:

- `Tranche`
- `MZUSD`
- `Vault`
- `PauseManager` (read pause state via tranche `pauseManager()`)

POL page (if any):

- `PolJuniorTranche`
- `MZUSD`

## Read data

### From Tranche

- `name()` / `symbol()` / `decimals()` (share token display)
- `directWithdrawEnabled()` (direct vs umbrella flow)
- `totalAssets()` (TVL in MZUSD, 18d)
- `pricePerShare()` (MZUSD per share, 18d)
- `unaccruedYield()` (yield not yet reflected in NAV)
- `totalSupply()` (shares)
- `depositLimitEnabled()`
- `maxDepositCap()` (configured value; `0` means cap is not configured)
- `maxDepositTvlBps()`
- `getDepositLimitInfo()` (enabled, limit, limitByTvl, capEffective)
- `unstakeDelayEpochs()`
- `pauseManager()`
- User-specific:
  - `balanceOf(user)`
  - `getUserEpochInfo(user, epochId)` -> `(pendingShares, claimableAssets)`
- Optional epoch-level:
  - `getEpochInfo(epochId)` -> `(umbrellaShares, isFinalized, totalShares, totalAssets)`

### From Vault

- `currentEpochId()`
- `epochDuration()`
- `getEpochConfig()`
- `getBufferConfig()` (optional UI info)
- `getTranches(start, count)` -> `(addresses, riskPremiumBps, enabled)`

### From PauseManager

- `isPaused(trancheAddress, PauseCategory.DEPOSITS)`
- `isPaused(trancheAddress, PauseCategory.WITHDRAWALS)`

### Optional MZUSD widget data

- `getRemainingRedemptionCap()` -> `(capUSDC, usedUSDC, remainingUSDC)`
- `getRedemptionWindow()` -> `(windowStart, windowEnd, duration)`

Admin-only (ops panels):

- `setDepositLimits(enabled, cap, tvlBps)` (full config update)
- `setDepositLimitEnabled(enabled)` (toggle both limits only)

## Deposit flow

### Pre-checks

1. Do not allow user deposits into `PolJuniorTranche`.
2. Check `PauseCategory.DEPOSITS`.
3. Ensure user has enough MZUSD.
4. Read and display current deposit limit.

### Deposit limit math (matches contract)

When `depositLimitEnabled == false`, effective limit is `MAX_UINT`.

`getDepositLimitInfo().cap` returns the effective cap:

- `MAX_UINT` when limits are disabled, or when configured `maxDepositCap == 0`.
- otherwise the configured absolute cap value.
When enabled:

- `tvl = totalAssets()`
- `supply = asset.totalSupply()` (MZUSD total supply)
- `maxTotalByTvl = supply * maxDepositTvlBps / 10_000`
- `limitByTvl = max(0, maxTotalByTvl - tvl)`
- `limitByCap = cap == 0 ? MAX_UINT : max(0, cap - tvl)`
- `finalLimit = min(limitByTvl, limitByCap)`

If `amount > finalLimit`, tx reverts with `DepositLimitExceeded`.

### Tx steps

1. `MZUSD.approve(tranche, amount)` if allowance is insufficient.
2. `Tranche.deposit(amount, receiver)`.

Optional UX helper:

- use `previewDeposit(amount)` to show expected shares before submit.

### Common deposit errors

- `DepositLimitExceeded(attempted, limit)`
- `InvalidAmount()` (e.g., invalid limit config path)
- `CategoryPaused(PauseCategory.DEPOSITS)`

## Withdraw flow

### Step 1: request

Users request in **shares**:

- direct mode: immediate redeem in same tx.
- umbrella mode: pending request by target epoch.

If user enters assets in UI, convert with `convertToShares(assets)` before sending tx.

Tx: `Tranche.requestWithdrawal(shares)`.

Errors:

- `ZeroPassedShares()`
- `InvalidBalance()`
- `CategoryPaused(PauseCategory.WITHDRAWALS)`

### Step 2: wait/finalize (umbrella only)

Target epoch:

- `targetEpoch = Vault.currentEpochId() + Tranche.unstakeDelayEpochs()`

After epoch passes (`Vault.currentEpochId() > targetEpoch`), `finalizeEpoch(targetEpoch)` can be called.
Until then, show request as pending.

### Step 3: claim (umbrella only)

Tx: `Tranche.claim(epochId)`.

Errors:

- `NothingToClaim()`
- `NotFinalized()`
- `DirectWithdrawModeEnabled()`
- `CategoryPaused(PauseCategory.WITHDRAWALS)`

## Cancel unstake flow (umbrella only)

User can cancel before vault epoch passes target.

Pre-checks:

- `getUserEpochInfo(user, epochId).pendingShares > 0`
- `getEpochInfo(epochId).isFinalized == false`
- `Vault.currentEpochId() <= epochId`

Tx: `Tranche.cancelUnstake(epochId, shares)`.

Errors:

- `NoPendingUnstake()`
- `ZeroPassedShares()`
- `InvalidShares()`
- `InvalidAmount()` (if share accounting mismatch)
- `TooLateToCancel()`
- `DirectWithdrawModeEnabled()`
- `CategoryPaused(PauseCategory.WITHDRAWALS)`

## APR / APY / TVL fallback from chain

Preferred production source:

- subgraph/indexer for TVL, share price, APR/APY, and rolling averages.

TVL / price:

- `totalAssets()`
- `pricePerShare()`

Yield stream inputs:

- `YieldNotified(yieldAmount, streamStart, streamEnd)` event

Suggested APR estimate at notify block:

- `duration = streamEnd - streamStart`
- `apr = (yieldAmount / totalAssetsAtNotify) * (SECONDS_PER_YEAR / duration)`

Suggested APY:

- `periodsPerYear = SECONDS_PER_YEAR / duration`
- `apy = (1 + apr / periodsPerYear) ^ periodsPerYear - 1`

Notes:

- Yield is streamed linearly, so APR is effectively flat over `[streamStart, streamEnd)`.
- You can read `yieldStreamingAmount`, `yieldStreamStart`, `yieldStreamEnd` for stream-state UI.

## UI checklist

1. Load tranche metadata + mode (`directWithdrawEnabled`).
2. Load TVL/state (`totalAssets`, `pricePerShare`, `unaccruedYield`, `totalSupply`).
3. Load deposit limits + computed `getDepositLimitInfo`.
4. Load epoch context (`currentEpochId`, `unstakeDelayEpochs`, `epochDuration`).
5. Load user state (`balanceOf`, per-epoch pending/claimable).
6. Load pause flags and disable actions accordingly.
7. Wire deposit flow with approval.
8. Wire request withdrawal by shares.
9. Wire umbrella claim/cancel actions when mode is umbrella.

## Error reference

- `DepositLimitExceeded(attempted, limit)` -> input exceeds remaining deposit capacity.
- `ZeroPassedShares()` -> zero-share request/cancel input.
- `InvalidBalance()` -> insufficient share balance for request.
- `NoPendingUnstake()` -> user has no pending request for that epoch.
- `InvalidShares()` -> cancel amount exceeds pending shares.
- `InvalidAmount()` -> invalid amount in current flow (including guard checks).
- `TooLateToCancel()` -> vault epoch already passed requested epoch.
- `NotFinalized()` -> claim attempted before epoch finalization.
- `NothingToClaim()` -> no claimable shares/assets for given epoch.
- `DirectWithdrawModeEnabled()` -> umbrella-only action called while direct mode is enabled.
- `DirectWithdrawModeDisabled()` -> direct path called while umbrella mode is enabled.
- `CategoryPaused(PauseCategory.X)` -> action paused by PauseManager.
