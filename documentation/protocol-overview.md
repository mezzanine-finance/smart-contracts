# Mezzanine Protocol (Phase 1) Overview

This document describes the current Phase 1 protocol architecture, core contracts, and
main user/operator flows as implemented in this repository.
It is a technical overview intended for engineers, integrators, and auditors.

## Summary

- Protocol accepts USDC (6 decimals) and mints MZUSD (18 decimals) at `1e12` scale.
- Users interact with ERC4626 `Tranche` contracts over MZUSD.
- Yield/loss accounting is initiated from NAV snapshots through `NavOracleAutomation`.
- Epochs coordinate tranche yield streaming and umbrella withdrawals.
- Access control is selector-based via OpenZeppelin `AccessManager`; emergency controls use `PauseManager`.

## Core contracts

### IssuanceVault (`contracts/IssuanceVault.sol`)

- Treasury/accounting hub (not ERC4626).
- Holds idle USDC and rebalances against `ReservoirUSDC`.
- Distributes yield by:
    - base pool share distributed pro-rata by TVL;
    - per-tranche risk premium shares (`riskPremiumBps`) from `setTrancheConfig`.
- Mints MZUSD for fees and allocations during yield distribution.
- Advances epoch on `distributeYield` and on `advanceEpoch` (called by `LossManager`).
- Pays USDC redemptions on `withdraw` (callable only by MZUSD).

### Tranche (`contracts/Tranche.sol`)

- ERC4626 vault with MZUSD as underlying asset.
- ERC4626 share token uses a non-zero decimal offset (`_decimalsOffset() = 3`), so share decimals are `21` while MZUSD remains `18`.
- Two withdrawal modes:
    - direct mode (`directWithdrawEnabled = true`): `requestWithdrawal(shares)` redeems immediately;
    - umbrella mode (`directWithdrawEnabled = false`): request -> finalize epoch -> claim.
- Umbrella mode includes optional unstake economics:
    - `unstakeYieldReductionBps`: slashes a share of positive pending-withdrawal yield at claim time;
- Streams notified yield linearly over `IssuanceVault.epochDuration()`.
- `totalAssets()` uses virtual NAV:
    - `balance(asset) - unaccruedYield - reservedAssets`.
- Optional deposit limits:
    - absolute cap (`maxDepositCap`);
    - TVL share cap vs `asset.totalSupply()` (`maxDepositTvlBps`).

### PolJuniorTranche (`contracts/PolJuniorTranche.sol`)

- Admin-managed POL tranche (no ERC4626 shares).
- Funded via direct MZUSD transfers.
- `withdraw` is AccessManager-restricted.
- `notifyYield` forwards yield immediately to `polPayout` (no streaming, no umbrella queue).
- Participates in losses via `burnMZUSD` when selected by `LossManager`.

Note (Phase 1 transfer safety):

- For known protocol tokens (USDC + protocol ERC20s), code uses direct ERC20 `transfer`/`transferFrom`.
- ERC4626 internal flows still rely on OpenZeppelin ERC4626 behavior for deposit/mint/withdraw/redeem transfers.

### Allowlist (`contracts/Allowlist.sol`)

- Manages per-account allowlisting for protocol access control.
- `verifyAccount(account)` returns `true` only if the account is allowlisted AND not sanctioned by Chainalysis.
- `add`, `remove`, `addBatch`, `removeBatch` are `restricted` (granted to `ALLOWLISTER_ROLE`).
- Integrates with Chainalysis `ISanctionsList` for real-time sanctions screening.
- Referenced by MZUSD to gate `deposit` and `requestWithdrawal`.

### MZUSD (`contracts/MZUSD.sol`)

- ERC20 with 18 decimals, USDC-backed mint/redeem interface.
- `deposit(amountUSDC)`:
    - requires caller to pass `Allowlist.verifyAccount` (allowlisted and not sanctioned);
    - transfers USDC to IssuanceVault;
    - mints `amountUSDC * 1e12` MZUSD.
- `requestWithdrawal(amountMZ)`:
    - requires caller to pass `Allowlist.verifyAccount` (allowlisted and not sanctioned);
    - converts to USDC with floor rounding (`usdcOut = amountMZ / 1e12`);
    - burns only `usdcOut * 1e12`;
    - enforces redemption cap window (with same-tx deposit/withdraw netting);
    - calls `IssuanceVault.withdraw` for USDC payout.
- `mint` is gated by `onlyVault`.
- `burn` is `restricted` (typically granted to tranche contracts via `BURNER_ROLE`).
- `setAllowlist` allows admin to update the allowlist address.

### ReservoirUSDC (`contracts/ReservoirUSDC.sol`)

- USDC buffer for rebalancing/liquidity.
- `deposit` is open (pause-gated).
- `withdraw` is AccessManager-restricted.

### LossManager (`contracts/LossManager.sol`)

- Applies losses by burning MZUSD across configured tranche order.
- Supports proportional paired burns via contiguous `isPairedWithNext` flags.
- Always calls `IssuanceVault.advanceEpoch()` before applying burns.
- `applyLoss` is callable only by the current `IssuanceVault.navOracle()` address.

### NavOracleAutomation (`contracts/automation/NavOracleAutomation.sol`)

