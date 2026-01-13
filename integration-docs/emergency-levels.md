# Emergency Levels Policy v1 (State-Changing Methods)

Scope: state-changing methods only (nonpayable/payable). Initializers are excluded (deployment/upgrade only). No Pausable/whenNotPaused is used in the protocol. Emergency stop is enforced exclusively via AccessManager role gating.

## Level Summary
- `L0` (Normal): all protocol flows and admin configs are enabled.
- `L1` (Pause ingress): block user ingress and risky protocol ops; keep user egress and loss handling available.
- `L2` (Full stop): block all user ops and capital movement; only upgrades and minimal emergency/admin actions remain.

## L0 (Normal)
All protocol flows are enabled; admin configuration is allowed.

Allowed (state-changing):
| Contract | Methods |
| --- | --- |
| `LossManager` | `applyLoss(uint256)` (loss-mgmt); `setTrancheOrder(address[])` (admin-config); `setMaxLossPerTxUSDC(uint256)` (admin-config); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |
| `MZUSD` | `deposit(uint256)` (user-ingress); `requestWithdrawal(uint256)` (user-egress); `approve(address,uint256)` (token-ops); `transfer(address,uint256)` (token-ops); `transferFrom(address,address,uint256)` (token-ops); `mint(address,uint256)` (protocol-flow); `burn(address,uint256)` (loss-mgmt); `setGlobalHourlyRedemptionCap(uint256)` (admin-config); `setRedemptionWindowDuration(uint256)` (admin-config); `setVault(address)` (admin-config); `rescueETH(address,uint256)` (emergency); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |
| `ReservoirUSDC` | `deposit(uint256)` (protocol-flow); `withdraw(uint256,address)` (protocol-flow); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |
| `Tranche` | `deposit(uint256,address)` (user-ingress); `mint(uint256,address)` (user-ingress); `requestWithdrawal(uint256)` (user-egress); `cancelUnstake(uint256,uint256)` (user-egress); `claim(uint256)` (user-egress); `withdraw(uint256,address,address)` (user-egress); `redeem(uint256,address,address)` (user-egress); `approve(address,uint256)` (token-ops); `transfer(address,uint256)` (token-ops); `transferFrom(address,address,uint256)` (token-ops); `finalizeEpoch(uint256)` (public-finalization); `notifyYield(uint256)` (protocol-flow); `setUnstakeDelayEpochs(uint256)` (admin-config); `setDepositLimits(bool,uint256,uint256)` (admin-config); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |
| `Vault` | `withdraw(address,uint256)` (protocol-flow); `rebalance()` (protocol-flow); `distributeYield(uint256)` (protocol-flow); `setReservoir(address)` (admin-config); `setMZUSD(address)` (admin-config); `setFees(uint256,address,uint256,address)` (admin-config); `addTranche((address,uint16,bool))` (admin-config); `updateTranche(uint256,uint256,bool)` (admin-config); `setInsurance(address,uint256)` (admin-config); `setBuffer(uint256,uint256)` (admin-config); `setEpochConfig(uint256,bool)` (admin-config); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |

Blocked (state-changing):
| Contract | Methods |
| --- | --- |
| `LossManager` | `setAuthority(address)` (access-control) |
| `MZUSD` | `setAuthority(address)` (access-control) |
| `ReservoirUSDC` | `setAuthority(address)` (access-control) |
| `Tranche` | `setAuthority(address)` (access-control) |
| `Vault` | `setAuthority(address)` (access-control) |

## L1 (Pause ingress)
User ingress and risky protocol operations are blocked. Egress remains available.

Allowed (state-changing):
| Contract | Methods |
| --- | --- |
| `LossManager` | `applyLoss(uint256)` (loss-mgmt); `setMaxLossPerTxUSDC(uint256)` (admin-config); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |
| `MZUSD` | `requestWithdrawal(uint256)` (user-egress); `approve(address,uint256)` (token-ops); `transfer(address,uint256)` (token-ops); `transferFrom(address,address,uint256)` (token-ops); `burn(address,uint256)` (loss-mgmt); `setGlobalHourlyRedemptionCap(uint256)` (admin-config); `setRedemptionWindowDuration(uint256)` (admin-config); `rescueETH(address,uint256)` (emergency); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |
| `ReservoirUSDC` | `withdraw(uint256,address)` (protocol-flow); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |
| `Tranche` | `requestWithdrawal(uint256)` (user-egress); `cancelUnstake(uint256,uint256)` (user-egress); `claim(uint256)` (user-egress); `withdraw(uint256,address,address)` (user-egress); `redeem(uint256,address,address)` (user-egress); `approve(address,uint256)` (token-ops); `transfer(address,uint256)` (token-ops); `transferFrom(address,address,uint256)` (token-ops); `finalizeEpoch(uint256)` (public-finalization); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |
| `Vault` | `withdraw(address,uint256)` (protocol-flow); `upgradeToAndCall(address,bytes)` (upgrade, timelocked) |

