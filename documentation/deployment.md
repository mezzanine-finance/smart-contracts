# Deployment Guide (Phase 1)

This guide describes deployment and post-deploy wiring for the current contracts and scripts in this repo.

## Scope and topology

- Vault supports up to `MAX_TRANCHES = 50`.
- Typical topology:
  - 3 user tranches (`Tranche`): Senior, Mezzanine, Junior.
  - optional `PolJuniorTranche` for protocol-owned liquidity.

User tranches are all instances of the same `Tranche` contract with different config.

## Deployment order (recommended)

1. `AccessManager`
2. `PauseManager` (UUPS proxy)
3. USDC (real token or `MockUSDC`)
4. `ReservoirUSDC` (UUPS proxy)
5. `MZUSD` (UUPS proxy)
6. `Vault` (UUPS proxy)
7. User `Tranche` proxies
8. `PolJuniorTranche` proxy (optional)
9. `LossManager` proxy
10. `NavOracleAutomation`
11. `UmbrellaEpochFinalizer` per umbrella tranche (optional)

## Wiring checklist

### Required core wiring

- `MZUSD.setVault(Vault)` (one-time)
- `ReservoirUSDC.setVault(Vault)` (one-time, tracking only)
- `Vault.setLossManager(LossManager)` (one-time)
- `Vault.setNavOracle(NavOracleAutomation)` (updatable, strict reference checks)

Notes:

- `Vault.setNavOracle` requires `lossManager` already set.
- Current loss flow does **not** require `MZUSD.setLossManager` for burn gating.
  `MZUSD.burn` is role-gated (`restricted`/`BURNER_ROLE`), not `onlyLossManager`.
- `MZUSD.setLossManager` remains available as one-time storage wiring for compatibility.

### Vault configuration

- Fees are initialized in `Vault.initialize`.
- Optional:
  - `setBuffer(idleBufferUSDC, hysteresisBps)` (triggers `_rebalance`)
  - `setEpochConfig(epochDurationSec)` (queued for next epoch)
- Register tranches with `addTranche(...)`.
- Configure distribution with `setYieldDistribution(baseRewardBps, riskPremiumsBps[], enabled[])`.

`setYieldDistribution` invariant:

- `baseRewardBps + sum(riskPremiumsBps) == 10_000`

### Tranche configuration

- `setUnstakeDelayEpochs` for umbrella tranches.
- `setDepositLimits(enabled, capMZUSD, tvlBps)` where needed.
- Deployment-time immutable:
  - Senior usually `directWithdrawEnabled = true`
  - umbrella tranches usually `directWithdrawEnabled = false`

### LossManager configuration

- Initialize with:
  - `order[]`
  - `isPairedWithNext[]` (`true,true` contiguous encoding for pairs)
  - optional `maxLossPerTxUSDC`
- Optional update later:
  - `setTrancheOrderAndPairs`
  - `setMaxLossPerTxUSDC`

### Seeding

- Mint MZUSD + fund Vault via `MZUSD.deposit(amountUSDC)`.
- Optional direct USDC transfer to Vault.
- Optional `ReservoirUSDC.deposit(amountUSDC)`.
- Optional initial tranche deposits via `Tranche.deposit`.

If using `setBuffer`, ensure Vault/Reservoir have enough USDC to avoid rebalance failure.

### Automation

- Deploy `NavOracleAutomation(lossManager, vetoPeriodSec)`.
- Grant oracle submitter addresses permission for `submitNav`.
- Optional: deploy `UmbrellaEpochFinalizer` per umbrella tranche.
  It processes at most one epoch per upkeep transaction.
  During catch-up, expect one upkeep transaction per missed epoch.

For NAV oracle rotation:

1. resolve/reject pending NAV on old oracle,
2. deploy new oracle with same Vault/LossManager/MZUSD references,
3. grant new permissions,
4. call `Vault.setNavOracle(newOracle)`,
5. revoke old permissions.

