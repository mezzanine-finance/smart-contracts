# Deployment Guide (Phase 1)

This document defines the intended deployment flow and configuration for the current
codebase. It is meant to pair with `documentation/access-control.md` and
`documentation/pause-manager.md` and to serve as the source of truth for rewriting
deployment scripts.

## Scope and topology

The protocol supports multiple tranches. The code does not hardcode a count (Vault cap is
`MAX_TRANCHES = 50`). For the intended production topology:

- 3 user tranches: **Senior** (instant withdrawal, no deposit cap), **Mezzanine** and
  **Junior** (umbrella withdrawals with delays and deposit caps).
- 1 protocol-owned tranche: **PolJuniorTranche** (admin-only withdrawals, yield forwarded
  immediately to `polPayout`).

Implementation-wise, **Senior/Mezzanine/Junior are all `Tranche` instances** with different
constructor flags and config. **PolJuniorTranche** is a separate contract.

## Deployment order (recommended)

1. **AccessManager** (openzeppelin `AccessManager`).
2. **PauseManager** (UUPS proxy).
3. **USDC** (real address or `MockUSDC` if configured).
4. **ReservoirUSDC** (UUPS proxy).
5. **MZUSD** (UUPS proxy).
6. **Vault** (UUPS proxy).
7. **Tranches** (UUPS proxies, one per tranche).
8. **PolJuniorTranche** (UUPS proxy).
9. **LossManager** (UUPS proxy).
10. **NavOracleAutomation** (non-upgradeable).
11. **UmbrellaEpochFinalizer** (optional; one per umbrella tranche).

## Wiring and configuration checklist

Use this checklist in scripts after deploying all components.

**Core wiring**

- `MZUSD.setVault(Vault)` (one-time).
- `ReservoirUSDC.setVault(Vault)` (one-time, used for tracking).
- `MZUSD.setLossManager(LossManager)` (one-time).
- `Vault.setLossManager(LossManager)` (one-time).
- `Vault.setNavOracle(NavOracleAutomation)` (updatable, with strict reference checks).

**Vault configuration**

- `Vault` fees are set during initialization from config.
- `Vault.setBuffer(idleBufferUSDC, hysteresisBps)` (required if configured).
    - This calls `_rebalance` and will revert if Vault+Reservoir are empty.
    - Seed USDC before calling (see **Seeding**).
- `Vault.setEpochConfig(epochDuration)` (optional; queues for next epoch).
- `Vault.addTranche(...)` for each tranche (Senior/Mezzanine/Junior, optionally PolJuniorTranche).

**Tranche configuration**

- `Tranche.setUnstakeDelayEpochs()` for umbrella tranches.
- `Tranche.setDepositLimits(enabled, capMZUSD, tvlBps)` for Mezzanine/Junior.
- Senior tranche should be deployed with `directWithdrawEnabled = true`.
- Mezzanine/Junior should be deployed with `directWithdrawEnabled = false`.

**LossManager configuration**

- Initialize with `trancheOrder` and `isPairedWithNext`.
    - Order is the burn priority for loss allocation.
    - `isPairedWithNext` uses contiguous `true,true` flags to define proportional pairs.
- `LossManager.setMaxLossPerTxUSDC()` (optional).

**Seeding**

- `MZUSD.deposit(amountUSDC)` to mint MZUSD and fund the Vault (recommended for buffer funding).
- Optional direct USDC transfer to `Vault` or `ReservoirUSDC.deposit`.
- Optional tranche deposits (MZUSD → `Tranche.deposit`) for initial TVL.
    - Deposit limits apply; if enabled, ensure MZUSD total supply and limits allow the seed.

**Automation**

- Deploy `NavOracleAutomation` and set `vetoPeriod`.
- Deploy `UmbrellaEpochFinalizer` for each umbrella tranche if using Chainlink Automation.
    - `UmbrellaEpochFinalizer` is cursor-based and processes at most one epoch per upkeep tx.
    - During catch-up, expect one upkeep transaction per missed epoch.
    - Choose `umbrellaFinalizer.startEpoch` carefully: if it is set above the oldest unfinalized epoch, older epochs can be skipped by this helper.
- For NAV oracle rotations, follow `integration-docs/NAV_AUTOMATION.md`:
    - settle/reject pending NAV on old oracle first,
    - then update `Vault.setNavOracle(new)`,
    - then revoke old oracle permissions.

**Access control**

- Configure function roles as described in `documentation/access-control.md`.
- Ensure `RESERVOIR_WITHDRAW_ROLE` (Vault + operators → Reservoir withdraw) is granted
  to the correct addresses.
- If you plan to renounce deployer roles, ensure all roles have non-deployer members.

## Scripts

