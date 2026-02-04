# Aderyn False Positives

This document tracks Aderyn findings we are intentionally ignoring or suppressing.
We prefer inline suppressions only when there is a single instance in a single contract.
For repeated findings (multi-line or cross-contract), we keep rationale here instead
of adding comment noise everywhere.

Note: Aderyn only supports per-line ignores (`aderyn-fp-next-line` /
`aderyn-ignore-next-line`), not block-level ignores.

## False Positives / Accepted Risk

- `contract-locks-ether` (H-2)
  - Reason: UUPS contracts inherit OpenZeppelin `upgradeToAndCall` which is
    payable; Aderyn flags the contract as locking Ether even though there is no
    intentional ETH flow. ETH can only be forced via `selfdestruct`, and we do
    not support ETH withdrawals by design.
  - Suppression: inline `aderyn-fp-next-line(contract-locks-ether)` on the
    contract declaration (see `contracts/pause/PauseManager.sol` and other
    UUPS contracts).

- `unsafe-erc20-operation` / `unchecked-return` (L-1, L-8)
  - Files: `contracts/MZUSD.sol`, `contracts/ReservoirUSDC.sol`,
    `contracts/Vault.sol`, `contracts/Tranche.sol`, `contracts/PolJuniorTranche.sol`.
  - Reason: we interact with well-known tokens (USDC) or our own ERC20s. These
    calls revert on failure; return values are not relied upon. Using SafeERC20
    everywhere adds boilerplate without changing behavior.

- `modifier-invoked-only-once` (L-2)
  - Files: `contracts/LossManager.sol`, `contracts/MZUSD.sol`,
    `contracts/Vault.sol`.
  - Reason: modifiers kept for clarity and future extensibility.

- `loop-contains-revert` (L-3)
  - Files: `contracts/LossManager.sol`.
  - Reason: these loops validate configuration and should fail fast on invalid
    input.

- `uninitialized-local-variable` (L-5)
  - Files: `contracts/LossManager.sol`, `contracts/Vault.sol`.
  - Reason: loop counters default to zero by Solidity rules.

- `costly-operations-inside-loop` (L-6)
  - Files: `contracts/LossManager.sol`.
  - Reason: loops are bounded and called in admin flows; gas is acceptable.

- `unused-import` (L-7)
  - File: `contracts/AccessManagerImport.sol`.
  - Reason: this file forces dependency compilation; suppressed inline via
    `aderyn-ignore-next-line(unused-import)`.
