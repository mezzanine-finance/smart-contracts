# Access Inventory (ABI Cross-Check Table)

Scope: `contracts/*.sol` (excluding `contracts/test` and `*.disabled`).

Legend:
- `In Source`: `yes` if declared in contract source, otherwise inherited via OZ.
- `Modifiers (source)`: only for source-declared functions (ABI does not include modifiers).
- `Category`: first-pass tag for emergency mapping.
  - `read` (view/pure)
  - `init`
  - `access-control`
  - `upgrade`
  - `pause`
  - `admin-config`
  - `protocol-flow`
  - `loss-mgmt`
  - `user-ingress`
  - `user-egress`
  - `token-ops`
  - `emergency`
- `Allowed Levels`:
  - `L0`: normal operations
  - `L1`: containment (no ingress; allow controlled exits)
  - `L2`: hard pause (no user ops; emergency/admin only)
  - `L3`: recovery-only (upgrade/authority/emergency rescue)

## LossManager
| Function | Mutability | In Source | Visibility | Modifiers (source) | Category | Allowed Levels |
| --- | --- | --- | --- | --- | --- | --- |
| `MZ_DECIMALS()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `SCALE()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `UPGRADE_INTERFACE_VERSION()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `USDC_DECIMALS()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `applyLoss(uint256)` | nonpayable | yes | external | external whenNotPaused nonReentrant restricted | loss-mgmt | L0,L1,L2 |
| `authority()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `initialize(address, address, address[], uint256)` | nonpayable | yes | external | external initializer | init | L0 |
| `isConsumingScheduledOp()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `maxLossPerTxUSDC()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `mzusd()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `pause()` | nonpayable | yes | external | external restricted | pause | L0,L1,L2 |
| `paused()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `proxiableUUID()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `setAuthority(address)` | nonpayable | no | inherited |  | access-control | L0,L2,L3 |
| `setMaxLossPerTxUSDC(uint256)` | nonpayable | yes | external | external restricted | admin-config | L0,L1,L2 |
| `setTrancheOrderAndGroups(address[],uint256[])` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `trancheOrder(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `trancheOrderLength()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `getTrancheOrder()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `getTrancheOrderAndGroups()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `unpause()` | nonpayable | yes | external | external restricted | pause | L0,L1,L2 |
| `upgradeToAndCall(address, bytes)` | payable | no | inherited |  | upgrade | L0,L2,L3 |

