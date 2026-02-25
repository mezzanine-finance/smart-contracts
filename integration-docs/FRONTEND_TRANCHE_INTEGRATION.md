# Tranche Front-End Integration (Deposit / Withdraw)

This guide covers current on-chain flows for user tranches.
Metrics (APR/APY/TVL) are typically sourced from subgraph/indexer, with on-chain fallback notes below.

## TL;DR behavior

- Standard user tranches are ERC4626 vaults over `MZUSD` (18 decimals).
- Tranche share token uses `_decimalsOffset() = 3`, so `Tranche.decimals()` is `21`.
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

- `name()` / `symbol()` / `decimals()` (share token display; currently `21`)
- `directWithdrawEnabled()` (direct vs umbrella flow)
- `totalAssets()` (TVL in MZUSD, 18d)
- `pricePerShare()` (MZUSD 18d per one whole share token = `10 ** decimals()` share units)
- `unaccruedYield()` (yield not yet reflected in NAV)
- `totalSupply()` (shares)
- `depositLimitEnabled()`
- `maxDepositCap()` (configured absolute cap value; when limits are enabled, `0` means zero-cap)
- `maxDepositTvlBps()`
- `getDepositLimitInfo()` (enabled, limit, limitByTvl, capEffective)
- `maxDeposit(user)` is ERC4626-default and may stay `MAX_UINT`; use `getDepositLimitInfo()` for protocol deposit limits
- `unstakeDelayEpochs()`
- `unstakeYieldReductionBps()` (bps, `< 10_000`)
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
- `isPaused(trancheAddress, PauseCategory.TRANSFERS)`

### Optional MZUSD widget data

- `getRemainingRedemptionCap()` -> `(capUSDC, usedUSDC, remainingUSDC)`
- `getRedemptionWindow()` -> `(windowStart, windowEnd, duration)`

Admin-only (ops panels):

- `setDepositLimits(cap, tvlBps)` (config update only)
- `setDepositLimitEnabled(enabled)` (toggle limits without changing cap/tvlBps)

## Deposit flow

### Pre-checks

1. Do not allow user deposits into `PolJuniorTranche`.
2. Check `PauseCategory.DEPOSITS`.
3. Ensure user has enough MZUSD.
4. Read and display current deposit limit.

### Deposit limit math (matches contract)

When `depositLimitEnabled == false`, effective limit is `MAX_UINT`.

`getDepositLimitInfo().cap` returns the effective cap:

- when limits are disabled: `MAX_UINT`.
- when limits are enabled: exactly the configured value (`maxDepositCap`) including `0` or `MAX_UINT`.
- note: with limits enabled, `maxDepositCap == 0` means effective cap is zero.
  When enabled:

- `tvl = totalAssets()`
- `supply = asset.totalSupply()` (MZUSD total supply)
- `maxTotalByTvl = supply * maxDepositTvlBps / 10_000`
- `limitByTvl = max(0, maxTotalByTvl - tvl)`
- `limitByCap = max(0, cap - tvl)`
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

Note on `PauseCategory.TRANSFERS`:

- In `Tranche`, transfer pause is enforced in ERC20 `_update`.
- `_update` is used by mint/burn/transfer internals, so when `TRANSFERS` is paused,
  these are also blocked: `deposit`, `mint`, `withdraw`, `redeem`,
  `requestWithdrawal`, `finalizeEpoch`.

### Step 1: request

Users request in **shares**:

- direct mode: immediate redeem in same tx.
- umbrella mode: pending request by target epoch.

If user enters assets in UI, convert with `previewWithdraw(assets)` before sending tx.
(`requestWithdrawal` is share-based and `previewWithdraw` matches the withdraw-side rounding path.)
Do not use `convertToShares` for this step: it rounds down and can under-request shares.

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

Tx: `Tranche.claim(user, epochId)`. Anyone can call on behalf of `user`; funds always go to `user`.

Rounding behavior:

- Claims are pro-rata with floor division for each user.
- Rounding dust may remain in `reservedAssets` after all users claim for that epoch.
- In umbrella mode, claim can include optional yield slashing:
    - `snapshot = userSnapshotPrice[user][epochId]` (captured at request time);
    - if `finalizationPrice <= snapshot` -> slashing is zero;
    - if `finalizationPrice > snapshot` -> slash applies on positive pending yield using `unstakeYieldReductionBps`.

Errors:

- `NothingToClaim()`
- `NotFinalized()`
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
6. Load pause flags (including `TRANSFERS`) and disable actions accordingly.
7. Wire deposit flow with approval.
8. Wire request withdrawal by shares.
9. Wire umbrella claim actions when mode is umbrella.

## Error reference

- `DepositLimitExceeded(attempted, limit)` -> input exceeds remaining deposit capacity.
- `ZeroPassedShares()` -> zero-share request input.
- `InvalidBalance()` -> insufficient share balance for request.
- `InvalidAmount()` -> invalid amount in current flow (including guard checks).
- `NotFinalized()` -> claim attempted before epoch finalization.
- `NothingToClaim()` -> no claimable shares/assets for given epoch.
- `DirectWithdrawModeEnabled()` -> umbrella-only action called while direct mode is enabled.
- `DirectWithdrawModeDisabled()` -> direct path called while umbrella mode is enabled.
- `CategoryPaused(PauseCategory.X)` -> action paused by PauseManager.
