# Pending NAV workflow

CRE workflow for applying a pending NAV after the veto period. `submitNav()` and
`rejectPendingNav()` are outside the current CRE scope.

Every cron run calls `checkUpkeep(0x)` on each configured `NavOracleAutomation`
contract. For every ready target, it creates a DON-signed report containing the
target and `performUpkeep(performData)` calldata, then requests a write to that
vault's `AutomationReceiver`.

Reads use finalized blocks. Each target is handled independently; a failure does
not stop the remaining vaults.

## NAV submissions and testing

An external operator or service must update oracle feeds and call `submitNav()`.
Cron alone does not create yield or advance epochs. The applied NAV may represent
yield, loss or zero change, depending on the feed data.

For a DON write test, submit NAV with a nonzero veto period and wait until both
veto and epoch conditions are satisfied. Inspect subsequent runs, the transaction,
`NavApplied`, pending-state clearance and the new vault epoch.
With `vetoPeriod=0`, `submitNav()` applies NAV immediately, bypassing CRE's write
path. Changing veto after submission does not change that pending NAV's ready time.

## Files

- `main.ts`: CRE runner entry point.
- `config.ts`: runtime schema; `config.staging.json`: Sepolia vault/receiver addresses.
- `workflow.ts`: cron registration, target iteration and per-target results.
- `read.ts`: finalized-state upkeep check.
- `write.ts`: report encoding, submission and status validation.
- `contracts.ts`: minimal upkeep ABIs; 
- `workflow.test.ts`: mocked-capability tests.

See the [shared README](../README.md) for commands, permissions and test instructions.