- Orchestrator: `scripts/deployment/deploy.ts`
    - Reads a network-specific JSON config and deploys + wires everything in order.
    - Skips verification automatically on `hardhat`/`localhost`.
- Role grants: `scripts/deployment/grantRoles.ts`
    - Grants roles from config (optionally include dev via `--include-dev`).
- Role cleanup: `scripts/deployment/renounceRoles.ts`
    - Renounces deployer roles only if another member already holds each role.
- Handoff: `scripts/deployment/handoffRoles.ts`
    - Runs grant + renounce in sequence.

## Config files

Network configs live in `scripts/deployment/config/<network>.json` and are loaded based on
the `--network` flag. You can override with `--config <path>`.
Each config includes the deployment signer (`dev.deployer`), final role owners (`roles.*`),
and optional seed amounts for initial liquidity.

## Configuration schema (per network)

Deployment scripts should read a JSON config per network. Below is the minimum set of
fields with meaning and constraints. The intent is to keep the config explicit and
avoid “magic defaults” in scripts.

### Global config

| Key                                 | Type      | Required                       | Meaning / Impact                                                                                                                          |
| ----------------------------------- | --------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dev.deployer`                      | address   | yes                            | Deployment signer; used as initial AccessManager admin. Must match the deployer key.                                                      |
| `dev.grantRoles`                    | bool      | no                             | If `true`, deploy script also grants all roles to dev for initial ops.                                                                    |
| `roleIds.*`                         | uint64    | yes                            | Custom AccessManager role ids (`PAUSER_ROLE`, `UNPAUSER_ROLE`, `UPGRADER_ROLE`, `RESERVOIR_WITHDRAW_ROLE`, `ORACLE_ROLE`, `BURNER_ROLE`). |
| `roles.admin`                       | address   | yes                            | Final admin/multisig for AccessManager (client).                                                                                          |
| `roles.pauser`                      | address   | yes                            | Address for PAUSER role.                                                                                                                  |
| `roles.unpauser`                    | address   | yes                            | Address for UNPAUSER role.                                                                                                                |
| `roles.upgrader`                    | address   | yes                            | Address for UPGRADER role.                                                                                                                |
| `roles.reservoirWithdrawers`        | address[] | no                             | Additional withdrawers for Reservoir (Vault is auto-added).                                                                               |
| `roles.roleDelays.unpauser`         | uint      | no                             | Execution delay for UNPAUSER role.                                                                                                        |
| `roles.roleDelays.upgrader`         | uint      | no                             | Execution delay for UPGRADER role.                                                                                                        |
| `usdc.deployMock`                   | bool      | yes                            | If `true`, deploy `MockUSDC`.                                                                                                             |
| `usdc.address`                      | address   | required if `deployMock=false` | Real USDC address.                                                                                                                        |
| `usdc.mock.*`                       | object    | required if `deployMock=true`  | Mock USDC metadata + initial mints.                                                                                                       |
| `mzusd.redemptionCapUSDC`           | uint (6d) | yes                            | Global redemption cap (must be `> 0` and `<= USDC.totalSupply`).                                                                          |
| `mzusd.redemptionWindowDurationSec` | uint      | no                             | Overrides default redemption window duration.                                                                                             |
| `vault.performanceFeeBps`           | uint16    | yes                            | Performance fee in bps.                                                                                                                   |
| `vault.protocolFeeBps`              | uint16    | yes                            | Protocol fee in bps.                                                                                                                      |
| `vault.performanceFeeReceiver`      | address   | yes                            | Fee receiver (non-zero).                                                                                                                  |
| `vault.protocolFeeReceiver`         | address   | yes                            | Fee receiver (non-zero, distinct).                                                                                                        |
| `vault.idleBufferUSDC`              | uint (6d) | no                             | Idle buffer target (set together with `vault.hysteresisBps`).                                                                             |
| `vault.hysteresisBps`               | uint16    | no                             | Idle buffer hysteresis (set together with `vault.idleBufferUSDC`).                                                                        |
| `vault.epochDurationSec`            | uint      | no                             | Epoch duration for tranche streaming/umbrella.                                                                                            |
| `lossManager.maxLossPerTxUSDC`      | uint (6d) | no                             | 0 disables the limit.                                                                                                                     |
| `navOracle.vetoPeriodSec`           | uint      | yes                            | Veto window for NAV snapshots.                                                                                                            |
| `navOracle.oracles`                 | address[] | yes                            | ORACLE_ROLE addresses.                                                                                                                    |
| `umbrellaFinalizer.enabled`         | bool      | no                             | Enables deployment of `UmbrellaEpochFinalizer` for umbrella tranches.                                                                    |
| `umbrellaFinalizer.startEpoch`      | uint      | no                             | Initial finalizer cursor (`>= 1`, default `1`). Set to the oldest epoch you want the helper to process; higher values can skip older epochs. |
| `seed.mzusdDepositUSDC`             | uint (6d) | no                             | USDC amount to deposit into MZUSD (funds Vault + mints MZUSD).                                                                            |
| `seed.vaultUSDC`                    | uint (6d) | no                             | Direct USDC transfer to Vault.                                                                                                            |
| `seed.reservoirUSDC`                | uint (6d) | no                             | USDC deposit into Reservoir.                                                                                                              |
| `seed.trancheDeposits[].key`        | string    | no                             | Tranche key to seed.                                                                                                                      |
| `seed.trancheDeposits[].amountMZUSD` | uint (18d) | no                             | MZUSD amount to deposit into tranche.                                                                           |
| `seed.trancheDeposits[].receiver`   | address   | no                             | Receiver of tranche shares.                                                                                                               |
| `postDeploy.renounceDeployerRoles`  | bool      | no                             | If `true`, run renounce workflow after deployment.                                                                                        |
| `verify.enabled`                    | bool      | no                             | Enable Etherscan verification (auto-skipped locally).                                                                                     |

### Tranche config (array)

| Key                     | Type      | Required | Meaning / Impact                                             |
| ----------------------- | --------- | -------- | ------------------------------------------------------------ |
| `key`                   | string    | yes      | Unique tranche key used in `lossManager.order`.              |
| `trancheId`              | uint      | yes      | Tranche id for Vault registration.                           |
| `name`                  | string    | yes      | ERC20 name.                                                  |
| `symbol`                | string    | yes      | ERC20 symbol.                                                |
| `weight`                | uint16    | yes      | Weight in Vault yield distribution.                          |
| `enabled`               | bool      | yes      | Enabled flag for Vault distribution.                         |
| `directWithdrawEnabled` | bool      | yes      | Immutable; `true` for Senior, `false` for umbrella tranches. |
| `unstakeDelayEpochs`    | uint      | no       | Umbrella delay (ignored for direct mode).                    |
| `depositLimits.enabled` | bool      | no       | Enables deposit caps.                                        |
| `depositLimits.capMZUSD` | uint (18d) | no       | Absolute deposit cap in MZUSD units.                         |
| `depositLimits.tvlBps`  | uint16    | no       | Max TVL vs Vault TVL in bps.                                 |

### LossManager tranche order config

| Key                    | Type     | Required | Meaning / Impact                                                                         |
| ---------------------- | -------- | -------- | ---------------------------------------------------------------------------------------- |
| `lossManager.order`    | string[] | yes      | Burn order by tranche key (e.g. `polJunior`, `junior`, `mezzanine`, `senior`).           |
| `lossManager.isPairedWithNext` | bool[] | yes      | Parallel array; contiguous `true,true` flags create proportional loss sharing pairs. |

### PolJuniorTranche config

| Key                         | Type    | Required                           | Meaning / Impact                                                                                      |
| --------------------------- | ------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `polJunior.polPayout`       | address | yes                                | Address that receives all yield immediately.                                                          |
| `polJunior.registerInVault` | bool    | no                                 | If `true`, add as tranche to Vault distribution. Decide whether POL should share yield and/or losses. |
| `polJunior.weight`          | uint16  | required if `registerInVault=true` | Weight used in Vault distribution.                                                                    |

Notes:
- PolJuniorTranche is an admin-only escrow (no ERC4626 shares); withdrawals are restricted.
- Admins fund it by transferring MZUSD directly to the tranche address.

## Notes and decisions

- The repo’s tests deploy **three** `Tranche` contracts (Junior/Mezzanine/Senior) and a
  **PolJuniorTranche**. That is the intended baseline.
- `directWithdrawEnabled` is immutable and must be set at deploy time.
- `Vault.mzusd`, `Vault.usdc`, and `Vault.reservoir` are immutable constructor params
  on the implementation and must be passed via proxy `constructorArgs` at deployment time.
- `PolJuniorTranche.vault` is an immutable constructor param (pass via proxy `constructorArgs`).
- PolJuniorTranche is **intended** for MZUSD and validates MZUSD authority/pause manager wiring on initialize.
- PolJuniorTranche can be registered in Vault distribution via `polJunior.registerInVault`.
- LossManager order is defined by `lossManager.order` and can include `polJunior` as a grouped pair.
- Access control roles and delays are documented in `documentation/access-control.md`.
- Vault requires **distinct** performance/protocol fee receivers.
- The deploy scripts assume `dev.deployer` is the deploying signer and initial admin.
- Default configs use higher `weight` for Junior and lower for Senior to match risk.
- The JSON configs include default fees, veto periods, buffer sizes, and seed amounts; review before mainnet.
