# WIP Deployment Guide (Phase 1)

This document defines the intended deployment flow and configuration for the current
codebase. It is meant to pair with `documentation/access-control.md` and
`documentation/pause-manager.md` and to serve as the source of truth for rewriting
deployment scripts.

## Scope and topology
The protocol supports multiple tranches. The code does not hardcode a count (Vault cap is
`MAX_TRANCHES = 50`). For the intended production topology:
- 3 user tranches: **Senior** (instant withdrawal, no deposit cap), **Mezzanine** and
  **Junior** (umbrella withdrawals with delays and deposit caps).
- 1 protocol-owned tranche: **PolJuniorTranche** (instant withdrawals, yield forwarded
  immediately to `polPayout`).

Implementation-wise, **Senior/Mezzanine/Junior are all `Tranche` instances** with different
constructor flags and config. **PolJuniorTranche** is a separate contract.

## Deployment order (recommended)
1. **AccessManager** (openzeppelin `AccessManager`).
2. **PauseManager** (UUPS proxy).
3. **ReservoirUSDC** (UUPS proxy).
4. **Vault** (UUPS proxy).
5. **MZUSD** (UUPS proxy).
6. **LossManager** (UUPS proxy).
7. **Tranches** (UUPS proxies, one per tranche).
8. **PolJuniorTranche** (UUPS proxy).
9. **NavOracleAutomation** (non-upgradeable).
10. **UmbrellaEpochFinalizer** (optional; one per umbrella tranche).

## Wiring and configuration checklist
Use this checklist in scripts after deploying all components.

**Core wiring**
- `Vault.setMZUSD(MZUSD)` (one-time).
- `MZUSD.setLossManager(LossManager)` (one-time).
- `Vault.setLossManager(LossManager)` (one-time).
- `Vault.setNavOracle(NavOracleAutomation)` (one-time).
- `LossManager.setNavOracle(NavOracleAutomation)`.

**Vault configuration**
- `Vault.setFees(performanceFeeBps, performanceFeeReceiver, protocolFeeBps, protocolFeeReceiver)`.
- `Vault.setBuffer(idleBufferUSDC, hysteresisBps)` (optional override of defaults).
- `Vault.setEpochConfig(epochDuration)` (optional; queues for next epoch).
- `Vault.addTranche(...)` for each tranche (Senior/Mezzanine/Junior, optionally PolJuniorTranche).

**Tranche configuration**
- `Tranche.setUnstakeDelayEpochs()` for umbrella tranches.
- `Tranche.setDepositLimits(enabled, capUSDC, tvlBps)` for Mezzanine/Junior.
- Senior tranche should be deployed with `directWithdrawEnabled = true`.
- Mezzanine/Junior should be deployed with `directWithdrawEnabled = false`.

**LossManager configuration**
- Initialize with `trancheOrder` and `groupIds`.
  - Order is the burn priority for loss allocation.
  - `groupIds` allow proportional splitting between *contiguous pairs* only.
- `LossManager.setMaxLossPerTxUSDC()` (optional).

**Automation**
- Deploy `NavOracleAutomation` and set `vetoPeriod`.
- Deploy `UmbrellaEpochFinalizer` for each umbrella tranche if using Chainlink Automation.

**Access control**
- Configure function roles as described in `documentation/access-control.md`.
- Ensure `RESERVOIR_WITHDRAW_ROLE` (Vault + operators → Reservoir withdraw) is granted
  to the correct addresses.

## Configuration schema (per network)
Deployment scripts should read a JSON config per network. Below is the minimum set of
fields with meaning and constraints. The intent is to keep the config explicit and
avoid “magic defaults” in scripts.

### Global config
| Key | Type | Required | Meaning / Impact |
| --- | --- | --- | --- |
| `usdc` | address | yes | USDC token address (6 decimals). |
| `accessManager.admin` | address | yes | Admin/multisig for AccessManager. |
| `roles.guardian` | address | no | Address for PAUSER role (defaults to admin). |
| `roles.unpauser` | address | no | Address for UNPAUSER role (defaults to admin). |
| `roles.upgrader` | address | no | Address for UPGRADER role (defaults to admin). |
| `mzusd.redemptionCapUSDC` | uint (6d) | yes | Global redemption cap (must be `> 0` and `<= USDC.totalSupply`). Set to a very large value if you want “effectively unlimited” behavior. |
| `mzusd.redemptionWindowDurationSec` | uint | no | Overrides default redemption window duration. |
| `vault.performanceFeeBps` | uint16 | yes | Performance fee in bps. |
| `vault.protocolFeeBps` | uint16 | yes | Protocol fee in bps. |
| `vault.performanceFeeReceiver` | address | yes | Fee receiver (non-zero). |
| `vault.protocolFeeReceiver` | address | yes | Fee receiver (non-zero, distinct). |
| `vault.idleBufferUSDC` | uint (6d) | no | Idle buffer target. |
| `vault.hysteresisBps` | uint16 | no | Idle buffer hysteresis. |
| `vault.epochDurationSec` | uint | no | Epoch duration for tranche streaming/umbrella. |
| `lossManager.maxLossPerTxUSDC` | uint (6d) | no | 0 disables the limit. |
| `navOracle.vetoPeriodSec` | uint | yes | Veto window for NAV snapshots. |
| `navOracle.oracles` | address[] | yes | ORACLE_ROLE addresses. |

### Tranche config (array)
| Key | Type | Required | Meaning / Impact |
| --- | --- | --- | --- |
| `id` | uint | yes | Tranche id for Vault registration. |
| `name` | string | yes | ERC20 name. |
| `symbol` | string | yes | ERC20 symbol. |
| `weight` | uint16 | yes | Weight in Vault yield distribution. |
| `enabled` | bool | yes | Enabled flag for Vault distribution. |
| `directWithdrawEnabled` | bool | yes | Immutable; `true` for Senior, `false` for umbrella tranches. |
| `unstakeDelayEpochs` | uint | no | Umbrella delay (ignored for direct mode). |
| `depositLimits.enabled` | bool | no | Enables deposit caps. |
| `depositLimits.capUSDC` | uint (6d) | no | Absolute deposit cap. |
| `depositLimits.tvlBps` | uint16 | no | Max TVL vs Vault TVL in bps. |

### LossManager tranche order config
| Key | Type | Required | Meaning / Impact |
| --- | --- | --- | --- |
| `lossManager.order` | address[] | yes | Burn order for losses (usually Junior → Mezz → Senior). |
| `lossManager.groupIds` | uint[] | yes | Parallel array; non-zero ids create proportional loss sharing for contiguous pairs only. |

### PolJuniorTranche config
| Key | Type | Required | Meaning / Impact |
| --- | --- | --- | --- |
| `polJunior.name` | string | yes | ERC20 name. |
| `polJunior.symbol` | string | yes | ERC20 symbol. |
| `polJunior.polPayout` | address | yes | Address that receives all yield immediately. |
| `polJunior.registerInVault` | bool | no | If `true`, add as tranche to Vault distribution. Decide whether POL should share yield and/or losses. |

## Notes and decisions
- The repo’s tests deploy **three** `Tranche` contracts (Junior/Mezzanine/Senior) and a
  **PolJuniorTranche**. That is the intended baseline.
- `directWithdrawEnabled` is immutable and must be set at deploy time.
- If you want PolJuniorTranche to receive yield from Vault, register it with `Vault.addTranche`.
  Decide whether it should be in LossManager’s burn order (tests currently exclude it).
- Access control roles and delays are documented in `documentation/access-control.md`.
