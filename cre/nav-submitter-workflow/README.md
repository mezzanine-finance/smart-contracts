# Test NAV submitter workflow

Testnet-only CRE workflow that calls `MockNavSubmitterAutomation.performUpkeep()`
for each ready vault. The submitter then calls `NavOracleAutomation.submitNav()`
using deterministic mock oracle feeds.

This workflow must not be deployed to mainnet. Its runtime schema accepts only
`isTestnet: true`, and `workflow.yaml` exposes only staging settings.

The staging configuration targets the two existing Sepolia vaults. Each has a
dedicated submitter recorded under its vault namespace in `reports/deployments.json`.
Before running on DON, allow the deployed workflow ID in both receivers.

With `vetoPeriod=0`, `submitNav()` applies NAV immediately and the regular NAV
workflow has no pending work. Use a nonzero veto period to exercise the complete
submitter-to-pending-to-NAV-workflow path.
