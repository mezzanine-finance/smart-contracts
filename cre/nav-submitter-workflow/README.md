# Test NAV submitter workflow

Testnet-only CRE workflow that calls `MockNavSubmitterAutomation.performUpkeep()`
for each ready vault. The submitter then calls `NavOracleAutomation.submitNav()`
using deterministic mock oracle feeds.

This workflow must not be deployed to mainnet. Its runtime schema accepts only
`isTestnet: true`, and `workflow.yaml` exposes only staging settings.

Every cron run calls `checkUpkeep(0x)` on each configured submitter. For ready
targets, it creates a report with `performUpkeep(performData)` calldata and requests
a write through the vault's `AutomationReceiver`. Reads use finalized blocks;
recent deployments and state changes may become visible only on a later run.
Each target is handled independently, so one failure does not stop other vaults.

## NAV submissions and testing

Each submitter needs `ORACLE_ROLE` for its NAV automation's `submitNav()`.
Each receiver must allow the workflow ID and the submitter's `performUpkeep`
selector. After redeployment, synchronize receiver permissions with the resulting
workflow ID. The existing NAV workflow also needs its normal receiver permissions
and access to `NavOracleAutomation.performUpkeep()`.

With `vetoPeriod=0`, `submitNav()` applies NAV immediately and the regular NAV
workflow has no pending work. Use a nonzero veto period to exercise the complete
submitter-to-pending-to-NAV-workflow path.

For a full-cycle DON test, verify that submission creates pending NAV, then wait
for the existing NAV workflow to apply it once the upkeep conditions are satisfied.
Inspect the transaction, the contract's `NavApplied` event, pending-state clearance
and the new vault epoch.
The configured cron intervals and finalized-block lag add to the veto delay.

A simulation without `--broadcast` does not send real transactions and cannot
confirm on-chain execution.

## Files

- `main.ts`: CRE runner entry point.
- `config.ts`: runtime schema; 
- `config.staging.json`: Sepolia submitter/receiver addresses.
- `workflow.ts`: cron registration, target iteration and per-target results.
- `read.ts`: finalized-state upkeep check.
- `write.ts`: report encoding, submission and status validation.
- `contracts.ts`: minimal upkeep ABIs.
- `workflow.test.ts`: mocked-capability tests.

See the [shared README](../README.md) for commands, permissions and test instructions.
