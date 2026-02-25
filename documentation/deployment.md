# Deployment Guide (Phase 1)

This guide describes deployment and post-deploy wiring for the current contracts and scripts in this repo.

## Scope and topology

- IssuanceVault supports up to `MAX_TRANCHES = 50`.
- Typical topology:
    - 3 user tranches (`Tranche`): Senior, Mezzanine, Junior.

User tranches are all instances of the same `Tranche` contract with different config.

## Deployment order (recommended)

1. `AccessManager`
2. `PauseManager` (UUPS proxy)
3. USDC (real token or `MockUSDC`)
4. `ReservoirUSDC` (UUPS proxy)
5. `MZUSD` (UUPS proxy)
6. `IssuanceVault` (UUPS proxy)
7. User `Tranche` proxies
8. `LossManager` proxy
9. `NavOracleAutomation`
10. `UmbrellaEpochFinalizer` per umbrella tranche (optional)

## Wiring checklist

### Required core wiring

- `MZUSD.setVault(IssuanceVault)` (one-time)
- `ReservoirUSDC.setVault(IssuanceVault)` (one-time, tracking only)
- `IssuanceVault.setLossManager(LossManager)` (one-time)
- `IssuanceVault.setNavOracle(NavOracleAutomation)` (updatable, strict reference checks)

Notes:

- `IssuanceVault.setNavOracle` requires `lossManager` already set.
- Current loss flow burns via `MZUSD.burn` role-gating (`restricted`/`BURNER_ROLE`),
  so no extra LossManager wiring is required in MZUSD.

### Vault configuration

- Fees are initialized in `IssuanceVault.initialize`.
- Optional:
    - `setBuffer(idleBufferUSDC, hysteresisBps)` (updates config and triggers `_rebalance`)
    - `setEpochConfig(epochDurationSec)` (queued for next epoch)
- Register tranches with `registerTranche(trancheAddress)`.
- Configure order/pairs + distribution with
  `setTrancheConfig((tranche,riskPremiumBps,enabled)[], isPairedWithNext[], baseRewardBps)`.

`setTrancheConfig` invariant:

- `baseRewardBps + sum(riskPremiumsBps) == 10_000`

### Tranche configuration

- `setUnstakeDelayEpochs` for umbrella tranches.
- `setUnstakeYieldReductionBps` (optional): slash bps on positive pending-withdrawal yield at claim.
- `setDepositLimits(capMZUSD, tvlBps)` where needed.
- `setDepositLimitEnabled(enabled)` to toggle limits without changing `capMZUSD`/`tvlBps`.
- Deployment-time immutable:
    - Senior usually `directWithdrawEnabled = true`
    - umbrella tranches (Mezzanine/Junior) usually `directWithdrawEnabled = false`

### LossManager configuration

- Initialize with optional `maxLossPerTxUSDC`.
- Loss burn order and pair flags are configured on `IssuanceVault.setTrancheConfig(...)`
  and read by `LossManager` at runtime.
- Optional update later: `setMaxLossPerTxUSDC`.

### Seeding

- Mint MZUSD + fund IssuanceVault via `MZUSD.deposit(amountUSDC)`.
- Optional direct USDC transfer to IssuanceVault.
- Optional `ReservoirUSDC.deposit(amountUSDC)`.
- Optional dead-share seeding via `seed.deadShares[]` (deposits to `0x000000000000000000000000000000000000dEaD` only when tranche `totalSupply == 0`).
- Optional tranche seeding via regular `Tranche.deposit(assets, receiver)`.

`setBuffer` has one non-reverting skip case:
if pull is needed (`idle < low`) and Reservoir USDC balance is zero, it emits `BufferRebalanceSkipped`.
Other rebalance failures (for example access-control or pause conditions) still revert `setBuffer`.

### Automation

- Deploy `NavOracleAutomation(lossManager, vetoPeriodSec)`.
- Grant oracle submitter addresses permission for `submitNav`.
- Optional: deploy `UmbrellaEpochFinalizer` per umbrella tranche.
  It processes at most one epoch per upkeep transaction.
  During catch-up, expect one upkeep transaction per missed epoch.

For NAV oracle rotation:

1. resolve/reject pending NAV on old oracle,
2. deploy new oracle with same IssuanceVault/LossManager/MZUSD references,
3. grant new permissions,
4. call `IssuanceVault.setNavOracle(newOracle)`,
5. revoke old permissions.

## Access control setup

Recommended role mapping follows `scripts/deployment/deploy.ts`:

- IssuanceVault:
    - `rebalance` -> `KEEPER_ROLE`
    - admin setters (`setLossManager`, `setNavOracle`, `setFeeRates`, `setFeeReceivers`,
      `setBuffer`, `setEpochConfig`, `registerTranche`, `setTrancheConfig`) -> `ADMIN_ROLE`
- MZUSD:
    - `burn` -> `BURNER_ROLE`
    - admin setters (`setVault`, redemption config, `setWithdrawalFeeBps`) -> `ADMIN_ROLE`
- Reservoir:
    - `withdraw` -> `RESERVOIR_WITHDRAW_ROLE`
    - `setVault` -> `ADMIN_ROLE`
- Tranche:
    - admin setters (`setUnstakeDelayEpochs`, `setUnstakeYieldReductionBps`,
      `setDepositLimits`, `setDepositLimitEnabled`) -> `ADMIN_ROLE`
- LossManager:
    - `setMaxLossPerTxUSDC` -> `ADMIN_ROLE`
- NavOracleAutomation:
    - `submitNav` -> `ORACLE_ROLE`
    - `rejectPendingNav`, `setVetoPeriod`, `setOracles`, `setMaxAnswerStaleness` -> `ADMIN_ROLE`

