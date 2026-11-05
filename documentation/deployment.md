# Deployment Guide

This guide describes the current config-driven deployment flow, post-deploy wiring,
role handoff, verification and recovery procedures.

## Operator runbook

### 1. Create and review the config

Create one config per vault under `scripts/deployment/config/`. For a mainnet vault,
start from a reviewed mainnet config with the same topology. Do not copy live addresses,
operators or feeds from a testnet profile.

Before running anything, review at least:

- `deploymentId` and `infrastructureId`;
- the deployer and every final role member, including role delays;
- the USDC address, fee receivers, fee rates, epoch and buffer settings;
- tranche IDs, names, symbols, withdrawal mode, limits, loss order and pair flags;
- NAV and total-supply feeds, submitters, veto period and answer-staleness limit;
- finalizer creation, initial seeding, role renunciation and verification.

The private key used by Hardhat must resolve to `dev.deployer`. The deployer needs ETH
for every transaction and, when seeding is configured, enough USDC/MZUSD for the seed.
Keep secrets in the environment; never put them in a config or commit them.

Required environment variables for Ethereum mainnet are:

```sh
MAINNET_RPC=<ethereum-rpc-url>
DEPLOYER_PK=<deployer-private-key>
ETHERSCAN_API_KEY=<etherscan-api-key>
```

`FORKING_URL` can be used instead of `MAINNET_RPC`. `DEV_ACCOUNT` is a legacy private-key
fallback; prefer `DEPLOYER_PK`.

### 2. Validate locally and preview the deployment

Run the relevant tests and compile with the same compiler settings used by deployment:

```sh
npm run compile
npm run clean:oz
FORKING=false TEST_DEPLOYMENT_WITHOUT_SEEDING=true \
npx hardhat test test/DeploymentWithoutSeeding.ts
```

Then print the deployment plan. This reads the config and local deployment records but
does not connect to the chain, require a funded signer or send transactions:

```sh
DEPLOY_CONFIG=scripts/deployment/config/mainnet-vault-1-test.json \
DEPLOY_PLAN=true npm run deploy:mainnet
```

Confirm that the plan creates or reuses the intended contracts in the intended
namespaces. A plan is not an on-chain simulation and does not prove that privileged
calls, feeds or balances will work.

### 3. Rehearse on a mainnet fork

Run the deployment against a recent mainnet fork before the real transaction. The local
network impersonates `dev.deployer`, funds it with test ETH and uses current mainnet
contract state through the fork:

```sh
FORKING=true \
FORKING_URL=<ethereum-rpc-url> \
DEPLOY_CONFIG=scripts/deployment/config/mainnet-vault-1-test.json \
DEPLOYMENTS_PATH=/tmp/mezzanine-fork-deployments.json \
npm run deploy:hardhat
```

Use a temporary `DEPLOYMENTS_PATH` so the rehearsal cannot reuse or modify production
records. The script skips Etherscan verification on the local network. A fork run checks
execution against forked state; it does not predict the exact mainnet gas price.

### 4. Execute the mainnet deployment

Ensure `reports/deployments.json` is committed and contains the records that should be
reused. Then run:

```sh
DEPLOY_CONFIG=scripts/deployment/config/mainnet-vault-1-test.json npm run deploy:mainnet
```

The orchestrator deploys or reuses contracts, saves each successful deployment as it
occurs, wires references, applies configuration, grants roles, runs post-deploy checks,
attempts verification and prints an address and gas summary.

Do not use `DEPLOY_FRESH=true` for a normal rerun. It deploys a new set of vault-specific
contracts in the same namespace. `DEPLOY_FRESH_SHARED=true` also replaces shared
infrastructure and is only appropriate when that replacement is intentional.

### 5. Hand off roles

`postDeploy.renounceDeployerRoles: true` requests cleanup, but the deploy script only
prints a reminder. It does not renounce roles automatically. After checking that every
replacement role holder is correct, run the separate handoff command with the same
config:

```sh
DEPLOY_CONFIG=scripts/deployment/config/mainnet-vault-1-test.json \
npm run deploy:handoff-roles -- --network mainnet
```

The handoff first grants the configured roles and then removes temporary deployer roles.
The renunciation script refuses unsafe removal when a required replacement member is
missing. AccessManager execution delays still apply; a delay reduction may become
effective only after the existing delay has elapsed.

### 6. Verify and archive the result

Treat deployment as complete only after all of the following checks pass:

- the final script output says `Deployment checks passed`;
- every expected address and implementation is present under
  `reports/deployments.json[network][deploymentId]` or the shared infrastructure namespace;
- each UUPS proxy resolves to the recorded implementation;
- every proxy, implementation and direct contract shows verified source on Etherscan;
- core references, tranche order, fees, feeds, buffer, role members and delays match the
  approved config;
- temporary deployer roles have been removed when handoff was requested;
- `reports/deployments.json` and the exact config used for deployment are committed.

Verification failures are logged as warnings so a verification API problem does not
undo a successful deployment. Check Etherscan explicitly and rerun verification for any
missing address before reporting completion.

### Interrupted deployment and reruns

The deployment file is a recovery record: each contract is saved immediately after its
transaction succeeds. On rerun, the script reuses the latest recorded address only when
bytecode exists there, then continues wiring and configuration idempotently where
supported.

