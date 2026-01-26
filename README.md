# Mezzanine Protocol

Smart contract repository for Mezzanine. This repo includes the core
contracts, automation, tests, and helper scripts for development and deployment.

## TL;DR

Accepts USDC (6 decimals) and mints MZUSD (18 decimals) 1:1 with a `1e12` scale.
Users interact through ERC4626 tranches with direct or umbrella withdrawals.
Vault computes yield/loss; NavOracleAutomation and LossManager apply it.
Governance and safety: AccessManager + PauseManager (category-based pauses).

## Key contracts

 `contracts/Vault.sol` - protocol accounting, idle buffer, yield distribution.

 `contracts/Tranche.sol` - ERC4626 tranche, epoch-based yield streaming.

 `contracts/PolJuniorTranche.sol` - POL tranche with restricted withdraw/redeem.

 `contracts/ReservoirUSDC.sol` - USDC liquidity buffer for rebalancing.

 `contracts/MZUSD.sol` - protocol stablecoin, mint/burn, redemption caps.

 `contracts/LossManager.sol` - loss application across tranches.

 `contracts/automation/NavOracleAutomation.sol` - NAV oracle + automation.

 `contracts/pause/` - PauseManager/PauseManaged (category pauses).

 `contracts/phase2/` - next-phase drafts (`*.disabled`, excluded from builds).

## Core flows

**MZUSD mint/redemption:** `MZUSD.deposit` takes USDC and mints MZUSD;
  `MZUSD.requestWithdrawal` burns MZUSD and asks Vault to pay USDC.

**Tranche deposit/withdraw:** deposit MZUSD into ERC4626; direct-withdraw or
  umbrella (request → wait for epoch → finalize → claim).
 
**Yield:** NAV > supply → `Vault.distributeYield` → new epoch + yield streaming.
 
**Loss:** NAV < supply → `LossManager.applyLoss` → burn MZUSD from tranches.
 
**Rebalance:** Vault targets an idle buffer and rebalances USDC to Reservoir.

## Docs and guides

 `documentation/protocol-overview.md` - architecture and detailed flows.
 
 `documentation/protocol-diagrams.md` - Mermaid diagrams.

 `documentation/access-control.md` - roles and selector-based permissions.
 
 `documentation/pause-manager.md` - pause categories and rules.
 
 `integration-docs/FRONTEND_TRANCHE_INTEGRATION.md` - UI integration.
 
 `integration-docs/NAV_AUTOMATION.md` - NAV automation setup.
 
 `integration-docs/SUBGRAPH_VAULT_TRANCHE.md` - subgraph notes.

## Quick start

```bash
npm install
cp .env.example .env
# set FORKING_URL (and optionally FORKING_BLOCK_NUMBER)
npm run compile
npm run test:fork
```

Environment requirements: Node `>=24.11.1`, npm `>=11.6.2`.

## Scripts and commands

**Build**

 `npm run compile`, `npm run compile:force` - compile contracts (force ignores cache)

**Tests**

 `npm run test:fork` - run tests on a mainnet fork (requires `.env` + `FORKING_URL`)

 `npm test` - run tests with `.env` `FORKING` toggle (tests require a fork)
 
 `npm run test:gas` - run tests with gas reporter enabled
 
 `npm run test:trace`, `npm run test:trace:full` - run tests with tracer / full trace
 
 `npm run test:check` - run tests with typecheck enabled

 `npm run test:gas:json`, `npm run test:gas:md` - export gas report to JSON/Markdown

  Note: tests are written for a forked network and will fail without a fork.
  Use `npm run test:fork` or set `.env` `FORKING=true` and run `npm test`.
  `npx hardhat test --fork` is not used here and will not work with this setup.
  Configure `.env` with the required RPC settings (see `.env.example`).

**Lint and format**

 `npm run lint`, `npm run lint:fix` - run all linters (and auto-fix)

 `npm run lint:staged` - lint only staged files

 `npm run lint:ts`, `npm run lint:ts:fix` - TS/JS lint + prettier (and auto-fix)

 `npm run lint:sol`, `npm run lint:sol:fix` - solhint + prettier (and auto-fix)

 `npm run format` - format with prettier

**Reports and analysis**

 `npm run coverage:4g` / `npm run coverage:8g` - coverage with memory presets (recommended)
 
 `npm run coverage` - known to time out on `test/LossManager.ts` in this repo; avoid
 
 `npm run size` - contract size report
 
 `npm run slither` / `npm run slither:md` - run Slither (Markdown report; `slither:md` is non-strict)
 
 `npm run slither:md:strict` - run Slither checklist and fail on findings (CI-style gate)
 
 `aderyn` - Aderyn static analysis (uses `aderyn.toml`, outputs `report.md`)

**Artifacts**

 `npm run gen:docs` - Solidity docgen to `docs/`

 `npm run gen:abi` - export ABI to `abi/`

**Clean**

 `npm run clean` - remove build, OZ, ignition, and coverage artifacts

 `npm run clean:build`, `npm run clean:cov` - remove build or coverage artifacts

 `npm run clean:oz`, `npm run clean:ignition` - remove OpenZeppelin or ignition artifacts

**Prepare**

 `npm run prepare` - install Husky hooks

**Deploy**

 `npm run deploy:hardhat` - deploy full stack to Hardhat

 `npm run deploy:sepolia` - deploy full stack to Sepolia

 `npm run deploy:mainnet` - deploy full stack to Mainnet

 `npm run deploy:grant-roles -- --network <network>` - grant roles from config

 `npm run deploy:renounce-roles -- --network <network>` - renounce deployer roles (safety checks)

 `npm run deploy:handoff-roles -- --network <network>` - grant roles then renounce

Scripts live in `scripts/deployment/` and `scripts/commands/`.

## Repository structure

 `contracts/` - Solidity source.
 
 `test/` - Hardhat tests.
 
 `scripts/` - deployment and helper scripts.
 
 `documentation/` and `integration-docs/` - detailed guides.