Blocked (state-changing):
| Contract | Methods |
| --- | --- |
| `LossManager` | `setTrancheOrder(address[])` (admin-config); `setAuthority(address)` (access-control) |
| `MZUSD` | `deposit(uint256)` (user-ingress); `mint(address,uint256)` (protocol-flow); `setVault(address)` (admin-config); `setAuthority(address)` (access-control) |
| `ReservoirUSDC` | `deposit(uint256)` (protocol-flow); `setAuthority(address)` (access-control) |
| `Tranche` | `deposit(uint256,address)` (user-ingress); `mint(uint256,address)` (user-ingress); `notifyYield(uint256)` (protocol-flow); `setUnstakeDelayEpochs(uint256)` (admin-config); `setDepositLimits(bool,uint256,uint256)` (admin-config); `setAuthority(address)` (access-control) |
| `Vault` | `rebalance()` (protocol-flow); `distributeYield(uint256)` (protocol-flow); `setReservoir(address)` (admin-config); `setMZUSD(address)` (admin-config); `setFees(uint256,address,uint256,address)` (admin-config); `addTranche((address,uint16,bool))` (admin-config); `updateTranche(uint256,uint256,bool)` (admin-config); `setInsurance(address,uint256)` (admin-config); `setBuffer(uint256,uint256)` (admin-config); `setEpochConfig(uint256,bool)` (admin-config); `setAuthority(address)` (access-control) |

## L2 (Full stop)
All user operations and capital movement are blocked. Only upgrades and minimal emergency/admin actions remain.

Allowed (state-changing):
| Contract | Methods |
| --- | --- |
| `LossManager` | `applyLoss(uint256)` (loss-mgmt); `setTrancheOrder(address[])` (admin-config); `setMaxLossPerTxUSDC(uint256)` (admin-config); `setAuthority(address)` (access-control); `upgradeToAndCall(address,bytes)` (upgrade) |
| `MZUSD` | `burn(address,uint256)` (loss-mgmt); `rescueETH(address,uint256)` (emergency); `setAuthority(address)` (access-control); `upgradeToAndCall(address,bytes)` (upgrade) |
| `ReservoirUSDC` | `setAuthority(address)` (access-control); `upgradeToAndCall(address,bytes)` (upgrade) |
| `Tranche` | `setAuthority(address)` (access-control); `upgradeToAndCall(address,bytes)` (upgrade) |
| `Vault` | `setAuthority(address)` (access-control); `upgradeToAndCall(address,bytes)` (upgrade) |

Blocked (state-changing):
| Contract | Methods |
| --- | --- |
| `MZUSD` | `deposit(uint256)` (user-ingress); `requestWithdrawal(uint256)` (user-egress); `approve(address,uint256)` (token-ops); `transfer(address,uint256)` (token-ops); `transferFrom(address,address,uint256)` (token-ops); `mint(address,uint256)` (protocol-flow); `setGlobalHourlyRedemptionCap(uint256)` (admin-config); `setRedemptionWindowDuration(uint256)` (admin-config); `setVault(address)` (admin-config) |
| `ReservoirUSDC` | `deposit(uint256)` (protocol-flow); `withdraw(uint256,address)` (protocol-flow) |
| `Tranche` | `deposit(uint256,address)` (user-ingress); `mint(uint256,address)` (user-ingress); `requestWithdrawal(uint256)` (user-egress); `cancelUnstake(uint256,uint256)` (user-egress); `claim(uint256)` (user-egress); `withdraw(uint256,address,address)` (user-egress); `redeem(uint256,address,address)` (user-egress); `approve(address,uint256)` (token-ops); `transfer(address,uint256)` (token-ops); `transferFrom(address,address,uint256)` (token-ops); `finalizeEpoch(uint256)` (public-finalization); `notifyYield(uint256)` (protocol-flow); `setUnstakeDelayEpochs(uint256)` (admin-config); `setDepositLimits(bool,uint256,uint256)` (admin-config) |
| `Vault` | `withdraw(address,uint256)` (protocol-flow); `rebalance()` (protocol-flow); `distributeYield(uint256)` (protocol-flow); `setReservoir(address)` (admin-config); `setMZUSD(address)` (admin-config); `setFees(uint256,address,uint256,address)` (admin-config); `addTranche((address,uint16,bool))` (admin-config); `updateTranche(uint256,uint256,bool)` (admin-config); `setInsurance(address,uint256)` (admin-config); `setBuffer(uint256,uint256)` (admin-config); `setEpochConfig(uint256,bool)` (admin-config) |

## Why delays (AccessManager)
We rely on AccessManager execution delays to prevent bypassing the stop by admin operations (granting roles, changing function roles, or altering delays). Escalation is fast (no delay), while de-escalation and upgrades require scheduling with a delay that is at least as long as the relax delay. Protocol admin operations use a separate role with no execution delay so normal ops stay responsive while AccessManager reconfiguration stays slow.

Note: AccessManager applies a `minSetback` (currently 5 days) to delay changes, so grant-delay updates become effective only after that setback. Bootstrapping should account for this warmup window.
