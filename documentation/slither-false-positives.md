# Slither False Positives / Accepted Findings

This document tracks Slither findings we intentionally ignore or accept as low risk.
We prefer to avoid inline suppressions for repeated findings and keep rationale here.

Note: `slither --checklist` returns a non-zero exit code when findings exist.
Use `npm run slither:md` for report-only runs or `npm run slither:md:strict` to gate CI.

## Accepted / Low Risk

- `unchecked-transfer` (High)
  - Files: `contracts/MZUSD.sol`, `contracts/ReservoirUSDC.sol`, `contracts/Vault.sol`.
  - Reason: we interact with well-behaved tokens (USDC) or protocol-owned tokens.
    Calls revert on failure; return values are not relied upon. We can switch to
    `SafeERC20` if we ever need to harden against non-standard tokens.

- `divide-before-multiply` (Medium)
  - File: `contracts/MZUSD.sol` (`requestWithdrawal`).
  - Reason: rounding down to 6-decimal USDC is intentional; burn uses the
    rounded amount to avoid dust mismatch.

- `incorrect-equality` (Medium)
  - File: `contracts/Vault.sol` (`available == 0`).
  - Reason: explicit zero check is intended to guard the empty-reservoir case.

- `reentrancy-no-eth` / `reentrancy-benign` / `reentrancy-events` (Medium/Low)
  - Files: `contracts/automation/NavOracleAutomation.sol`,
    `contracts/Vault.sol`, `contracts/LossManager.sol`, `contracts/MZUSD.sol`,
    `contracts/ReservoirUSDC.sol`.
  - Reason: external calls are to protocol components under AccessManager
    control. No untrusted callbacks are expected; findings are informational.

- `uninitialized-local` (Medium)
  - Files: `contracts/Vault.sol`, `contracts/LossManager.sol`.
  - Reason: loop variables default to zero in Solidity; pattern is idiomatic.

- `unused-return` (Medium)
  - Files: `contracts/Vault.sol`, `contracts/LossManager.sol`,
    `contracts/automation/UmbrellaEpochFinalizer.sol`,
    `contracts/test/MZUSDNettingHelper.sol`.
  - Reason: return values are not required for correctness; used for calls
    where revert semantics are sufficient.

- `missing-zero-check` (Low)
  - File: `contracts/test/MockMZUSD.sol`.
  - Reason: test-only mock; zero-checks are unnecessary.

- `cyclomatic-complexity` (Info)
  - File: `contracts/LossManager.sol` (`_validateTrancheConfig`).
  - Reason: validation logic is dense but intentional and bounded.

- `unused-import` (Info)
  - File: `contracts/AccessManagerImport.sol`.
  - Reason: intentionally forces dependency compilation; suppressed inline via
    `aderyn-ignore-next-line(unused-import)`.