## Access control setup

Recommended role mapping follows `scripts/deployment/deploy.ts`:

- Vault:
  - `rebalance` -> `KEEPER_ROLE`
  - admin setters (`setLossManager`, `setNavOracle`, `setFeeRates`, `setFeeReceivers`,
    `setBuffer`, `setEpochConfig`, `addTranche`, `setYieldDistribution`) -> `ADMIN_ROLE`
- MZUSD:
  - `burn` -> `BURNER_ROLE`
  - admin setters (`setVault`, `setLossManager`, redemption config) -> `ADMIN_ROLE`
- Reservoir:
  - `withdraw` -> `RESERVOIR_WITHDRAW_ROLE`
  - `setVault` -> `ADMIN_ROLE`
- LossManager:
  - `setTrancheOrderAndPairs`, `setMaxLossPerTxUSDC` -> `ADMIN_ROLE`
- NavOracleAutomation:
  - `submitNav` -> `ORACLE_ROLE`
  - `rejectPendingNav`, `setVetoPeriod` -> `ADMIN_ROLE`

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
- optional `polJunior`
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

Vault:

- `vault.performanceFeeBps`, `vault.protocolFeeBps`: required; combined max `5000`.
- `vault.performanceFeeReceiver`, `vault.protocolFeeReceiver`: required addresses.
- `vault.idleBufferUSDC` + `vault.hysteresisBps`: must be provided together.
- `vault.epochDurationSec` (optional): queued for next epoch.

Tranches:

- `tranches[].key`: unique logical key.
- `tranches[].trancheId`: required (`id` alias still accepted for backward compatibility).
- `tranches[].directWithdrawEnabled`: immutable deployment mode flag.
- `tranches[].riskPremiumBps` + `enabled`: used in Vault distribution.
- `tranches[].depositLimits` (optional):
  - `capMZUSD` preferred;
  - `capUSDC` accepted as deprecated alias (converted to MZUSD by script);
  - `tvlBps` optional.

Pol junior (optional):

- `polJunior.enabled`: deploy POL tranche.
- `polJunior.registerInVault`: if true, adds POL tranche to Vault distribution.
- `polJunior.riskPremiumBps`: required when `registerInVault=true`.

Loss manager:

- `lossManager.order`: tranche key order (supports `polJunior` key if enabled).
- `lossManager.isPairedWithNext`: same length as order; contiguous `true,true` encodes a pair.
- `lossManager.maxLossPerTxUSDC` optional (`0` disables).

Automation:

- `navOracle.vetoPeriodSec`: required.
- `navOracle.oracles`: addresses granted `ORACLE_ROLE`.
- `umbrellaFinalizer.enabled` (optional): deploy cursor-based finalizers for umbrella tranches.
- `umbrellaFinalizer.startEpoch` (optional): initial finalizer cursor; set carefully to avoid skipping old epochs.

Seed/post:

- `seed.mzusdDepositUSDC`, `seed.vaultUSDC`, `seed.reservoirUSDC` are optional USDC amounts.
- `seed.trancheDeposits[]` supports `amountMZUSD` (preferred) and deprecated `amountUSDC` alias.
- `postDeploy.renounceDeployerRoles` controls automatic role handoff/cleanup flow.
- `verify.enabled` toggles verification (local networks still skip verification).

Validation behavior from scripts:

- `vault.performanceFeeBps + vault.protocolFeeBps <= 5000`
- deploy config validator enforces distinct fee receivers, even though the Vault contract allows equal receivers.

## Notes and decisions

- `Vault.mzusd`, `Vault.reservoir` are immutable constructor params.
- `Tranche.vault`, `PolJuniorTranche.vault`, `LossManager.vault` are immutable constructor params.
- `directWithdrawEnabled` is immutable per tranche.
- `PolJuniorTranche` can be registered into Vault distribution, or kept outside it.
- Keep production configs explicit and review defaults before mainnet deployment.
