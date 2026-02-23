# Vault + Tranche Subgraph Notes

This document describes indexing strategy for Vault/Tranche metrics (TVL, share price, APR/APY).

## Scope

Primary contracts:

- `contracts/IssuanceVault.sol`
- `contracts/Tranche.sol`

Optional supporting contracts:

- `contracts/MZUSD.sol`
- `contracts/LossManager.sol`
- `contracts/PolJuniorTranche.sol` (if indexed)

## Tranche discovery

Recommended:

- Keep a static configured list of tranche addresses.

Optional on-chain reconciliation:

- `Vault.tranches(idx)` -> `(tranche, riskPremiumBps, enabled)`
- `Vault.tranchesLength()`
- `Vault.isTranche(address)`

Labeling hints (senior/mezzanine/junior):

- derive from configured address map first;
- use `Tranche.name()` / `Tranche.symbol()` as fallback metadata;
- optionally store `trancheId()` for stable internal mapping.

Key caveat:

- `Vault.TrancheRegistered` event currently emits only `address tranche` (no riskPremium/enabled payload).

## Units

- USDC: 6 decimals.
- MZUSD: 18 decimals.
- Tranche shares: `Tranche.decimals()` (currently `21`, due to `_decimalsOffset() = 3`).
- Scale: `1 USDC = 1e12 MZUSD units`.

Tranche TVL/share-price/yield metrics are in MZUSD units (18d); share balances/supply are in tranche share units.

## Events to index

### IssuanceVault

- `TrancheRegistered(address tranche)`
- `TrancheConfigUpdated()`
- `YieldDistributed(usdcUsed, mintedMZUSD, epochId)`
- `EpochAdvanced(epochId, startTs)`
- `EpochDurationSet(epochDuration)`
- `FeesPaid(performanceMZUSD, protocolMZUSD, epochId)` (optional)

`EpochAdvanced.startTs` semantics:

- `startTs` is the block timestamp of the tx that advanced the epoch.
- It is not computed as previous `epochStart + epochDuration`.
- If advancement is delayed, wall-clock gaps can appear between epoch boundaries.

Risk premium, enabled flags, order, and pair updates are set through
`IssuanceVault.setTrancheConfig(...)`; indexers can refresh tranche config on each `TrancheConfigUpdated`.

### Tranche

- `YieldNotified(yieldAmount, streamStart, streamEnd)`
- ERC4626/20 events: `Deposit`, `Withdraw`, `Transfer` (optional)
- Umbrella events: `UnstakeRequested`, `EpochFinalized`, `WithdrawalClaimed`

### LossManager (optional)

- `LossApplied(usdcLoss, requestedMZ, burnedMZ, uncoveredMZ, totalUncoveredMZ)`

## Metric derivation

### TVL

Canonical source: `Tranche.totalAssets()`.

Why:

- It already accounts for linear yield streaming by subtracting unaccrued yield and reserved assets.

### Share price

Canonical source: `Tranche.pricePerShare()`.

Alternative:

- `convertToAssets(10 ** decimals())`

Note:

- When share supply is zero, `pricePerShare()` still returns ~`1e18` (1 MZUSD per whole share token),
  even though share token decimals are 21.

### APR/APY

Use `YieldNotified(yieldAmount, streamStart, streamEnd)`:

- `duration = streamEnd - streamStart`
- fetch `totalAssets()` around notify block as base TVL
- `apr = (yieldAmount / tvlBase) * (SECONDS_PER_YEAR / duration)`
- derive APY from APR per your compounding model

Note:

- Event does not include epoch id directly. If needed, resolve epoch via `Vault.currentEpochId()` at indexed block.
- For charting, APR from one notify can be treated as constant over the stream interval.

## Snapshot strategy

Store periodic tranche snapshots (hourly/daily) plus event-triggered snapshots on `YieldNotified`.

Suggested entity:

- `TrancheSnapshot { tranche, timestamp, tvl, sharePrice, apr }`

For moving averages (7d/30d/90d), prefer time-weighted averages when sample spacing is irregular.
Example:

- `avgAPR = sum(apr_i * dt_i) / sum(dt_i)`

## Streaming details

Useful tranche fields:

- `yieldStreamingAmount`
- `yieldStreamStart`
- `yieldStreamEnd`

If you compute NAV off-chain manually, replicate contract logic from `totalAssets()`:

- subtract unaccrued stream portion;
- subtract `reservedAssets`.

## Loss annotations

Losses reduce tranche balances via burn flow and are reflected in `totalAssets()`.
Index `LossApplied` to annotate charts with explicit loss events.

## Quick call reference

Vault:

- `tranchesLength()`
- `tranches(idx)`
- `currentEpochId()`
- `epochDuration()`

Tranche:

- `trancheId()`
- `name()`, `symbol()`
- `totalAssets()`
- `pricePerShare()`

## Minimal entity set

- `Vault { id, currentEpochId, epochDuration, baseRewardBps }`
- `Tranche { id, vault, trancheId, name, symbol, decimals, riskPremiumBps, enabled, isPolTranche }`
- `TrancheSnapshot { tranche, timestamp, tvl, sharePrice, apr }`
- `TrancheYield { tranche, txHash, yieldAmount, streamStart, streamEnd, apr, apy, epochId? }`
