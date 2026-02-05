# Mezzanine Protocol (Phase 1) Overview

This document describes the Phase 1 protocol architecture, core contracts, and
the main user and operator flows. It is a technical overview intended for
engineers, integrators, and auditors.

## Summary

- The protocol accepts USDC and mints MZUSD (18 decimals) 1:1 with USDC (6 decimals).
- Users interact with ERC4626 tranches that hold MZUSD and represent tranche shares.
- Yield and losses are computed at the Vault level and then allocated to tranches.
- Epochs coordinate yield streaming and delayed (umbrella) withdrawals.
- AccessManager + PauseManager enforce admin control and emergency stops.

## Core contracts

### Vault (contracts/Vault.sol)

- Not an ERC4626 vault. It is the protocol treasury and accounting hub.
- Holds the USDC idle buffer and rebalances to the Reservoir.
- Mints MZUSD for yield distribution and pays protocol/performance fees.
- Tracks tranches and allocates yield based on weight \* TVL.
- Advances epochs on yield or loss events to keep withdrawals moving.
- Withdraws USDC to users when MZUSD redemptions occur.

### Tranche (contracts/Tranche.sol)

- ERC4626 vault with MZUSD as the asset and tranche shares as the receipt token.
- Two withdrawal modes:
    - Direct: normal ERC4626 redeem/withdraw is enabled.
    - Umbrella: user requests a withdrawal by shares, waits, then claims.
- Yield is streamed linearly over the current epoch (virtual NAV).
- Deposit limits can cap growth via absolute cap and % of MZUSD supply.

### PolJuniorTranche (contracts/PolJuniorTranche.sol)

- ERC4626 tranche intended for protocol-owned liquidity.
- Withdraw and redeem are AccessManager-restricted.
- Yield is forwarded immediately to `polPayout` (no streaming, no umbrella).
- Asset is **intended** to be MZUSD; initializer validates MZUSD authority/pause manager wiring.
- Vault address is immutable (constructor param) and validated on initialize.

Note (Phase 1 transfer safety):
- Explicit `SafeERC20.safeTransfer` usage in our contracts is limited to
  `Tranche.claim` and `PolJuniorTranche.notifyYield`. ERC4626 itself uses
  SafeERC20 internally for asset transfers in deposit/mint/withdraw/redeem.

### MZUSD (contracts/MZUSD.sol)

- ERC20 stablecoin, 18 decimals.
- Deposit USDC -> mint MZUSD 1:1 (scaled by 1e12).
- Withdrawal burns MZUSD and pulls USDC from the Vault.
- Global redemption cap per time window, with atomic netting within a tx.
- Mint is only callable by the Vault; burn is only callable by LossManager.

### ReservoirUSDC (contracts/ReservoirUSDC.sol)

- Holds idle USDC for rebalancing and liquidity management.
- Deposits are open (pause-gated); withdrawals are AccessManager-restricted.

### LossManager (contracts/LossManager.sol)

- Materializes losses by burning MZUSD from tranches in a configured order.
- Optional paired tranches can share losses proportionally by TVL.
- Forces an epoch advance on every loss application to avoid stuck withdrawals.

### NavOracleAutomation (contracts/automation/NavOracleAutomation.sol)

- Records NAV snapshots (USDC 6 decimals), enforces a veto window, and applies
  yield or loss via Chainlink Automation.
- If NAV >= MZUSD supply (scaled to USDC), it calls `Vault.distributeYield`.
- If NAV < supply, it calls `LossManager.applyLoss`.

### Access + Pause

- AccessManager gates all `restricted` functions by selector.
- PauseManager enforces category-based emergency stops.
- See `documentation/access-control.md` and `documentation/pause-manager.md`.

## Units and scaling

- USDC uses 6 decimals.
- MZUSD uses 18 decimals.
- Scaling constant: `1 USDC (6d) = 1 MZUSD (18d) = 1e12`.

## Core flows

### MZUSD mint (user deposit)

1. User calls `MZUSD.deposit(amountUSDC)`.
2. USDC is transferred to the Vault.
3. MZUSD is minted to the user at 1e12 scale.

### MZUSD redemption (user withdrawal)

1. User calls `MZUSD.requestWithdrawal(amountMZ)`.
2. MZUSD burns (rounded down to full USDC).
3. Global redemption cap is checked and consumed.
4. Vault sends USDC to the user, pulling from Reservoir if needed.

Notes:

- Deposits and withdrawals inside one tx are netted before caps are applied.
- Redemption caps are enforced per time window (min 1 hour, max 30 days).

### Tranche deposit

1. User approves MZUSD to the tranche.
2. User calls `Tranche.deposit(assets, receiver)` or `mint(shares, receiver)`.
3. Deposit limits are checked (global cap and % of MZUSD total supply).

### Tranche withdrawal (direct mode)

1. `directWithdrawEnabled` is true at deployment.
2. User calls `requestWithdrawal(shares)`.
3. Shares are redeemed immediately via ERC4626.

### Tranche withdrawal (umbrella mode)

1. User calls `requestWithdrawal(shares)`.
2. Shares move into the tranche contract and are assigned to a target epoch:
   `currentEpochId + unstakeDelayEpochs`.
3. After the epoch has passed, an admin or automation calls
   `finalizeEpoch(epochId)`.
4. User calls `claim(epochId)` to receive MZUSD.

### Yield distribution

1. Oracle submits NAV (USDC) to NavOracleAutomation.
2. After the veto period, automation applies the NAV.
3. If NAV is higher than supply, the delta is yield:
    - Vault advances the epoch.
    - Vault mints MZUSD for fees and tranche allocation.
    - Yield is split by tranche weight \* tranche TVL.
    - Each tranche receives MZUSD and starts a linear stream over the epoch.

### Loss application

1. If NAV is lower than supply, the delta is loss.
2. LossManager advances the epoch and burns MZUSD from tranches.
3. Losses are applied sequentially, or proportionally within configured pairs.
4. If TVL is insufficient, the call reverts.

### Rebalancing and idle buffer

- Vault targets an idle USDC buffer with a hysteresis band.
- If idle > upper bound: Vault deposits excess into Reservoir.
- If idle < lower bound: Vault pulls from Reservoir (reverts if empty).

## Epochs and yield streaming

- Vault epochs are time-based, with configurable duration.
- `Vault.distributeYield` advances the epoch every time it is called.
- Tranches stream yield linearly between `yieldStreamStart` and `yieldStreamEnd`.
- `Tranche.totalAssets()` uses a virtual NAV:
  `balance - unaccruedYield - reservedAssets`.

## Operational controls

- All admin setters are AccessManager-restricted.
- Category-based pauses can stop deposits, withdrawals, transfers, admin, or protocol flows.
- Upgradeability is UUPS; restrict `upgradeToAndCall` via AccessManager.

## Useful references

- Access control and roles: `documentation/access-control.md`
- Pause categories: `documentation/pause-manager.md`
- NAV automation setup: `integration-docs/NAV_AUTOMATION.md`
- Tranche UI integration: `integration-docs/FRONTEND_TRANCHE_INTEGRATION.md`
- Subgraph notes: `integration-docs/SUBGRAPH_VAULT_TRANCHE.md`
