# Tranche Front-End Integration (Deposit / Withdraw / Cancel)

This doc explains how to wire tranche pages (senior, mezzanine, junior) to the smart contracts. It focuses on user flows and the exact calls you need. Metrics (APR/APY/TVL) should come from the subgraph in the current plan; a contract-based fallback is included below.

## TL;DR for UI behavior

- Standard tranches are ERC-4626 vaults over **MZUSD (18 decimals)**.
- `PolJuniorTranche` is an admin-only escrow (no ERC-4626 shares).
- Direct withdraw/redeem depends on `directWithdrawEnabled()`.
    - If enabled: `requestWithdrawal(shares)` redeems immediately (same result as `redeem` to self).
    - If disabled: `requestWithdrawal(shares)` enters the umbrella flow (wait + claim).
- `PolJuniorTranche` is a separate contract for protocol-owned liquidity.
    - There is no `deposit` function; admins transfer MZUSD directly to the tranche address.
    - `withdraw` is AccessManager-restricted.
    - Do not expose it to users unless you control the admin flow.
    - Asset is **intended** to be MZUSD (not a generic ERC20 tranche).

## Contracts you need per tranche page

For standard tranches:

- **Tranche** (ERC-4626 + custom withdrawal flow)
- **MZUSD** (asset token for deposits)
- **Vault** (for epoch timing and delay math)

For POL tranches (if you expose them at all):

- **PolJuniorTranche** (admin-only escrow; no ERC-4626 shares)
- **MZUSD** (asset token for deposits)

You should have ABI + address for each.

## Read-only data to load per tranche page

From Tranche:

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
- `pauseManager()` (read PauseManager for category pauses)

From PauseManager:

- `isPaused(tranche, PauseCategory.DEPOSITS)`
- `isPaused(tranche, PauseCategory.WITHDRAWALS)`
- `isPaused(tranche, PauseCategory.TRANSFERS)` (also affects share mint/burn internals, see note below)

From Vault:

- `currentEpochId()`
- `epochDuration()`
- `getEpochConfig()` (epochId, start, duration)
- `getBufferConfig()` (buffer, hysteresis, low, high)
- `getTranches(start, count)` (addresses + weights + enabled flags)

User-specific:

- `balanceOf(user)` (share balance)
- `getUserEpochInfo(user, epochId)` (pending/claimable info)

Optional for UI lists:

- `getEpochInfo(epochId)` (global umbrella totals for an epoch)

Admin-only (ops panels):

- `setDepositLimits(enabled, cap, tvlBps)` (full config update)
- `setDepositLimitEnabled(enabled)` (toggle both limits only)

Optional for MZUSD (if you show mint/redeem widgets on tranche pages):

- `getRemainingGlobalRedemptionCap()` (remainingUSDC, windowStart)
- `getRedemptionWindow()` (capUSDC, usedUSDC, remainingUSDC, windowStart, windowEnd)

## Deposit flow (user deposit into a tranche)

### Pre-checks

1. If this address is a `PolJuniorTranche`, disable user deposits.
2. Deposits should be blocked when `PauseCategory.DEPOSITS` is paused.
3. User must have enough **MZUSD** balance.
4. Check deposit limits (if enabled).

### Deposit limit calculation (matches `_checkDepositLimit`)

- If `depositLimitEnabled == false`: no limit.
- Else:
    - `tvl = totalAssets()` (18d)
    - `supply = asset.totalSupply()` (18d)
    - If `supply == 0`: deposit will revert with `ZeroAssetSupply`.
    - `maxTotalByTvl = (supply * maxDepositTvlBps / 10_000)`
    - `limitByTvl = (maxTotalByTvl <= tvl) ? 0 : (maxTotalByTvl - tvl)`
    - `limitByCap = (maxDepositCap == 0) ? MAX_UINT : ((maxDepositCap <= tvl) ? 0 : (maxDepositCap - tvl))`
    - `finalLimit = min(limitByTvl, limitByCap)`
    - `finalLimit` is remaining capacity (global cap), not a per-transaction limit.
    - If `amount > finalLimit`, deposit will revert.

`getDepositLimitInfo().cap` returns the effective cap:

- `MAX_UINT` when limits are disabled, or when configured `maxDepositCap == 0`.
- otherwise the configured absolute cap value.

### On user input

- For expected shares: `previewDeposit(assets)` (ERC-4626).
- Display expected shares and price-per-share.

### Transaction steps

1. `MZUSD.approve(tranche, amount)` (if allowance is insufficient).
2. `Tranche.deposit(assets, receiver)`

### Errors to handle

