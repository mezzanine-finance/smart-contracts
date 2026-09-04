# CRE automation

Two independent workflows run every five minutes: [NAV application](nav-workflow/README.md)
and [delayed-withdrawal finalization](finalization-workflow/README.md). Each reads
`checkUpkeep(0x)` and submits a separate report for each ready target:

`CRE DON → KeystoneForwarder → vault's AutomationReceiver → performUpkeep(bytes)`

One receiver per vault checks the forwarder, organization owner, workflow ID,
chain selector and allowed target/function. The scheduled cron time prevents
repeated or older reports from being applied to the same target. The receiver
holds the protocol's automation role; the CRE organization owner is distinct
from the wallet administering the receiver.

## Setup and configuration

Install repository dependencies at the root (`npm ci`), then run
`bun install --frozen-lockfile` inside each workflow directory. CRE CLI and Bun
must be available. Log in with `cre login` and check the selected organization
with `cre whoami`; deploying to DON requires deploy access.

- `project.yaml`: RPCs for `staging-settings` (Sepolia) and `production-settings` (mainnet).
- Each `workflow.yaml`: workflow name, registry and artifact paths.
- Each `config.staging.json`: Sepolia targets, receivers, schedule and write gas limit.
- Each `config.production.json`: mainnet template with no configured vaults yet.
- `../scripts/deployment/config/cre-automation.sepolia.json`: receiver permissions and CRE identity.
- `../reports/deployments.json`: recorded receiver deployments and managed workflow IDs.

Hardhat transactions use the root `.env` configuration. Local CRE simulation uses
`cre/.env` (see `.env.example`); its private key is for the simulator, not the
organization owner. Never commit keys or `.env` files. The wrapper commands below
currently support Sepolia only.

## Commands

Run these from the **repository root**:

| Command (`npm run …`)                                        | Purpose                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `cre:status:sepolia`                                         | Read organization identity and receiver wiring; display mismatches.                                                          |
| `cre:check:sepolia`                                          | Strict read-only identity, target-role and receiver preflight.                                                               |
| `cre:setup:sepolia`                                          | Deploy/reuse receivers, sync config addresses, recompute IDs and apply permissions. Changes files and may send transactions. |
| `cre:simulate:sepolia`                                       | Run both workflows locally against live reads; reports/writes are simulated. No on-chain writes.                             |
| `cre:deploy:sepolia`                                         | Preflight, then deploy both workflows to DON. Does not deploy receivers.                                                     |
| `cre:deploy:nav:sepolia` / `cre:deploy:finalization:sepolia` | Deploy one workflow after preflight.                                                                                         |
| `cre:broadcast:sepolia`                                      | Local simulation with real Sepolia writes enabled; not a DON deployment.                                                     |

Normal setup order: review configs and organization → `setup` → `check` →
`simulate` → `deploy`. An active DON workflow runs without a local terminal.
`setup` alone does not deploy or update the workflow running in DON.

Source/config changes may change the workflow ID. Re-run `setup` and `check`
before deploying the changed workflow. Setup revokes obsolete IDs tracked in
deployment records; preserve those records. Until the updated workflow is
deployed, the old workflow can lose write permission.

To deliberately switch organizations, log into the intended organization, then run:

```bash
npm run cre:migrate-organization:sepolia -- org_EXPECTED_ID
```

This verifies the organization and deploy access, updates the configured identity,
and applies receiver permissions with the canonical forwarder. It does not move
or stop workflows in the old organization; manage their lifecycle separately.

The lower-level `deploy:cre-receivers:sepolia:plan` prints the receiver plan;
`:validate` also checks target bytecode and role mappings. Prefer `cre:setup:sepolia`
for complete receiver/config/ID synchronization.

## Simulation, DON and results

Local `--broadcast` uses a simulation forwarder. Receivers configured for the
canonical DON forwarder will reject it, even if the outer transaction succeeds.
Do not switch a live DON receiver to a mock just to run a local broadcast; use an
isolated test receiver or test writes through the deployed workflow.

Reads use finalized blocks, so a newly ready target may appear on a later cron
run. `upkeepNeeded=false` means no write is attempted. Per-target failures are
caught so other targets can still run; execution-level `Success` alone does not
prove every target succeeded.

- `[SUCCESS]`: transaction and receiver execution reported success.
- `[FAILED]`: preparation or write failed; inspect the accompanying error.
- `[UNCONFIRMED]`: receiver execution status was not returned; inspect the receipt.

In simulation these outcomes are simulated too. For real writes, verify `txHash`,
receiver/target events and the expected state change. Multiple node log lines
with the same hash do not represent multiple transactions.

From `cre/`, inspect deployed runs with:

```bash
cre workflow list --output json
cre execution list mezzanine-nav-workflow-staging --output json
cre execution list mezzanine-finalization-workflow-staging --output json
cre execution logs <execution-uuid>
```

## Tests

Run in **each workflow directory**:

```bash
bun run typecheck
bun test
```

These checks also run in CI. Receiver and config/permission-helper tests run from the root:

```bash
npx hardhat test test/AutomationReceiver.ts test/CREWorkflowConfig.ts test/CREWorkflowPermissions.ts
```

Unit tests use mocked capabilities. A DON write test additionally needs a ready
on-chain target; a successful read-only run does not cover that path.
