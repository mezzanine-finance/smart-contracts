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

A third [test NAV submitter](nav-submitter-workflow/README.md) exists only for Sepolia.
It generates deterministic test submissions before the normal NAV workflow applies them.
It must never be configured or deployed for mainnet.

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
- `../reports/deployments.json`: deployment history for all protocol and CRE contracts,
  grouped by network and vault. CRE receiver records also contain managed workflow IDs.

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

## Sources of truth

CRE configuration is split across files because the receiver and each workflow need
different data:

| File                                                    | Controls                                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/deployment/config/cre-automation.sepolia.json` | AccessManager, forwarder, organization owner, allowed workflow IDs and every target a vault receiver may call.                                                   |
| `cre/nav-workflow/config.staging.json`                  | IssuanceVault, NavOracleAutomation and receiver used by the pending-NAV workflow.                                                                                |
| `cre/finalization-workflow/config.staging.json`         | IssuanceVault, finalizers and receiver used by the withdrawal-finalization workflow.                                                                             |
| `cre/nav-submitter-workflow/config.staging.json`        | Sepolia-only mock submitter and receiver. This file is not synchronized by `cre:setup:sepolia`.                                                                  |
| `reports/deployments.json`                              | Deployment history for all protocol and CRE contracts, grouped by network and vault. CRE receiver records also store replacement links and tracked workflow IDs. |

Use the same vault ID as the protocol deployment namespace, for example `vault-1`.
The NAV and finalization configs must contain the same vault IDs and the same receiver
for each ID. `cre:setup:sepolia` enforces this relationship and writes deployed receiver
addresses into those two configs.

Each vault's `targets` list contains the contract addresses that its receiver allows CRE
to call. For example, `vault-1` currently allows calls to its `NavOracleAutomation`,
Senior finalizer and Junior finalizer. `IssuanceVault` is listed separately in workflow
configuration so CRE can read vault state, but the current workflows do not call it
through the receiver, so it is not included in `targets`.

## Adding a vault on Sepolia

Deploy and finish the protocol vault first. Its records must exist under
`reports/deployments.json.sepolia[deploymentId]`, and AccessManager must map
`performUpkeep(bytes)` on each automation target to `CHAINLINK_AUTOMATION`.

Then update all of the following before running setup:

1. Add the vault to `scripts/deployment/config/cre-automation.sepolia.json`:
    - set `id` to the protocol `deploymentId`;
    - add `NavOracleAutomation` and all finalizer addresses to `targets`.
2. Add the same `id` to `cre/nav-workflow/config.staging.json` with its
   `IssuanceVault` and `NavOracleAutomation`. If this vault does not have an
   `AutomationReceiver` yet, leave out the `receiver` field. `cre:setup:sepolia` will
   deploy the receiver and write its address into this field.
3. Add the same `id` to `cre/finalization-workflow/config.staging.json` with its
   `IssuanceVault` and finalizers. Leave out `receiver` for a new vault; the same setup
   command will fill it in here too.
4. If the test-only submitter is required, deploy a `MockNavSubmitterAutomation`, grant
   it `ORACLE_ROLE` on that vault's NavOracleAutomation, and add it manually to
   `cre/nav-submitter-workflow/config.staging.json` after setup supplies the receiver.

Review the change without RPC calls:

```bash
npm run deploy:cre-receivers:sepolia:plan
```

Then run the normal sequence:

```bash
npm run cre:setup:sepolia
npm run cre:check:sepolia
npm run cre:simulate:sepolia
npm run cre:deploy:sepolia
```

`setup` deploys one receiver for the new vault, records it, updates the receiver fields
in the NAV and finalization configs, recalculates workflow IDs, allows the new IDs and
targets, and grants the receiver `CHAINLINK_AUTOMATION`. Because the combined workflow
artifacts changed, the final `deploy` updates the DON workflows so they begin monitoring
the new vault.

The Sepolia-only test submitter is managed separately. If the new vault needs it:

1. copy the receiver created by setup into the vault's `receiver` field in
   `cre/nav-submitter-workflow/config.staging.json`;
2. calculate the test workflow's ID from the repository root:

    ```bash
    cd cre
    cre -e .env workflow hash ./nav-submitter-workflow \
      --target staging-settings --non-interactive --verbose
    cd ..
    ```

3. copy the reported workflow hash, with a `0x` prefix, into the
   `nav-submitter-test-staging` entry in
   `scripts/deployment/config/cre-automation.sepolia.json`;
4. apply that ID to the receivers and verify the resulting permissions:

    ```bash
    npm run deploy:cre-receivers:sepolia
    npm run cre:check:sepolia
    ```

5. deploy the test workflow from `cre/`:

    ```bash
    cd cre
    cre -e .env workflow deploy ./nav-submitter-workflow \
      --target staging-settings --non-interactive --yes
    cd ..
    ```

`cre:setup:sepolia` and `cre:deploy:sepolia` automate only the NAV-application and
finalization workflows. They do not calculate or deploy the test submitter workflow.

## Adding or changing a tranche

CRE needs a tranche entry only when delayed withdrawals for that tranche are handled by
an `UmbrellaEpochFinalizer`. A direct-withdraw tranche has no finalizer target.

For a newly deployed delayed-withdraw tranche:

1. deploy its finalizer and record the address under the vault namespace;
2. add `{ "tranche": "mezzanine", "address": "0x..." }` to that vault in
   `cre/finalization-workflow/config.staging.json`;
3. add the same finalizer address to the vault's `targets` in
   `cre-automation.sepolia.json`;
4. run `setup`, `check`, `simulate` and `cre:deploy:finalization:sepolia`.

`tranche` is the tranche key used in logs and must contain lowercase letters, numbers or
hyphens. Values such as `senior`, `mezzanine` and `junior` are accepted. The address must
be the `UmbrellaEpochFinalizer` deployed for that tranche, not the tranche proxy itself.

Removing a finalizer or vault is the reverse configuration change. Run setup before
deploying the reduced workflow so the removed target and obsolete workflow ID are revoked
from receivers. Confirm that no pending withdrawals still depend on the removed finalizer.

## Changing a workflow

The workflow ID is derived from the organization identity and workflow artifact. Source,
runtime config, receiver address or other artifact changes may produce a new ID. For any
such change:

1. edit and test the workflow;
2. run `cre:setup:sepolia` to derive the new IDs and update receiver permissions;
3. run `cre:check:sepolia`;
4. simulate the changed workflow;
5. deploy that workflow to DON;
6. inspect the deployed workflow and its first executions.

Setup replaces the tracked permissions: IDs no longer present in the desired config are
revoked. This creates a short operational cutover in which the old DON workflow may no
longer write before the new workflow is deployed. Schedule the setup and deploy steps
together when continuous automation matters.

Changing only `schedule` or `gasLimit` still changes the workflow artifact and follows the
same sequence. Increasing `gasLimit` changes the limit passed to the CRE write capability;
it does not change target contract logic.

## Receiver replacement

`cre:setup:sepolia` reuses the latest recorded receiver when its runtime bytecode and chain
selector match. It deploys a replacement when either is outdated. The replacement is
recorded with `replaces`, synchronized into workflow configs, configured with current
owner/workflow/call permissions and granted `CHAINLINK_AUTOMATION`. The role is then
revoked from the previous receiver.

Preserve `reports/deployments.json`: it is required to find the current receiver, revoke
obsolete workflow IDs and remove the old receiver's role safely. After replacement,
deploy the workflows with the newly synchronized receiver address and verify that the old
receiver can no longer execute target calls.

The receiver also has a contract administrator returned by `owner()`. This is the wallet
allowed to change its forwarder, workflow owner and call permissions. It is separate from
the CRE `workflowOwner`. To transfer receiver administration to another wallet, the
current contract owner must call the inherited `transferOwnership(newOwner)` function on
each receiver. The repository does not currently provide a wrapper command for this
operation. Confirm the new address and repeat the on-chain status check after transfer.

## Organization migration

Migrate only when workflow ownership is intentionally moving to another CRE organization,
for example when transferring operations from a developer organization to a client-owned
organization. A normal source/config update within the same organization is handled by
`cre:setup:sepolia` and is not a migration.

Before migration:

1. confirm who owns the destination organization and who has deploy access;
2. log in to that organization with `cre login` and verify it with `cre whoami`;
3. record the expected `org_...` ID out of band;
4. decide when the old organization's workflows will be stopped or deleted.

Run the explicit command from the repository root:

```bash
npm run cre:migrate-organization:sepolia -- org_EXPECTED_ID
```

The command refuses to continue if the active organization ID differs from the supplied
ID or lacks deploy access. It derives the destination workflow owner and workflow IDs,
updates `cre-automation.sepolia.json`, restores the canonical forwarder, applies the new
permissions to every receiver and performs a strict on-chain status check.

The command does not transfer, stop or delete workflows belonging to the old organization.
After it succeeds, deploy the workflows from the destination organization, verify their
executions, and separately disable the old workflows. Once receiver permissions have moved,
old workflows may continue to run but their writes should be rejected.

Commit the updated identity, workflow IDs and deployment records after the migration. Do
not commit CRE credentials or private keys.

## Common change guide

| Change                                                | Required action                                                                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a vault                                           | Update receiver, NAV and finalization configs; setup, check, simulate and deploy both workflows.                                                                       |
| Add a delayed-withdraw tranche                        | Add its finalizer to the finalization and receiver target configs; setup and deploy finalization.                                                                      |
| Change workflow source, config, schedule or gas limit | Test, setup to rotate IDs, check, simulate and deploy the changed workflow.                                                                                            |
| Change receiver contract administrator                | From the current owner wallet, call `transferOwnership(newOwner)` on every receiver, then verify `owner()` on-chain. This is separate from CRE organization migration. |
| Replace receiver code or chain selector               | Run setup; it deploys and records a replacement and revokes the old receiver role.                                                                                     |
| Change CRE organization                               | Run the explicit migration command, deploy from the new organization and stop old workflows separately.                                                                |
| Change only protocol parameters                       | No CRE redeploy is needed unless target addresses or upkeep behavior/config also change.                                                                               |

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
