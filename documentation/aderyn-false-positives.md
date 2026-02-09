# Aderyn False Positives

This document tracks Aderyn findings we are intentionally ignoring or suppressing.
We prefer inline suppressions only when there is a single instance in a single contract.
For repeated findings (multi-line or cross-contract), we keep rationale here instead
of adding comment noise everywhere.

Note: Aderyn only supports per-line ignores (`aderyn-fp-next-line` /
`aderyn-ignore-next-line`), not block-level ignores.

## False Positives / Accepted Risk

- `reentrancy-state-change` (H-1)
  - Files: `contracts/LossManager.sol`, `contracts/ReservoirUSDC.sol`,
    `contracts/Tranche.sol`, `contracts/Vault.sol`,
    `contracts/automation/NavOracleAutomation.sol`,
    `contracts/automation/UmbrellaEpochFinalizer.sol`.
  - Reason: detector is conservative and flags functions that both touch state
    and perform external calls, including constructor wiring and trusted protocol
    calls. These paths are AccessManager-controlled and do not expose untrusted
    callbacks by design.

- `unsafe-erc20-operation` / `unchecked-return` (L-1, L-10)
  - Files: `contracts/MZUSD.sol`, `contracts/ReservoirUSDC.sol`,
    `contracts/Vault.sol`, `contracts/Tranche.sol`, `contracts/PolJuniorTranche.sol`.
  - Reason: we interact with well-known tokens (USDC) or our own ERC20s. These
    calls revert on failure; return values are not relied upon. We intentionally
    use direct ERC20 calls for known tokens; SafeERC20 can be introduced if
    support for non-standard tokens is required.

- `address-state-variable-set-without-checks` (L-2)
  - File: `contracts/PolJuniorTranche.sol`.
  - Reason: `polPayoutAddress` is validated in `_resolveCoreContracts` before
    assignment in `initialize`.

- `public-function-not-used-internally` (L-3)
  - Files: `contracts/MZUSD.sol`, `contracts/PolJuniorTranche.sol`.
  - Reason: stylistic recommendation only; `public` visibility is kept for
    readability and interface consistency.

- `modifier-invoked-only-once` (L-4)
  - Files: `contracts/LossManager.sol`, `contracts/MZUSD.sol`,
    `contracts/Vault.sol`, `contracts/Tranche.sol`, `contracts/PolJuniorTranche.sol`.
  - Reason: modifiers kept for clarity and future extensibility.

- `loop-contains-revert` (L-5)
  - Files: `contracts/LossManager.sol`.
  - Reason: these loops validate configuration and should fail fast on invalid
    input.

- `redundant-statement` (L-6)
  - Files: `contracts/automation/NavOracleAutomation.sol`,
    `contracts/automation/UmbrellaEpochFinalizer.sol`.
  - Reason: `checkData;` / `performData;` are explicit no-op markers for
    Chainlink Automation compatibility where calldata is intentionally ignored.

- `uninitialized-local-variable` (L-7)
  - Files: `contracts/LossManager.sol`, `contracts/Vault.sol`.
  - Reason: loop counters default to zero by Solidity rules.

- `costly-operations-inside-loop` (L-8)
  - Files: `contracts/LossManager.sol`.
  - Reason: loops are bounded and called in admin flows; gas is acceptable.

- `state-change-without-event` (L-9)
  - File: `contracts/automation/UmbrellaEpochFinalizer.sol`.
  - Reason: offchain tracking is expected to use `nextEpochId` state and
    underlying tranche/vault events; extra event here is optional, not a safety issue.

## Inline-Suppressed (Not in Current Report)

- `contract-locks-ether`
  - Reason: UUPS contracts inherit OpenZeppelin `upgradeToAndCall` which is
    payable; Aderyn may flag the contract as locking Ether even though there is
    no intentional ETH flow.
  - Suppression: inline `aderyn-fp-next-line(contract-locks-ether)` on UUPS
    contract declarations.

- `unused-import`
  - File: `contracts/AccessManagerImport.sol`.
  - Reason: this file forces dependency compilation.
  - Suppression: inline `aderyn-ignore-next-line(unused-import)`.