## MZUSD
| Function | Mutability | In Source | Visibility | Modifiers (source) | Category | Allowed Levels |
| --- | --- | --- | --- | --- | --- | --- |
| `MAX_WITHDRAW_DUST_MZ()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `MZ_DECIMALS()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `UPGRADE_INTERFACE_VERSION()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `USDC_DECIMALS()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `allowance(address, address)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `approve(address, uint256)` | nonpayable | yes | public | restricted | token-ops | L0,L1 |
| `authority()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `balanceOf(address)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `burn(address, uint256)` | nonpayable | yes | external | external restricted | protocol-flow | L0 |
| `calculateWithdrawalAmounts(uint256)` | pure | yes | public |  | read | L0,L1,L2,L3 |
| `decimals()` | pure | yes | public |  | read | L0,L1,L2,L3 |
| `deposit(uint256)` | nonpayable | yes | external | external nonReentrant restricted | user-ingress | L0 |
| `getRemainingGlobalRedemptionCap()` | view | yes | public |  | read | L0,L1,L2,L3 |
| `getRedemptionWindow()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `globalRedemptionCapUSDC()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `initialize(address, uint256)` | nonpayable | yes | external | external initializer | init | L0 |
| `isConsumingScheduledOp()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `mint(address, uint256)` | nonpayable | yes | external | external restricted | protocol-flow | L0 |
| `name()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `proxiableUUID()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `redemptionWindowDuration()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `requestWithdrawal(uint256)` | nonpayable | yes | external | external nonReentrant restricted | user-egress | L0,L1 |
| `rescueETH(address, uint256)` | nonpayable | yes | external | external restricted | emergency | L2,L3 |
| `setAuthority(address)` | nonpayable | no | inherited |  | access-control | L0,L2,L3 |
| `setGlobalRedemptionCap(uint256)` | nonpayable | yes | external | external restricted | admin-config | L0,L1,L2 |
| `setRedemptionWindowDuration(uint256)` | nonpayable | yes | external | external restricted | admin-config | L0,L1,L2 |
| `setVault(address)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `symbol()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `totalSupply()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `transfer(address, uint256)` | nonpayable | yes | public | restricted | token-ops | L0,L1 |
| `transferFrom(address, address, uint256)` | nonpayable | yes | public | restricted | token-ops | L0,L1 |
| `upgradeToAndCall(address, bytes)` | payable | no | inherited |  | upgrade | L0,L2,L3 |
| `usdc()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `vault()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `windowStartTimestamp()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `windowUsedUSDC()` | view | no | inherited |  | read | L0,L1,L2,L3 |

## ReservoirUSDC
| Function | Mutability | In Source | Visibility | Modifiers (source) | Category | Allowed Levels |
| --- | --- | --- | --- | --- | --- | --- |
| `UPGRADE_INTERFACE_VERSION()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `authority()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `deposit(uint256)` | nonpayable | yes | external | external restricted nonReentrant | protocol-flow | L0 |
| `initialize(address)` | nonpayable | yes | external | external initializer | init | L0 |
| `isConsumingScheduledOp()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `proxiableUUID()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `setAuthority(address)` | nonpayable | no | inherited |  | access-control | L0,L2,L3 |
| `totalAssets()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `upgradeToAndCall(address, bytes)` | payable | no | inherited |  | upgrade | L0,L2,L3 |
| `usdc()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `withdraw(uint256, address)` | nonpayable | yes | external | external restricted nonReentrant | protocol-flow | L0,L1 |

## Tranche
| Function | Mutability | In Source | Visibility | Modifiers (source) | Category | Allowed Levels |
| --- | --- | --- | --- | --- | --- | --- |
| `BASIS_POINTS()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `UPGRADE_INTERFACE_VERSION()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `allowance(address, address)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `approve(address, uint256)` | nonpayable | yes | public | restricted | token-ops | L0,L1 |
| `asset()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `authority()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `balanceOf(address)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `cancelUnstake(uint256, uint256)` | nonpayable | yes | external | external restricted nonReentrant whenNotPaused | user-egress | L0,L1 |
| `claim(uint256)` | nonpayable | yes | external | external restricted nonReentrant whenNotPaused | user-egress | L0,L1 |
| `convertToAssets(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `convertToShares(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `decimals()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `deposit(uint256, address)` | nonpayable | yes | public | restricted whenNotPaused nonReentrant | user-ingress | L0 |
| `depositLimitEnabled()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `getDepositLimitInfo()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `finalizeEpoch(uint256)` | nonpayable | yes | external | external nonReentrant whenNotPaused restricted | protocol-flow | L0,L1 |
| `finalizedEpochs(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `getEpochInfo(uint256)` | view | yes | external |  | read | L0,L1,L2,L3 |
| `getUserEpochInfo(address, uint256)` | view | yes | external |  | read | L0,L1,L2,L3 |
| `initialize(address, address, uint256, uint256, string, string, address, bool, address)` | nonpayable | yes | external | external initializer | init | L0 |
| `isConsumingScheduledOp()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `isPolJunior()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `maxDeposit(address)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `maxDepositCap()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `maxDepositTvlBps()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `maxMint(address)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `maxRedeem(address)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `maxWithdraw(address)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `mint(uint256, address)` | nonpayable | yes | public | restricted whenNotPaused nonReentrant | user-ingress | L0 |
| `name()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `notifyYield(uint256)` | nonpayable | yes | external | external restricted | protocol-flow | L0 |
| `pause()` | nonpayable | yes | external | external restricted | pause | L0,L1,L2 |
| `paused()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `polPayout()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `previewDeposit(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `previewMint(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `previewRedeem(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `previewWithdraw(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `pricePerShare()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `proxiableUUID()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `redeem(uint256, address, address)` | nonpayable | yes | public | restricted | user-egress | L0,L1 |
| `requestWithdrawal(uint256)` | nonpayable | yes | external | external restricted whenNotPaused nonReentrant | user-egress | L0,L1 |
| `setAuthority(address)` | nonpayable | no | inherited |  | access-control | L0,L2,L3 |
| `setDepositLimits(bool, uint256, uint256)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `setPolPayout(address)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `setUnstakeDelayEpochs(uint256)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `sweepPol()` | nonpayable | yes | external | external restricted | protocol-flow | L0 |
| `symbol()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `totalAssets()` | view | yes | public |  | read | L0,L1,L2,L3 |
| `totalSupply()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `trancheId()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `transfer(address, uint256)` | nonpayable | yes | public | restricted | token-ops | L0,L1 |
| `transferFrom(address, address, uint256)` | nonpayable | yes | public | restricted | token-ops | L0,L1 |
| `umbrellaSharesByEpoch(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `unpause()` | nonpayable | yes | external | external restricted | pause | L0,L1,L2 |
| `unstakeDelayEpochs()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `unaccruedYield()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `upgradeToAndCall(address, bytes)` | payable | no | inherited |  | upgrade | L0,L2,L3 |
| `userSharesByEpoch(address, uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `vault()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `withdraw(uint256, address, address)` | nonpayable | yes | public | restricted | user-egress | L0,L1 |
| `yieldStreamEnd()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `yieldStreamStart()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `yieldStreamingAmount()` | view | no | inherited |  | read | L0,L1,L2,L3 |

## Vault
| Function | Mutability | In Source | Visibility | Modifiers (source) | Category | Allowed Levels |
| --- | --- | --- | --- | --- | --- | --- |
| `BPS()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `MAX_EPOCH_DURATION_LIMIT()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `MAX_TRANCHES()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `MIN_EPOCH_DURATION_LIMIT()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `MZUSD_SCALE()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `UPGRADE_INTERFACE_VERSION()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `addTranche(tuple)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `authority()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `bufferHighUSDC()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `bufferLowUSDC()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `getBufferConfig()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `currentEpochId()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `currentIdleUSDC()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `distributeYield(uint256)` | nonpayable | yes | external | external whenNotPaused nonReentrant restricted | protocol-flow | L0 |
| `epochDuration()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `epochStart()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `getEpochConfig()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `hysteresisBps()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `idleBufferUSDC()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `initialize(address, address, address)` | nonpayable | yes | external | external initializer | init | L0 |
| `insurance()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `insuranceBps()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `isConsumingScheduledOp()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `isTranche(address)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `mzusd()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `pause()` | nonpayable | yes | external | external restricted | pause | L0,L1,L2 |
| `paused()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `performanceFeeBps()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `performanceFeeReceiver()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `protocolFeeBps()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `protocolFeeReceiver()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `proxiableUUID()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `rebalance()` | nonpayable | yes | external | external nonReentrant whenNotPaused restricted | protocol-flow | L0 |
| `reservoir()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `setAuthority(address)` | nonpayable | no | inherited |  | access-control | L0,L2,L3 |
| `setBuffer(uint256, uint256)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `setEpochConfig(uint256, bool)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `setFees(uint256, address, uint256, address)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `setInsurance(address, uint256)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `setMZUSD(address)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `setReservoir(address)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `tranches(uint256)` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `tranchesLength()` | view | yes | external |  | read | L0,L1,L2,L3 |
| `getTranches(uint256,uint256)` | view | yes | external |  | read | L0,L1,L2,L3 |
| `unpause()` | nonpayable | yes | external | external restricted | pause | L0,L1,L2 |
| `updateTranche(uint256, uint256, bool)` | nonpayable | yes | external | external restricted | admin-config | L0 |
| `upgradeToAndCall(address, bytes)` | payable | no | inherited |  | upgrade | L0,L2,L3 |
| `usdc()` | view | no | inherited |  | read | L0,L1,L2,L3 |
| `withdraw(address, uint256)` | nonpayable | yes | external | external whenNotPaused nonReentrant restricted | protocol-flow | L0,L1 |