- `DepositLimitExceeded(attempted, limit)` -> show limit.
- `ZeroAssetSupply()` -> MZUSD total supply is zero and limits are enabled.
- `InvalidAmount()` -> input zero or invalid.
- `CategoryPaused(PauseCategory.DEPOSITS)` -> deposits paused.

## Withdraw flow (request + claim or direct)

Read `directWithdrawEnabled()` to pick the correct UX. `withdraw()` / `redeem()` revert when direct
withdraw is disabled.

Note on `PauseCategory.TRANSFERS`:
- In `Tranche`, the transfer pause is enforced in ERC20 `_update`.
- `_update` is used by mint/burn/transfer internals, so when `TRANSFERS` is paused the following are also blocked:
  `deposit`, `mint`, `withdraw`, `redeem`, `requestWithdrawal`, `cancelUnstake`, `finalizeEpoch`.

### Step 1: Request withdrawal

Users request in **shares**, not assets. Behavior depends on `directWithdrawEnabled()`:

- **direct = true**: `requestWithdrawal(shares)` redeems immediately to the caller.
- **direct = false**: `requestWithdrawal(shares)` creates a pending umbrella request.

#### Pre-checks

1. If this address is a `PolJuniorTranche`, disable user withdrawals.
2. Withdrawals should be blocked when `PauseCategory.WITHDRAWALS` is paused.
3. User has enough share balance (`balanceOf(user) >= shares`).

#### Share calculation

- If the user enters assets, convert to shares:
    - `convertToShares(assets)` (ERC-4626)

#### Transaction

- `Tranche.requestWithdrawal(shares)`

#### Errors to handle

- `ZeroPassedShares()`
- `InvalidBalance()` (not enough shares)
- `CategoryPaused(PauseCategory.WITHDRAWALS)` -> withdrawals paused.

### Step 2: Wait for epoch finalization (umbrella mode only)

The withdrawal request is tied to a target epoch:

- `targetEpoch = Vault.currentEpochId() + Tranche.unstakeDelayEpochs()`

An admin finalizes epochs by calling `Tranche.finalizeEpoch(epochId)` after the vault has advanced.

You can show a "pending" state until the target epoch is finalized.

### Step 3: Claim assets (umbrella mode only)

Once finalized, the user claims actual MZUSD:

- `Tranche.claim(epochId)`

Rounding behavior:
- Claims are pro-rata with floor division for each user.
- Rounding dust may remain in `reservedAssets` after all users claim for that epoch.

#### Errors to handle

- `NothingToClaim()`
- `NotFinalized()`
- `DirectWithdrawModeEnabled()` -> claim not available in direct mode.
- `CategoryPaused(PauseCategory.WITHDRAWALS)` -> withdrawals paused.

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
- `DirectWithdrawModeEnabled()` -> cancel not available in direct mode.
- `CategoryPaused(PauseCategory.WITHDRAWALS)` -> withdrawals paused.

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

1. Load tranche metadata: `name`, `symbol`, `decimals`, `directWithdrawEnabled`.
2. Load state: `totalAssets`, `pricePerShare`, `unaccruedYield`, `totalSupply`.
3. Load limits: `depositLimitEnabled`, `maxDepositCap`, `maxDepositTvlBps`.
4. Load epoch data: `currentEpochId`, `unstakeDelayEpochs`, `epochDuration`.
5. Optional: `getDepositLimitInfo` to show remaining capacity.
6. User state: `balanceOf`, `getUserEpochInfo` for pending epochs.
7. Read `PauseManager.isPaused` for deposits/withdrawals/transfers and disable buttons.
8. Wire deposit flow with allowance check and limit enforcement.
9. Wire request-withdrawal flow (shares-based).
10. Wire cancel + claim actions with proper eligibility checks.

## Common errors and what they mean

- `DepositLimitExceeded(attempted, limit)` -> input exceeds dynamic cap.
- `ZeroAssetSupply()` -> MZUSD total supply is zero and limits are enabled.
- `ZeroPassedShares()` / `InvalidAmount()` -> user entered 0.
- `InvalidBalance()` -> insufficient shares to request withdrawal.
- `NoPendingUnstake()` -> user tries to cancel without a request.
- `TooLateToCancel()` -> vault epoch already advanced past target.
- `AlreadyFinalized()` -> epoch finalized; user must claim instead of cancel.
- `NotFinalized()` -> epoch not finalized; claim not ready.
- `NothingToClaim()` -> no pending shares for that epoch.
- `DirectWithdrawModeEnabled()` -> umbrella-only action called in direct mode.
- `DirectWithdrawModeDisabled()` -> direct withdraw/redeem called in umbrella mode.
- `CategoryPaused(PauseCategory.X)` -> action paused for that category.
