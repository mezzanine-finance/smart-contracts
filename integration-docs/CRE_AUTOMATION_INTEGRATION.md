# CRE Automation Flows

This page is a visual reference for the Chainlink CRE integration. Operational commands,
configuration changes and organization migration are documented in
[`cre/README.md`](../cre/README.md).

## Components

![Common CRE write path](./cre-automation-diagrams/01-write-path.svg)

This is the common path used by both workflows:

- The cron trigger starts the workflow inside the CRE DON every five minutes.
- The workflow calls `checkUpkeep(0x)` on each configured contract.
- If `upkeepNeeded` is `false`, that target finishes without a transaction.
- If `upkeepNeeded` is `true`, CRE creates a signed report for that target.
- `KeystoneForwarder` verifies the report and delivers it to the receiver for the target's vault.
- The receiver forwards the approved `performUpkeep(bytes)` call to the existing contract.

There will be one receiver per vault. `AccessManager` is not a separate step in this flow: the
target contract uses it to check that its vault receiver has the required role.

## Flow 1: applying a pending NAV and rolling the epoch

`submitNav()` happens outside the current CRE scope. It is called by the client or another approved
oracle submitter.

![Pending NAV application and epoch rollover](./cre-automation-diagrams/02-nav-rollover.svg)

After that, the CRE workflow calls `NavOracleAutomation.checkUpkeep(0x)` every five minutes.
`checkUpkeep()` answers one question:

> Does a pending NAV exist, and is it ready to be applied now?

It does not submit a NAV. If it returns `true`, CRE requests `performUpkeep(0x)`, which applies the
pending NAV and advances the epoch. `rejectPendingNav()` also stays outside CRE and is called by the
client manually when needed.

Sepolia also has a separate test-only NAV submitter workflow. It calls the deployed mock submitter,
which reads deterministic feeds and invokes `submitNav()`. It exists to exercise the full test flow
and must not be deployed to mainnet.

## Flow 2: processing both NAV targets

![Independent NAV target processing](./cre-automation-diagrams/03-pending-nav.svg)

One run checks the `NavOracleAutomation` contract for both vaults. Each ready target gets its
own report and transaction. If one target fails, the workflow still processes the other one. The
next run checks their current on-chain state again and retries only targets that are still ready.

## Flow 3: delayed withdrawal finalization

This is a separate workflow. It watches deployed finalizers.

![Delayed withdrawal finalization](./cre-automation-diagrams/04-withdrawal-finalization.svg)

Each finalizer handles at most one epoch per transaction and per workflow run. If it is several
epochs behind, later five-minute runs continue moving its cursor until it catches up.

## How the workflows coordinate through on-chain state

![How the workflows coordinate through IssuanceVault state](./cre-automation-diagrams/05-flow-connection.svg)

This is an end-to-end state flow, not a direct call between the workflows. The NAV workflow applies
a pending NAV and advances `IssuanceVault.currentEpochId`. On a later cron run, the finalization
workflow reads that updated state and sees that another withdrawal epoch can be finalized.

The workflows never call each other directly. They coordinate through the vault's on-chain state.

## Vault-specific receivers and permissions

We use the same restricted receiver implementation, but deploy one instance per vault.

Each receiver will:

- accept reports only from the canonical `KeystoneForwarder`;
- verify the expected workflow owner;
- allow only target contracts belonging to its vault;
- allow only the `performUpkeep(bytes)` selector.

The receivers need `CHAINLINK_AUTOMATION` for their allowed `performUpkeep(bytes)` calls.

For every contract automated by CRE, add its address to the workflow configuration and to
the list of contracts that the vault's receiver is allowed to call. Use the same vault ID
in all configuration files.

## Related code

- [`NavOracleAutomation.sol`](../contracts/automation/NavOracleAutomation.sol)
- [`UmbrellaEpochFinalizer.sol`](../contracts/automation/UmbrellaEpochFinalizer.sol)
- [`IssuanceVault.sol`](../contracts/IssuanceVault.sol)
- [`Tranche.sol`](../contracts/Tranche.sol)
