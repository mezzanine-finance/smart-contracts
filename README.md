# Smart contracts template

Smart contract repository for Mezzanine. This repo includes the core
contracts, automation, tests, and helper scripts for development and deployment.

## TL;DR

Accepts USDC (6 decimals) and mints MZUSD (18 decimals) 1:1 with a `1e12` scale.
Users interact through ERC4626 tranches with direct or umbrella withdrawals.
Tranche share token uses `_decimalsOffset() = 3` (`Tranche.decimals() = 21`).
IssuanceVault computes yield/loss; NavOracleAutomation and LossManager apply it.
Governance and safety: AccessManager + PauseManager (category-based pauses) + Allowlist (Chainalysis sanctions screening).

## Key contracts

 `contracts/IssuanceVault.sol` - protocol accounting, idle buffer, yield distribution.

 `contracts/Tranche.sol` - ERC4626 tranche, epoch-based yield streaming.

 `contracts/PolJuniorTranche.sol` - POL tranche with restricted admin withdrawals.

 `contracts/ReservoirUSDC.sol` - USDC liquidity buffer for rebalancing.

 `contracts/MZUSD.sol` - protocol stablecoin, mint/burn, redemption caps.

 `contracts/Allowlist.sol` - account allowlist with Chainalysis sanctions check.

 `contracts/LossManager.sol` - loss application across tranches.

 `contracts/automation/NavOracleAutomation.sol` - NAV oracle + automation.

 `contracts/automation/UmbrellaEpochFinalizer.sol` - umbrella epoch finalization automation helper.

 `contracts/pause/` - PauseManager/PauseManaged (category pauses).

 `contracts/phase2/` - next-phase drafts (`*.disabled`, excluded from builds).

## Core flows

**MZUSD mint/redemption:** `MZUSD.deposit` takes USDC and mints MZUSD;
  `MZUSD.requestWithdrawal` burns MZUSD and asks IssuanceVault to pay USDC.
  Both require the caller to be allowlisted and not sanctioned.

**Tranche deposit/withdraw:** deposit MZUSD into ERC4626; direct-withdraw or
  umbrella (request → wait for epoch → finalize → claim).
 
**Yield:** NAV > supply → `IssuanceVault.distributeYield` → new epoch + yield streaming.
 
**Loss:** NAV < supply → `LossManager.applyLoss` → burn MZUSD from tranches.
 
**Rebalance:** IssuanceVault targets an idle buffer and rebalances USDC to Reservoir.

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

Environment requirements: Node `>=22.21.1`, npm `>=11.6.2`.

## Foundry fuzz setup (auditors)

This repository includes a Foundry fuzz suite in `test/foundry/fuzz/`.

**1) Install Foundry (if missing)**

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

**2) Initialize submodules (required for `forge-std`; skip if already cloned with `--recurse-submodules`)**

```bash
git submodule update --init --recursive
```

**3) Build**

```bash
npm run forge:build
```

**4) Run fuzz tests**

```bash
npm run forge:test:fuzz
```

**5) Run CI-profile fuzz tests (more runs)**

```bash
npm run forge:test:fuzz:ci
```

**6) Generate fuzz coverage summary**

```bash
npm run forge:coverage:fuzz
```

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

**Foundry / fuzz**

 `npm run forge:build` - compile Foundry contracts

 `npm run forge:test` - run all Foundry tests with verbose logs

 `npm run forge:test:fuzz` - run fuzz suite in `test/foundry/fuzz/`

 `npm run forge:test:fuzz:ci` - run fuzz suite with `FOUNDRY_PROFILE=ci`

 `npm run forge:coverage:fuzz` - run Foundry coverage summary for fuzz suite

 `npm run forge:test:ci` - run all Foundry tests with `FOUNDRY_PROFILE=ci`

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
 
 `npm run slither` / `npm run slither:foundry` / `npm run slither:md` - run Slither
 (`slither:foundry` is direct CLI run with Foundry out dir; `slither:md` writes Markdown report and is non-strict)

  Note: this repo uses Foundry output directory `out-foundry` (from `foundry.toml`).
  If you run Slither manually, use:
  `slither . --checklist --config-file ./slither.config.json --foundry-out-directory out-foundry`
 
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

 `npm run deploy:fresh` - force fresh deploy (do not reuse addresses from `reports/deployments.json`)

 `npm run deploy:hardhat:fresh` - force fresh deploy to Hardhat

 `npm run deploy:sepolia` - deploy full stack to Sepolia

 `npm run deploy:sepolia:fresh` - force fresh deploy to Sepolia

 `npm run deploy:mainnet` - deploy full stack to Mainnet

 `npm run deploy:mainnet:fresh` - force fresh deploy to Mainnet

 `npm run deploy:grant-roles -- --network <network>` - grant roles from config

 `npm run deploy:renounce-roles -- --network <network>` - renounce deployer roles (safety checks)

 `npm run deploy:handoff-roles -- --network <network>` - grant roles then renounce

Scripts live in `scripts/deployment/` and `scripts/commands/`.

## Repository structure

 `contracts/` - Solidity source.
 
 `test/` - Hardhat tests.
 
 `scripts/` - deployment and helper scripts.
 
 `documentation/` and `integration-docs/` - detailed guides.