Also grant `UPGRADER_ROLE` for `upgradeToAndCall` on UUPS contracts and pause roles on PauseManager.

## Scripts

- Orchestrator: `scripts/deployment/deploy.ts`
    - Reads network config, deploys contracts, wires references, configures roles, applies params/seeding.
    - Skips verification automatically on local networks.
- Role grants: `scripts/deployment/grantRoles.ts`
    - Grants configured role memberships (optionally `--include-dev`).
- Role cleanup: `scripts/deployment/renounceRoles.ts`
    - Renounces deployer roles only if safe replacement members already exist.
- Handoff flow: `scripts/deployment/handoffRoles.ts`
    - Runs grant + renounce in sequence.

## Config files

- Default path: `scripts/deployment/config/<network>.json`.
- Override path: `--config <path>`.
- `--network` selects the default config filename and deployment namespace.

## Config schema notes

Network configs live in `scripts/deployment/config/<network>.json`.

Important fields:

- `dev.deployer`
- `roleIds`:
    - `PAUSER_ROLE`, `UNPAUSER_ROLE`, `UPGRADER_ROLE`,
      `RESERVOIR_WITHDRAW_ROLE`, `KEEPER_ROLE`, `ORACLE_ROLE`, `BURNER_ROLE`
- `roles`:
    - `admin`, `pauser`, `unpauser`, `upgrader`
    - optional `reservoirWithdrawers`, `keepers`, `roleDelays`
- `usdc`:
    - real token address or mock config
- `mzusd.redemptionCapUSDC`:
    - required and must be non-zero (no on-chain upper-bound check vs USDC supply)
- `vault`:
    - fee bps, receivers, optional buffer/epoch config
- `tranches[]`:
    - `key`, `trancheId`, `riskPremiumBps`, `enabled`, `directWithdrawEnabled`, optional limits
- `lossManager.order`, `lossManager.isPairedWithNext`, optional `maxLossPerTxUSDC`
- `navOracle.vetoPeriodSec`, `navOracle.oracles`
- optional seeding and post-deploy options

### Detailed field notes

Global:

- `dev.deployer`: deployment signer / initial AccessManager admin.
- `dev.grantRoles` (optional): include deployer in role memberships during deploy flow.
- `roleIds`: custom `uint64` IDs for role mapping (must be unique).
- `roles.roleDelays.*` (optional): per-role execution delays in AccessManager.

USDC:

- `usdc.deployMock = true` requires `usdc.mock` block (name/symbol/decimals/initialMints).
- `usdc.deployMock = false` requires `usdc.address`.

MZUSD:

- `mzusd.redemptionCapUSDC`: required, non-zero.
- `mzusd.redemptionWindowDurationSec` (optional): queued via setter if different from current/pending.
- `mzusd.withdrawalFeeBps` (optional): withdrawal fee in bps. If omitted, deploy script does not set it.

IssuanceVault:

- `vault.performanceFeeBps`, `vault.protocolFeeBps`: required; combined max `5000`.
- `vault.performanceFeeReceiver`, `vault.protocolFeeReceiver`: required addresses.
- `vault.idleBufferUSDC` + `vault.hysteresisBps`: must be provided together.
- `vault.epochDurationSec` (optional): queued for next epoch.

Tranches:

- `tranches[].key`: unique logical key.
- `tranches[].trancheId`: required (`id` alias still accepted for backward compatibility).
- `tranches[].directWithdrawEnabled`: immutable deployment mode flag.
- `tranches[].riskPremiumBps` + `enabled`: used in IssuanceVault distribution config.
- `tranches[].unstakeYieldReductionBps` (optional):
    - applies via `setUnstakeYieldReductionBps`;
    - must be `< 10_000` bps.
- `tranches[].depositLimits` (optional):
    - `capMZUSD` preferred;
    - `capUSDC` accepted as deprecated alias (converted to MZUSD by script);
    - `tvlBps` optional.

Loss manager:

- `lossManager.order`: tranche key order for loss handling and tranche config ordering.
- `lossManager.isPairedWithNext`: same length as order; contiguous `true,true` encodes a pair.
- `lossManager.maxLossPerTxUSDC` optional (`0` disables).

Automation:

- `navOracle.vetoPeriodSec`: required.
- `navOracle.oracles`: addresses granted `ORACLE_ROLE`.
- `umbrellaFinalizer.enabled` (optional): deploy cursor-based finalizers for umbrella tranches.
- `umbrellaFinalizer.startEpoch` (optional): initial finalizer cursor; set carefully to avoid skipping old epochs.

Seed/post:

- `seed.mzusdDepositUSDC`, `seed.vaultUSDC`, `seed.reservoirUSDC` are optional USDC amounts.
- `seed.deadShares[]` seeds per-tranche dead shares (`amountMZUSD`) to keep supply non-zero; skipped when tranche supply is already non-zero.
- `seed.trancheDeposits[]` supports `amountMZUSD` (preferred) and deprecated `amountUSDC` alias.
- `postDeploy.renounceDeployerRoles` controls automatic role handoff/cleanup flow.
- `verify.enabled` toggles verification (local networks still skip verification).

Validation behavior from scripts:

- `vault.performanceFeeBps + vault.protocolFeeBps <= 5000`
- deploy config validator enforces distinct fee receivers, even though the IssuanceVault contract allows equal receivers.

## Notes and decisions

- `IssuanceVault.mzusd`, `IssuanceVault.reservoir` are immutable constructor params.
- `Tranche.vault`, `PolJuniorTranche.vault`, `LossManager.vault` are immutable constructor params.
- `directWithdrawEnabled` is immutable per tranche.
- Keep production configs explicit and review defaults before mainnet deployment.
