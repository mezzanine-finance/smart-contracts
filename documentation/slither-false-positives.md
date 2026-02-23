# Slither False Positives / Accepted Findings

This document tracks Slither findings we intentionally ignore or accept as low risk.
We prefer to avoid inline suppressions for repeated findings and keep rationale here.

Note: `slither --checklist` returns a non-zero exit code when findings exist.
Use `npm run slither:md` for report-only runs or `npm run slither:md:strict` to gate CI.

## Accepted / Low Risk

- `unchecked-transfer` (High)
    - Files: `contracts/MZUSD.sol`, `contracts/ReservoirUSDC.sol`, `contracts/IssuanceVault.sol`,
      `contracts/Tranche.sol`, `contracts/PolJuniorTranche.sol`.
    - Reason: we interact with well-behaved tokens (USDC) or protocol-owned tokens.
      Calls revert on failure; return values are not relied upon. We intentionally
      use direct ERC20 calls for known tokens. If we ever need to harden against
      non-standard tokens, we can switch to `SafeERC20`.

- `divide-before-multiply` (Medium)
    - Files: `contracts/MZUSD.sol`, `contracts/IssuanceVault.sol`.
    - Reason: rounding down to 6-decimal USDC is intentional; burn uses the
      rounded amount to avoid dust mismatch in `MZUSD.requestWithdrawal`; in IssuanceVault
      this is expected integer arithmetic with accepted rounding.

- `incorrect-equality` (Medium)
    - File: `contracts/IssuanceVault.sol` (`available == 0` in `setBuffer` and `_rebalance`).
    - Reason: explicit zero checks are intended guards for the empty-reservoir case:
      `setBuffer` emits `BufferRebalanceSkipped(ReservoirEmpty)` and keeps updated config,
      while `_rebalance` remains strict and reverts with `ReservoirEmpty`.

- `reentrancy-benign` / `reentrancy-events` (Low)
    - Files: `contracts/automation/NavOracleAutomation.sol`,
      `contracts/IssuanceVault.sol`, `contracts/LossManager.sol`, `contracts/MZUSD.sol`,
      `contracts/ReservoirUSDC.sol`, `contracts/Tranche.sol`,
      `contracts/PolJuniorTranche.sol`.
    - Reason: external calls are to protocol components under AccessManager
      control. No untrusted callbacks are expected; findings are informational.

- `uninitialized-local` (Medium)
    - Files: `contracts/IssuanceVault.sol`.
    - Reason: loop variables default to zero in Solidity; pattern is idiomatic.

- `unused-return` (Medium)
    - Files: `contracts/IssuanceVault.sol`, `contracts/LossManager.sol`.
    - Reason: return values are not required for correctness; used for calls
      where revert semantics are sufficient.

- `missing-zero-check` (Low)
    - Files: `contracts/automation/NavOracleAutomation.sol`,
      `contracts/PolJuniorTranche.sol`.
    - Reason: in `PolJuniorTranche` payout is already validated by `_resolveCoreContracts`;
      in `NavOracleAutomation` addresses are derived from deployed `LossManager` and
      deployment script post-validates `mzusd/vault/lossManager` consistency.

- `costly-loop` (Info)
    - Files: `contracts/IssuanceVault.sol` (`setTrancheConfig`).
    - Reason: the looped `delete`/pairing updates happen in bounded admin-only config flow
      (`MAX_TRANCHES = 50`), not in user hot paths. We prefer explicit mapping cleanup and
      deterministic pair reconstruction for correctness.

- `cyclomatic-complexity` (Info)
    - Files: `contracts/IssuanceVault.sol` (`_allocateYieldToTranches`, `setTrancheConfig`).
    - Reason: branching reflects deliberate protocol rules (paired allocation semantics,
      dust assignment, and strict config invariants). The complexity is covered by integration
      and fuzz tests and is accepted for readability of business logic in one place.

- `redundant-statements` (Info)
    - Files: `contracts/automation/NavOracleAutomation.sol`,
      `contracts/automation/UmbrellaEpochFinalizer.sol`.
    - Reason: `checkData;` and `performData;` are explicit no-op markers to preserve
      Chainlink Automation-compatible signatures while intentionally ignoring calldata.

- `unused-import` (Info)
    - File: `contracts/AccessManagerImport.sol`.
    - Reason: intentionally forces dependency compilation; suppressed inline via
      `aderyn-ignore-next-line(unused-import)`.
