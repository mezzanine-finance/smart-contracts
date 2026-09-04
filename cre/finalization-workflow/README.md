# Finalization workflow

CRE workflow for delayed withdrawal epoch finalization.

Every cron run calls `checkUpkeep(0x)` on each configured
`UmbrellaEpochFinalizer`. For every ready finalizer, it creates a separate
DON-signed report containing the target and `performUpkeep(performData)`
calldata, then requests a write to that vault's `AutomationReceiver`.

Reads use finalized blocks. Each finalizer gets at most one write attempt per
cron run; backlog is drained over subsequent runs rather than batched into one
transaction. A target failure does not stop the other finalizers.

## Readiness and testing

This workflow does not submit NAV or advance the vault's current epoch. It sees
epochs completed by NAV application and finalizes or advances its own cursor as
allowed by the contract. If the vault stops advancing, cron alone cannot make
withdrawals mature. Finalization does not claim funds for users.

For a write test, use a finalizer whose `checkUpkeep` returns `true`. Inspect its
write result and transaction, then verify cursor/withdrawal state. `false` is
normal when there is no work; finalized reads can lag recent changes.

## Files

- `main.ts`: CRE runner entry point.
- `config.ts`: runtime schema; `config.staging.json`: finalizers grouped by vault/tranche.
- `workflow.ts`: cron registration, finalizer iteration and per-target results.
- `read.ts`: finalized-state upkeep check.
- `write.ts`: report encoding, submission and status validation.
- `contracts.ts`: minimal upkeep ABIs; 
- `workflow.test.ts`: mocked-capability tests.

See the [shared README](../README.md) for commands, permissions and test instructions.
