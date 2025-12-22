# Tranche Front-End Integration (Deposit / Withdraw / Cancel)

This doc explains how to wire tranche pages (senior, mezzanine, junior) to the smart contracts. It focuses on user flows and the exact calls you need. Metrics (APR/APY/TVL) should come from the subgraph in the current plan; a contract-based fallback is included below.

## TL;DR for UI behavior

- Each tranche is an ERC-4626 vault over **MZUSD (18 decimals)**.
- **Direct withdraw/redeem is disabled**. Users must request withdrawal, wait for epoch finalization, then claim.
- Junior/POL tranche (`isPolJunior == true`) is **not user-depositable**.

## Contracts you need per tranche page

- **Tranche** (ERC-4626 + custom withdrawal flow)
- **MZUSD** (asset token for deposits)
- **Vault** (for epoch timing and delay math)

You should have ABI + address for each.

## Read-only data to load per tranche page

From Tranche:
- `name()` / `symbol()` / `decimals()` (share token display)
- `isPolJunior()` (disable UI if true)
- `paused()` (from `PausableUpgradeable`)
- `totalAssets()` (TVL in MZUSD, 18d)
- `pricePerShare()` (MZUSD per share, 18d)
- `totalSupply()` (shares)
- `depositLimitEnabled()`
- `maxDepositCap()`
- `maxDepositTvlBps()`
- `unstakeDelayEpochs()`

From Vault:
- `currentEpochId()`
- `epochDuration()`

User-specific:
- `balanceOf(user)` (share balance)
- `getUserEpochInfo(user, epochId)` (pending/claimable info)

Optional for UI lists:
- `getEpochInfo(epochId)` (global umbrella totals for an epoch)

## Deposit flow (user deposit into a tranche)

### Pre-checks
1. `isPolJunior()` must be false. If true, disable deposit and show a "not depositable" message.
2. `paused()` must be false.
3. User must have enough **MZUSD** balance.
4. Check deposit limits (if enabled).

### Deposit limit calculation (matches `_checkDepositLimit`)

- If `depositLimitEnabled == false`: no limit.
- Else:
  - `tvl = totalAssets()` (18d)
  - `limitByTvl = (tvl == 0) ? MAX_UINT : (tvl * maxDepositTvlBps / 10_000)`
  - `finalLimit = min(limitByTvl, maxDepositCap)` if `maxDepositCap > 0`, otherwise `limitByTvl`.
  - If `amount > finalLimit`, deposit will revert.

### On user input
- For expected shares: `previewDeposit(assets)` (ERC-4626).
- Display expected shares and price-per-share.

### Transaction steps
1. `MZUSD.approve(tranche, amount)` (if allowance is insufficient).
2. `Tranche.deposit(assets, receiver)`

### Errors to handle
- `InvalidMode()` -> this is a POL/junior tranche.
- `DepositLimitExceeded(attempted, limit)` -> show limit.
- `InvalidAmount()` -> input zero or invalid.
- `Pausable: paused` -> contract paused.

## Withdraw flow (request + claim)

Direct `withdraw()` / `redeem()` is disabled and will always revert (`DirectWithdrawDisabled`).

### Step 1: Request withdrawal
Users request in **shares**, not assets.

#### Pre-checks
1. `isPolJunior()` must be false.
2. `paused()` must be false.
3. User has enough share balance (`balanceOf(user) >= shares`).

#### Share calculation
- If the user enters assets, convert to shares:
  - `convertToShares(assets)` (ERC-4626)

#### Transaction
- `Tranche.requestWithdrawal(shares)`

#### Errors to handle
- `ZeroPassedShares()`
- `InvalidBalance()` (not enough shares)
- `InvalidMode()`
- `Pausable: paused`

### Step 2: Wait for epoch finalization

The withdrawal request is tied to a target epoch:
- `targetEpoch = Vault.currentEpochId() + Tranche.unstakeDelayEpochs()`

An admin finalizes epochs by calling `Tranche.finalizeEpoch(epochId)` after the vault has advanced.

You can show a "pending" state until the target epoch is finalized.

### Step 3: Claim assets

Once finalized, the user claims actual MZUSD:
- `Tranche.claim(epochId)`

#### Errors to handle
- `NothingToClaim()`
- `NotFinalized()`
- `Pausable: paused`

## Cancel flow (user cancels a pending unstake)

Users can cancel before the epoch is finalized and before the vault moves past that epoch.

### Pre-checks
- `getUserEpochInfo(user, epochId).pendingShares > 0`
- `getUserEpochInfo(user, epochId).isFinalized == false`
- `Vault.currentEpochId() <= epochId`

### Transaction
- `Tranche.cancelUnstake(epochId, shares)`

### Errors to handle
- `NoPendingUnstake()`
- `InvalidShares()`
- `AlreadyFinalized()`
- `TooLateToCancel()`
- `Pausable: paused`

## APR / APY / TVL

### Preferred source (current plan)
Use the subgraph for:
- TVL
- Share price
- APR / APY
- 7d / 30d / 90d averages

### Contract fallback (if you need it)

TVL and share price:
- `totalAssets()` (TVL, 18d)
- `pricePerShare()` (18d)

APR/APY from on-chain data:
- Listen to `YieldNotified(epochId, yieldAmount, streamStart, streamEnd)` on the Tranche.
- At the notify block, fetch `totalAssets()`.
- `duration = streamEnd - streamStart`
- `apr = (yieldAmount / totalAssets) * (SECONDS_PER_YEAR / duration)`
- `apy = (1 + apr / (SECONDS_PER_YEAR / duration))^(SECONDS_PER_YEAR / duration) - 1`

Notes:
- Yield is streamed linearly, so APR is effectively constant over the stream period.
- `yieldStreamingAmount`, `yieldStreamStart`, `yieldStreamEnd` are readable if you want to reconstruct the stream state.

## UI checklist per tranche page

1. Load tranche metadata: `name`, `symbol`, `decimals`, `isPolJunior`.
2. Load state: `paused`, `totalAssets`, `pricePerShare`, `totalSupply`.
3. Load limits: `depositLimitEnabled`, `maxDepositCap`, `maxDepositTvlBps`.
4. Load epoch data: `currentEpochId`, `unstakeDelayEpochs`, `epochDuration`.
5. User state: `balanceOf`, `getUserEpochInfo` for pending epochs.
6. Wire deposit flow with allowance check and limit enforcement.
7. Wire request-withdrawal flow (shares-based).
8. Wire cancel + claim actions with proper eligibility checks.

## Common errors and what they mean

- `InvalidMode()` -> tranche is POL/junior; user actions are disabled.
- `DepositLimitExceeded(attempted, limit)` -> input exceeds dynamic cap.
- `ZeroPassedShares()` / `InvalidAmount()` -> user entered 0.
- `InvalidBalance()` -> insufficient shares to request withdrawal.
- `NoPendingUnstake()` -> user tries to cancel without a request.
- `TooLateToCancel()` -> vault epoch already advanced past target.
- `AlreadyFinalized()` -> epoch finalized; user must claim instead of cancel.
- `NotFinalized()` -> epoch not finalized; claim not ready.
- `NothingToClaim()` -> no pending shares for that epoch.
- `Pausable: paused` -> contract paused; disable user actions.

