# Test NAV submitter workflow

Testnet-only CRE workflow that calls `MockNavSubmitterAutomation.performUpkeep()`
for each ready vault. The submitter then calls `NavOracleAutomation.submitNav()`
using deterministic mock oracle feeds.

This workflow must not be deployed to mainnet. Its runtime schema accepts only
`isTestnet: true`, and `workflow.yaml` exposes only staging settings.

The staging vault list remains empty until the multi-vault deployment branch is
integrated and the per-vault submitter addresses are deployed and recorded.

With `vetoPeriod=0`, `submitNav()` applies NAV immediately and the regular NAV
workflow has no pending work. Use a nonzero veto period to exercise the complete
submitter-to-pending-to-NAV-workflow path.
