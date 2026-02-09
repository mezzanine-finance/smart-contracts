# Slither False Positives / Accepted Findings

This document tracks Slither findings we intentionally ignore or accept as low risk.
We prefer to avoid inline suppressions for repeated findings and keep rationale here.

Note: `slither --checklist` returns a non-zero exit code when findings exist.
Use `npm run slither:md` for report-only runs or `npm run slither:md:strict` to gate CI.

## Accepted / Low Risk

- `unchecked-transfer` (High)
  - Files: `contracts/MZUSD.sol`, `contracts/ReservoirUSDC.sol`, `contracts/Vault.sol`,
    `contracts/Tranche.sol`, `contracts/PolJuniorTranche.sol`.
  - Reason: we interact with well-behaved tokens (USDC) or protocol-owned tokens.
    Calls revert on failure; return values are not relied upon. We intentionally
    use direct ERC20 calls for known tokens. If we ever need to harden against
    non-standard tokens, we can switch to `SafeERC20`.

- `divide-before-multiply` (Medium)
  - Files: `contracts/MZUSD.sol`, `contracts/Vault.sol`, `contracts/test/MockNavSubmitterAutomation.sol`.
  - Reason: rounding down to 6-decimal USDC is intentional; burn uses the
    rounded amount to avoid dust mismatch in `MZUSD.requestWithdrawal`; in Vault
    and test automation this is expected integer arithmetic with accepted rounding.

- `incorrect-equality` (Medium)
  - File: `contracts/Vault.sol` (`available == 0`).
  - Reason: explicit zero check is intended to guard the empty-reservoir case.

- `reentrancy-benign` / `reentrancy-events` (Low)
  - Files: `contracts/automation/NavOracleAutomation.sol`,
    `contracts/Vault.sol`, `contracts/LossManager.sol`, `contracts/MZUSD.sol`,
    `contracts/ReservoirUSDC.sol`, `contracts/Tranche.sol`,
    `contracts/PolJuniorTranche.sol`, `contracts/test/MockNavSubmitterAutomation.sol`.
  - Reason: external calls are to protocol components under AccessManager
    control. No untrusted callbacks are expected; findings are informational.

- `uninitialized-local` (Medium)
  - Files: `contracts/Vault.sol`.
  - Reason: loop variables default to zero in Solidity; pattern is idiomatic.

- `unused-return` (Medium)
  - Files: `contracts/Vault.sol`, `contracts/LossManager.sol`,
    `contracts/test/MZUSDNettingHelper.sol`,
    `contracts/test/MockNavSubmitterAutomation.sol`.
  - Reason: return values are not required for correctness; used for calls
    where revert semantics are sufficient.

- `missing-zero-check` (Low)
  - Files: `contracts/automation/NavOracleAutomation.sol`,
    `contracts/PolJuniorTranche.sol`,
    `contracts/test/MockMZUSD.sol`,
    `contracts/test/MockNavOracleAutomationRef.sol`,
    `contracts/test/MockLossManagerRef.sol`.
  - Reason: in `PolJuniorTranche` payout is already validated by `_resolveCoreContracts`;
    in `NavOracleAutomation` addresses are derived from deployed `LossManager` and
    deployment script post-validates `mzusd/vault/lossManager` consistency; mock files
    are test-only and intentionally lightweight.

- `missing-inheritance` (Info)
  - File: `contracts/automation/NavOracleAutomation.sol`.
  - Reason: detector compares against test helper interface
    `INavOracleAutomationForMock`; production contract intentionally does not inherit it.

- `redundant-statements` (Info)
  - Files: `contracts/automation/NavOracleAutomation.sol`,
    `contracts/automation/UmbrellaEpochFinalizer.sol`.
  - Reason: `checkData;` and `performData;` are explicit no-op markers to preserve
    Chainlink Automation-compatible signatures while intentionally ignoring calldata.

- `unused-import` (Info)
  - File: `contracts/AccessManagerImport.sol`.
  - Reason: intentionally forces dependency compilation; suppressed inline via
    `aderyn-ignore-next-line(unused-import)`.
