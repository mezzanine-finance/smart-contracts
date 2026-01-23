# Vault + Tranche Subgraph Notes

This doc is for building a The Graph subgraph over the Vault + Tranche contracts. It focuses on where to read data for tranche-level metrics (TVL, share price, APY) and how to build chart-ready time series.

## Scope and contracts

Primary sources:
- `contracts/Vault.sol`
- `contracts/Tranche.sol`

Supporting sources:
- `contracts/MZUSD.sol` (decimals and USDC <-> MZUSD scaling)
- `contracts/LossManager.sol` (optional: losses that burn tranche MZUSD)

## Tranche discovery and labeling (senior / mezzanine / junior)

Use a static list of tranche addresses. 

Labeling can be derived from on-chain metadata:
- Read `Tranche.name()` and `Tranche.symbol()` (ERC-20).
- Optionally use `Tranche.trancheId()` and contract type (Tranche vs PolJuniorTranche).
  - If you index PolJuniorTranche, tag `isPolTranche` from a static allowlist.

If you still need to validate against Vault config, you can query:
- `Vault.tranches(idx)` -> `(tranche, weight, enabled)`
- Events: `TrancheRegistered`, `TrancheUpdated`

## Units and scaling

- USDC: 6 decimals.
- MZUSD: 18 decimals.
- Vault mints MZUSD at `MZUSD_SCALE = 1e12` (1 USDC => 1 MZUSD).

All tranche-level metrics (TVL, share price, yield amounts) are in MZUSD (18 decimals).

## Key events to index

Vault (`Vault.sol`):
- `TrancheRegistered(tranche, weight, enabled)`
- `TrancheUpdated(idx, weight, enabled)`
- `YieldDistributed(usdcUsed, mintedMZUSD, epochId)`
- `EpochAdvanced(epochId, startTs)`
- `EpochDurationSet(epochDuration)`
- `FeesPaid(performanceMZUSD, protocolMZUSD, epochId)` (optional)

Tranche (`Tranche.sol`):
- `YieldNotified(epochId, yieldAmount, streamStart, streamEnd)`
- `Deposit` (ERC4626) + `Transfer` (ERC20 shares) (optional for user flows)
- `UnstakeRequested`, `EpochFinalized`, `WithdrawalClaimed` (optional)

LossManager (`LossManager.sol`, optional):
- `LossApplied(usdcLoss, lossMZ, tranches, cutsMZ)`

## Core metric derivations

### TVL (per tranche)

Canonical source: `Tranche.totalAssets()`.

Why: totalAssets is "virtual NAV" and accounts for linear yield streaming. It subtracts unaccrued yield from the raw MZUSD balance, which is the value users should see.

Suggested approach:
- On each `YieldNotified` event AND on periodic block snapshots (e.g., hourly/daily), call `totalAssets()`.
- Store as raw MZUSD (18d). Convert to display by dividing by 1e18.

### Share price (per tranche)

Canonical source: `Tranche.pricePerShare()`.

Alternative: `convertToAssets(10 ** decimals())` (ERC4626).

Notes:
- Share price is in MZUSD (18d per 1 share).
- If share supply is zero, ERC4626 returns 1.0 share price (1e18). Use the contract call as the source of truth.

### APR / APY (per tranche)

Yield is distributed by the Vault and streamed linearly by each Tranche.

Use the Tranche `YieldNotified` event:
- `yieldAmount` is in MZUSD (18d).
- `streamStart` and `streamEnd` are block timestamps.
- Duration seconds = `streamEnd - streamStart` (matches Vault `epochDuration` at the time).

Suggested APR formula at `YieldNotified`:
- `tvlBase = totalAssets()` at the event block (post-notify) or at `streamStart`.
- `apr = (yieldAmount / tvlBase) * (SECONDS_PER_YEAR / duration)`.

Suggested APY formula:
- `periodsPerYear = SECONDS_PER_YEAR / duration`.
- `apy = (1 + apr / periodsPerYear) ^ periodsPerYear - 1`.
- Alternative (continuous): `apy = exp(apr) - 1`.

For charting, you can treat the computed APR as constant over `[streamStart, streamEnd)` and forward-fill until the next `YieldNotified`.

## Chart data: raw points + averages

### Raw points

Store snapshots with timestamps:
- `TrancheSnapshot { tranche, timestamp, tvl, sharePrice, apr }`

Recommended snapshot triggers:
- Every `YieldNotified` (APY/APR changes).
- Periodic block-based snapshots (hourly or daily) for TVL/sharePrice.

### 7-day average (and other averages)

Use a time-weighted average over the window:
- `dt_i` is the duration between data points.
- `avgAPR = sum(apr_i * dt_i) / sum(dt_i)`

Same approach works for 30-day / 90-day averages.

If you use daily snapshots, you can also compute simple averages, but time-weighted is safer if samples are uneven.

## Streaming yield details (important for TVL)

Tranche streaming state:
- `yieldStreamingAmount`
- `yieldStreamStart`
- `yieldStreamEnd`

`totalAssets()` uses these to subtract unaccrued yield:
- If you compute TVL off-chain, you must reproduce this logic.
- Easier path: call `totalAssets()` and `pricePerShare()` at the block you index.

## Optional: losses

If `LossManager.applyLoss` is used, MZUSD is burned from tranches. TVL and share price will drop accordingly.
- If you only read `totalAssets()` at snapshot blocks, you will capture this without extra logic.
- If you want a loss annotation in charts, index `LossApplied`.

## Quick reference (view calls)

Vault:
- `tranchesLength()`
- `tranches(idx)`
- `currentEpochId()`
- `epochDuration()`

Tranche:
- `trancheId()`
- `name()` / `symbol()`
- `totalAssets()`
- `pricePerShare()`

## Suggested subgraph entities (minimal)

- `Vault`
  - `id`, `currentEpochId`, `epochDuration`
- `Tranche`
  - `id`, `vault`, `trancheId`, `name`, `symbol`, `weight`, `enabled`, `isPolTranche`
- `TrancheSnapshot`
  - `tranche`, `timestamp`, `tvl`, `sharePrice`, `apr`
- `TrancheYield`
  - `tranche`, `epochId`, `yieldAmount`, `streamStart`, `streamEnd`, `apr`, `apy`
