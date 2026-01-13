# Mezzanine Protocol — Smart Contracts (Phase 1)

Smart contract codebase for Mezzanine phase 1. This repo includes core contracts, tests, and helper scripts for development.

## What’s inside
- `contracts/Vault.sol` — vault core and accounting.
- `contracts/Tranche.sol`, `contracts/PolJuniorTranche.sol` — tranche logic.
- `contracts/ReservoirUSDC.sol` — USDC liquidity buffer.
- `contracts/MZUSD.sol` — phase 1 protocol token.
- `contracts/LossManager.sol` — loss allocation across layers.
- `contracts/access/` — access control and emergency policies.
- `contracts/automation/` — automation/keepers.
- `test/` — Hardhat tests.

## Project status
- This is the **phase 1** protocol code.
- Drafts for next phases live in `contracts/phase2/` and are marked `.disabled`, so they are excluded from builds.
- Deployment is **WIP**.

## Quick start
```bash
npm install
npm run compile
npm test
```

## Useful commands
- `npm run lint` — TS and Solidity linting.
- `npm run coverage` — test coverage.
- `npm run size` — contract sizes.
- `npm run gen:docs` / `npm run gen:abi` — doc and ABI generation.

## Integration notes
See `integration-docs/` for integration references (tranches, subgraph, automation, emergency levels) and additional documentation. 