Before rerunning after a failure, inspect the last successful transaction and the saved
records. Initial seeding is deliberately skipped for reused contracts, so reconcile any
partially completed funding manually. A rerun can still apply changed configuration to
existing contracts; always diff the config against the version used in the failed run.

## Deploying another vault

Use one config per vault, selected with `DEPLOY_CONFIG`. `deploymentId` identifies
its records under `reports/deployments.json[network][deploymentId]`. Keep this ID
stable on reruns; use a new ID for a new vault.

Configs can `extends` a JSON profile relative to their own directory. Nested
objects inherit fields; arrays replace the entire inherited list. In particular,
tranches, oracle members and seed deposits are never concatenated. Explicit `null`
replaces a value too, but must still be valid for that field. The merged config is
validated before deploying. The Sepolia vault configs share `profiles/sepolia.json`
for infrastructure/operator settings and define their own vault/tranche settings.
This is a testnet profile; create a separate profile with real asset/feed addresses
and intended operators for production.

`infrastructureId` selects the namespace for AccessManager, PauseManager,
AllowlistStub and optional MockUSDC. Vaults using the same infrastructure ID reuse
those contracts. A different ID selects an independent infrastructure group.
It must differ from `deploymentId`. Existing configs without `infrastructureId`
retain their behavior: named vaults use `shared`; unnamed legacy configs use the
network's top-level records. No addresses are migrated by this refactor.

For a new vault, copy a suitable vault config, choose a new `deploymentId`, then
set fees, epoch duration, tranche list, loss order, feeds and optional seeding.
Choose an existing infrastructure ID to share management, or a new one to create
an independent group. Sharing AccessManager also shares role membership: a member
can call every target mapped to that role. It does not provide per-vault role
isolation. Role renunciation/handoff affects the entire manager, not just one vault.

After creating the config, follow the operator runbook above for planning, fork rehearsal,
deployment, role handoff and verification.

## Scope and topology

- IssuanceVault supports up to `MAX_TRANCHES = 50`.
- Typical topology:
    - 3 user tranches (`Tranche`): Senior, Mezzanine, Junior.

User tranches are all instances of the same `Tranche` contract with different config.

## Deployment order (recommended)

1. `AccessManager`
2. `PauseManager` (UUPS proxy)
3. USDC (real token or `MockUSDC`)
4. `AllowlistStub` (shared, non-upgradeable)
5. `ReservoirUSDC` (UUPS proxy)
6. `MZUSD` (UUPS proxy)
7. `IssuanceVault` (UUPS proxy)
8. User `Tranche` proxies
9. `LossManager` proxy
10. `NavOracleAutomation`
11. `UmbrellaEpochFinalizer` per umbrella tranche (optional)

## Wiring checklist

### Required core wiring

- `AllowlistStub` address is passed to `MZUSD.initialize` (set at deployment)
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
- AllowlistStub: always returns `true`; no operator roles or sanctions checks.
  This permissive implementation is intended for both production and test deployments.
- MZUSD:
    - `burn` -> `BURNER_ROLE`
    - admin setters (`setVault`, `setAllowlist`, redemption config, `setWithdrawalFeeBps`) -> `ADMIN_ROLE`
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
UUPS proxies do not use a separate `ProxyAdmin`; AccessManager restricts each proxy's
`upgradeToAndCall` entry point.

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
      `RESERVOIR_WITHDRAW_ROLE`, `KEEPER_ROLE`, `ORACLE_ROLE`, `BURNER_ROLE`,
      `ALLOWLISTER_ROLE`, `FINALIZER_ROLE`, `CHAINLINK_AUTOMATION`
- `roles`:
    - `admin`, `pauser`, `unpauser`, `upgrader`
    - optional `reservoirWithdrawers`, `keepers`, `oracles`, `allowlisters`, `roleDelays`
- `usdc`:
    - real token address or mock config
- `allowlist`: retained for config compatibility; the orchestrator deploys the
  permissive `AllowlistStub`, which does not use a sanctions list.
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

Allowlist:

- `allowlist`: compatibility section; `AllowlistStub` accepts all accounts without
  querying a sanctions list.

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
- `roles.oracles`: final oracle-role members used by the role handoff scripts. Keep this
  list aligned with `navOracle.oracles` unless a staged handoff intentionally differs.
- `navOracle.navFeed` and `navOracle.totalSupplyFeed`: required when mock feeds are not
  deployed.
- `navOracle.maxAnswerStalenessSec` (optional): maximum accepted feed age.
- `umbrellaFinalizer.enabled` (optional): deploy cursor-based finalizers for umbrella tranches.
- `umbrellaFinalizer.startEpoch` (optional): initial finalizer cursor; set carefully to avoid skipping old epochs.

Seed/post:

- `seed.mzusdDepositUSDC`, `seed.vaultUSDC`, `seed.reservoirUSDC` are optional USDC amounts.
- All seed operations run only for targets created in the current invocation. Reused contracts are skipped, even if their balances are zero or seed amounts change. After an interrupted deployment, inspect confirmed transfers and complete missing funding separately; rerunning deployment does not resume seeding. Preserve deployment records. A fresh replacement contract receives its own initial seed.
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
