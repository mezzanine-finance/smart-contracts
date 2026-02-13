**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [unchecked-transfer](#unchecked-transfer) (8 results) (High)
 - [divide-before-multiply](#divide-before-multiply) (2 results) (Medium)
 - [incorrect-equality](#incorrect-equality) (2 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (5 results) (Medium)
 - [unused-return](#unused-return) (2 results) (Medium)
 - [missing-zero-check](#missing-zero-check) (3 results) (Low)
 - [reentrancy-benign](#reentrancy-benign) (2 results) (Low)
 - [reentrancy-events](#reentrancy-events) (8 results) (Low)
 - [redundant-statements](#redundant-statements) (4 results) (Informational)
 - [unused-import](#unused-import) (1 results) (Informational)
## unchecked-transfer
Impact: High
Confidence: Medium
 - [ ] ID-0
[Tranche.claim(uint256)](contracts/Tranche.sol#L232-L248) ignores return value by [IERC20(asset()).transfer(msg.sender,userAssets)](contracts/Tranche.sol#L245)

contracts/Tranche.sol#L232-L248


 - [ ] ID-1
[Vault._allocateYieldToTranches(uint256)](contracts/Vault.sol#L610-L671) ignores return value by [mzusdToken.transfer(t.tranche,totalShare)](contracts/Vault.sol#L660)

contracts/Vault.sol#L610-L671


 - [ ] ID-2
[Vault.withdraw(address,uint256)](contracts/Vault.sol#L182-L196) ignores return value by [usdc.transfer(to,amount)](contracts/Vault.sol#L194)

contracts/Vault.sol#L182-L196


 - [ ] ID-3
[MZUSD.deposit(uint256)](contracts/MZUSD.sol#L110-L123) ignores return value by [usdc.transferFrom(msg.sender,address(vault),amountUSDC)](contracts/MZUSD.sol#L117)

contracts/MZUSD.sol#L110-L123


 - [ ] ID-4
[ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L52-L59) ignores return value by [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L54)

contracts/ReservoirUSDC.sol#L52-L59


 - [ ] ID-5
[PolJuniorTranche.notifyYield(uint256)](contracts/PolJuniorTranche.sol#L87-L93) ignores return value by [mzusd.transfer(polPayout,yieldAmount)](contracts/PolJuniorTranche.sol#L91)

contracts/PolJuniorTranche.sol#L87-L93


 - [ ] ID-6
[ReservoirUSDC.withdraw(uint256,address)](contracts/ReservoirUSDC.sol#L62-L75) ignores return value by [usdc.transfer(to,amount)](contracts/ReservoirUSDC.sol#L70)

contracts/ReservoirUSDC.sol#L62-L75


 - [ ] ID-7
[PolJuniorTranche.withdraw(uint256,address)](contracts/PolJuniorTranche.sol#L75-L83) ignores return value by [mzusd.transfer(receiver,assets)](contracts/PolJuniorTranche.sol#L81)

contracts/PolJuniorTranche.sol#L75-L83


## divide-before-multiply
Impact: Medium
Confidence: Medium
 - [ ] ID-8
[MZUSD.requestWithdrawal(uint256)](contracts/MZUSD.sol#L135-L151) performs a multiplication on the result of a division:
	- [usdcOut = amountMZ / SCALE](contracts/MZUSD.sol#L136)
	- [burnAmount = usdcOut * SCALE](contracts/MZUSD.sol#L138)

contracts/MZUSD.sol#L135-L151


 - [ ] ID-9
[Vault._allocateYieldToTranches(uint256)](contracts/Vault.sol#L610-L671) performs a multiplication on the result of a division:
	- [basePool = (allocatableMZUSD * baseRewardBps) / BPS](contracts/Vault.sol#L616)
	- [baseShare = (basePool * trancheTvl) / totalTvl](contracts/Vault.sol#L649)

contracts/Vault.sol#L610-L671


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-10
[Vault._rebalance()](contracts/Vault.sol#L686-L704) uses a dangerous strict equality:
	- [available == 0](contracts/Vault.sol#L699)

contracts/Vault.sol#L686-L704


 - [ ] ID-11
[Vault.setBuffer(uint256,uint16)](contracts/Vault.sol#L355-L375) uses a dangerous strict equality:
	- [available == 0](contracts/Vault.sol#L369)

contracts/Vault.sol#L355-L375


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-12
[Vault._allocateYieldToTranches(uint256).totalTvl](contracts/Vault.sol#L618) is a local variable never initialized

contracts/Vault.sol#L618


 - [ ] ID-13
[Vault._rebalance().sent](contracts/Vault.sol#L690) is a local variable never initialized

contracts/Vault.sol#L690


 - [ ] ID-14
[Vault._allocateYieldToTranches(uint256).allocated](contracts/Vault.sol#L639) is a local variable never initialized

contracts/Vault.sol#L639


 - [ ] ID-15
[Vault._rebalance().pulled](contracts/Vault.sol#L691) is a local variable never initialized

contracts/Vault.sol#L691


 - [ ] ID-16
[Vault._allocateYieldToTranches(uint256).lastNonZeroIndex](contracts/Vault.sol#L619) is a local variable never initialized

contracts/Vault.sol#L619


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-17
[LossManager.applyLoss(uint256)](contracts/LossManager.sol#L116-L140) ignores return value by [IVault(vault).advanceEpoch()](contracts/LossManager.sol#L130)

contracts/LossManager.sol#L116-L140


 - [ ] ID-18
[Vault._rebalance()](contracts/Vault.sol#L686-L704) ignores return value by [usdc.approve(address(reservoir),sent)](contracts/Vault.sol#L694)

contracts/Vault.sol#L686-L704


## missing-zero-check
Impact: Low
Confidence: Medium
 - [ ] ID-19
[NavOracleAutomation.constructor(address,uint256).vault_](contracts/automation/NavOracleAutomation.sol#L59) lacks a zero-check on :
		- [vault = vault_](contracts/automation/NavOracleAutomation.sol#L63)

contracts/automation/NavOracleAutomation.sol#L59


 - [ ] ID-20
[PolJuniorTranche.initialize(address).polPayoutAddress](contracts/PolJuniorTranche.sol#L46) lacks a zero-check on :
		- [polPayout = polPayoutAddress](contracts/PolJuniorTranche.sol#L55)

contracts/PolJuniorTranche.sol#L46


 - [ ] ID-21
[NavOracleAutomation.constructor(address,uint256).lossManager_](contracts/automation/NavOracleAutomation.sol#L55) lacks a zero-check on :
		- [lossManager = lossManager_](contracts/automation/NavOracleAutomation.sol#L64)

contracts/automation/NavOracleAutomation.sol#L55


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-22
Reentrancy in [ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L52-L59):
	External calls:
	- [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L54)
	State variables written after the call(s):
	- [depositedBy[msg.sender] += amount](contracts/ReservoirUSDC.sol#L56)

contracts/ReservoirUSDC.sol#L52-L59


 - [ ] ID-23
Reentrancy in [LossManager.applyLoss(uint256)](contracts/LossManager.sol#L116-L140):
	External calls:
	- [IVault(vault).advanceEpoch()](contracts/LossManager.sol#L130)
	- [(burnedMZ,uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss))](contracts/LossManager.sol#L132)
		- [ITranche(t0).burnMZUSD(burn0)](contracts/LossManager.sol#L324)
		- [ITranche(t1).burnMZUSD(burn1)](contracts/LossManager.sol#L329)
		- [ITranche(t0).burnMZUSD(burnAmount)](contracts/LossManager.sol#L344)
	State variables written after the call(s):
	- [lastUncoveredLossMZ = uncoveredMZ](contracts/LossManager.sol#L134)
	- [totalUncoveredLossMZ += uncoveredMZ](contracts/LossManager.sol#L136)

contracts/LossManager.sol#L116-L140


## reentrancy-events
Impact: Low
Confidence: Medium
 - [ ] ID-24
Reentrancy in [Tranche.claim(uint256)](contracts/Tranche.sol#L232-L248):
	External calls:
	- [IERC20(asset()).transfer(msg.sender,userAssets)](contracts/Tranche.sol#L245)
	Event emitted after the call(s):
	- [WithdrawalClaimed(msg.sender,epochId,userAssets)](contracts/Tranche.sol#L247)

contracts/Tranche.sol#L232-L248


 - [ ] ID-25
Reentrancy in [ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L52-L59):
	External calls:
	- [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L54)
	Event emitted after the call(s):
	- [Deposited(msg.sender,amount)](contracts/ReservoirUSDC.sol#L58)

contracts/ReservoirUSDC.sol#L52-L59


 - [ ] ID-26
Reentrancy in [Vault._rebalance()](contracts/Vault.sol#L686-L704):
	External calls:
	- [usdc.approve(address(reservoir),sent)](contracts/Vault.sol#L694)
	- [reservoir.deposit(sent)](contracts/Vault.sol#L695)
	- [reservoir.withdraw(pulled,address(this))](contracts/Vault.sol#L701)
	Event emitted after the call(s):
	- [Rebalanced(sent,pulled,usdc.balanceOf(address(this)))](contracts/Vault.sol#L703)

contracts/Vault.sol#L686-L704


 - [ ] ID-27
Reentrancy in [Vault.withdraw(address,uint256)](contracts/Vault.sol#L182-L196):
	External calls:
	- [reservoir.withdraw(amount - idle,address(this))](contracts/Vault.sol#L191)
	- [usdc.transfer(to,amount)](contracts/Vault.sol#L194)
	Event emitted after the call(s):
	- [WithdrawnUSDCFromVault(to,amount)](contracts/Vault.sol#L195)

contracts/Vault.sol#L182-L196


 - [ ] ID-28
Reentrancy in [MZUSD.requestWithdrawal(uint256)](contracts/MZUSD.sol#L135-L151):
	External calls:
	- [vault.withdraw(msg.sender,usdcOut)](contracts/MZUSD.sol#L148)
	Event emitted after the call(s):
	- [Withdrawal(msg.sender,usdcOut)](contracts/MZUSD.sol#L150)

contracts/MZUSD.sol#L135-L151


 - [ ] ID-29
Reentrancy in [NavOracleAutomation._applyPending()](contracts/automation/NavOracleAutomation.sol#L150-L164):
	External calls:
	- [IVault(vault).distributeYield(deltaUSDC)](contracts/automation/NavOracleAutomation.sol#L158)
	- [ILossManager(lossManager).applyLoss(deltaUSDC)](contracts/automation/NavOracleAutomation.sol#L160)
	Event emitted after the call(s):
	- [NavApplied(isYield,deltaUSDC,readyAt)](contracts/automation/NavOracleAutomation.sol#L163)

contracts/automation/NavOracleAutomation.sol#L150-L164


 - [ ] ID-30
Reentrancy in [LossManager.applyLoss(uint256)](contracts/LossManager.sol#L116-L140):
	External calls:
	- [IVault(vault).advanceEpoch()](contracts/LossManager.sol#L130)
	- [(burnedMZ,uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss))](contracts/LossManager.sol#L132)
		- [ITranche(t0).burnMZUSD(burn0)](contracts/LossManager.sol#L324)
		- [ITranche(t1).burnMZUSD(burn1)](contracts/LossManager.sol#L329)
		- [ITranche(t0).burnMZUSD(burnAmount)](contracts/LossManager.sol#L344)
	Event emitted after the call(s):
	- [LossApplied(usdcLoss,_toMZ(usdcLoss),burnedMZ,uncoveredMZ,totalUncoveredLossMZ)](contracts/LossManager.sol#L139)

contracts/LossManager.sol#L116-L140


 - [ ] ID-31
Reentrancy in [PolJuniorTranche.notifyYield(uint256)](contracts/PolJuniorTranche.sol#L87-L93):
	External calls:
	- [mzusd.transfer(polPayout,yieldAmount)](contracts/PolJuniorTranche.sol#L91)
	Event emitted after the call(s):
	- [PolPayoutNotified(yieldAmount)](contracts/PolJuniorTranche.sol#L92)

contracts/PolJuniorTranche.sol#L87-L93


## redundant-statements
Impact: Informational
Confidence: High
 - [ ] ID-32
Redundant expression "[performData](contracts/automation/NavOracleAutomation.sol#L136)" in[NavOracleAutomation](contracts/automation/NavOracleAutomation.sol#L17-L190)

contracts/automation/NavOracleAutomation.sol#L136


 - [ ] ID-33
Redundant expression "[checkData](contracts/automation/NavOracleAutomation.sol#L126)" in[NavOracleAutomation](contracts/automation/NavOracleAutomation.sol#L17-L190)

contracts/automation/NavOracleAutomation.sol#L126


 - [ ] ID-34
Redundant expression "[performData](contracts/automation/UmbrellaEpochFinalizer.sol#L56)" in[UmbrellaEpochFinalizer](contracts/automation/UmbrellaEpochFinalizer.sol#L12-L67)

contracts/automation/UmbrellaEpochFinalizer.sol#L56


 - [ ] ID-35
Redundant expression "[checkData](contracts/automation/UmbrellaEpochFinalizer.sol#L44)" in[UmbrellaEpochFinalizer](contracts/automation/UmbrellaEpochFinalizer.sol#L12-L67)

contracts/automation/UmbrellaEpochFinalizer.sol#L44


## unused-import
Impact: Informational
Confidence: High
 - [ ] ID-36
The following unused import(s) in contracts/AccessManagerImport.sol should be removed:
	-import "@openzeppelin/contracts/access/manager/AccessManager.sol"; (contracts/AccessManagerImport.sol#4)