- Stores NAV deltas (USDC 6d) with optional veto window.
- `submitNav` records delta vs MZUSD total supply at submission time.
- `performUpkeep`:
    - if yield delta: calls `IssuanceVault.distributeYield(deltaUSDC)`;
    - if loss delta: calls `LossManager.applyLoss(deltaUSDC)`.
- Zero-yield delta (`NAV == supply`) still calls `IssuanceVault.distributeYield(0)` (epoch advances if allowed by timing).

### Access + Pause

- `restricted` functions are governed by `AccessManager` target function roles.
- Category-based pause checks use `PauseManager` + `whenNotPaused`.
- MZUSD deposit/withdrawal additionally requires accounts to pass `Allowlist.verifyAccount` (allowlisted + not sanctioned).

## Units and scaling

- USDC: 6 decimals.
- MZUSD: 18 decimals.
- Tranche shares: 21 decimals (`_decimalsOffset() = 3` over 18-decimal asset).
- Scale: `1 USDC = 1e12 MZUSD units`.

## Core flows

### MZUSD mint

1. User calls `MZUSD.deposit(amountUSDC)`.
2. Allowlist verifies the caller (allowlisted and not sanctioned).
3. USDC is transferred to IssuanceVault.
4. User receives `amountUSDC * 1e12` MZUSD.

### MZUSD redemption

1. User calls `MZUSD.requestWithdrawal(amountMZ)`.
2. Allowlist verifies the caller (allowlisted and not sanctioned).
3. Amount is quantized to full USDC units (`floor(amountMZ / 1e12)`).
3. Redemption cap window is checked after atomic netting.
4. IssuanceVault pays USDC (pulling from Reservoir when needed).

Notes:

- Same-transaction deposits/withdrawals are netted before cap consumption.
- Redemption window duration is bounded by contract constants: min `1 hour`, max `30 days`.

### Tranche deposit

1. User approves MZUSD to tranche.
2. User calls `deposit` or `mint`.
3. Deposit limits are checked if enabled.

### Tranche withdrawal

- Direct mode:
    1. User calls `requestWithdrawal(shares)`.
    2. Shares are redeemed immediately.
- Umbrella mode:
    1. User calls `requestWithdrawal(shares)`.
    2. Shares are escrowed to target epoch: `currentEpochId + unstakeDelayEpochs`.
    3. Anyone (or automation) finalizes passed epoch via `finalizeEpoch(epochId)`.
    4. User claims MZUSD via `claim(epochId)`:
        - base payout is floor pro-rata from finalized epoch pool;
        - if `finalizationPrice > userSnapshotPrice`, optional yield slashing reduces payout;
        - if `finalizationPrice <= userSnapshotPrice`, slashing is zero.

Note:

- If user enters desired assets in UI, convert with `previewWithdraw(assets)` (round-up path) to compute shares for `requestWithdrawal`.

### Yield distribution

1. Oracle submits NAV.
2. After veto readiness, automation applies pending NAV.
3. On yield:

- IssuanceVault advances epoch;
- mints MZUSD fees;
- allocates remaining MZUSD by base TVL share + risk premium shares;
- transfers to each enabled tranche and calls `notifyYield`.

### Loss application

1. On loss delta, automation calls `LossManager.applyLoss`.
2. LossManager advances epoch via IssuanceVault.
3. Burns are applied by configured order/pairs.
4. Uncovered remainder is accumulated in `totalUncoveredLossMZ`.

### Rebalancing and idle buffer

- IssuanceVault keeps target idle buffer with hysteresis band.
- Above upper bound: deposits excess into Reservoir.
- Below lower bound: pulls from Reservoir (reverts if Reservoir has zero USDC).
- `setBuffer` has a single skip path: when pull is needed and Reservoir USDC is zero,
  it emits `BufferRebalanceSkipped(ReservoirEmpty)` and keeps new buffer settings.
  Other rebalance errors are not swallowed and still revert the `setBuffer` call.

## Epochs and yield streaming

- Epoch advancement is time-gated by `epochStart + epochDuration`.
- On advancement, `epochStart` is set to the current `block.timestamp` (advance-call time), not to prior `epochStart + epochDuration`.
- Delayed advancement therefore creates a gap in wall-clock time; missed periods are not backfilled as extra epochs.
- `IssuanceVault.distributeYield` always attempts epoch advancement before allocation logic.
- Tranches stream yield linearly between `yieldStreamStart` and `yieldStreamEnd`.
- `Tranche.totalAssets()` exposes virtual NAV:
    - `assetBalance - unaccruedYield - reservedAssets`.

## Operational controls

- Admin/config functions are `restricted`.
- User/protocol actions are additionally pause-gated by category.
- UUPS upgrades are exposed via `upgradeToAndCall`; access must be restricted in AccessManager.

## References

- Access roles: `documentation/access-control.md`
- Pause categories: `documentation/pause-manager.md`
- NAV automation ops: `integration-docs/NAV_AUTOMATION.md`
- Frontend tranche integration: `integration-docs/FRONTEND_TRANCHE_INTEGRATION.md`
- Subgraph notes: `integration-docs/SUBGRAPH_VAULT_TRANCHE.md`
