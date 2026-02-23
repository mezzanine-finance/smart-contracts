**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [unchecked-transfer](#unchecked-transfer) (10 results) (High)
 - [divide-before-multiply](#divide-before-multiply) (3 results) (Medium)
 - [incorrect-equality](#incorrect-equality) (2 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (7 results) (Medium)
 - [unused-return](#unused-return) (2 results) (Medium)
 - [missing-zero-check](#missing-zero-check) (3 results) (Low)
 - [reentrancy-benign](#reentrancy-benign) (2 results) (Low)
 - [reentrancy-events](#reentrancy-events) (8 results) (Low)
 - [costly-loop](#costly-loop) (1 results) (Informational)
 - [cyclomatic-complexity](#cyclomatic-complexity) (2 results) (Informational)
 - [redundant-statements](#redundant-statements) (4 results) (Informational)
 - [unused-import](#unused-import) (1 results) (Informational)
## unchecked-transfer
Impact: High
Confidence: Medium
 - [ ] ID-0
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L681-L792) ignores return value by [mzusdToken.transfer(pairedAddr,share1)](contracts/IssuanceVault.sol#L754)

contracts/IssuanceVault.sol#L681-L792


 - [ ] ID-1
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L681-L792) ignores return value by [mzusdToken.transfer(t.tranche,share0)](contracts/IssuanceVault.sol#L750)

contracts/IssuanceVault.sol#L681-L792


 - [ ] ID-2
[MZUSD.deposit(uint256)](contracts/MZUSD.sol#L110-L123) ignores return value by [usdc.transferFrom(msg.sender,address(vault),amountUSDC)](contracts/MZUSD.sol#L117)

contracts/MZUSD.sol#L110-L123


 - [ ] ID-3
[ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L52-L59) ignores return value by [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L54)

contracts/ReservoirUSDC.sol#L52-L59


 - [ ] ID-4
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L681-L792) ignores return value by [mzusdToken.transfer(t.tranche,totalShare)](contracts/IssuanceVault.sol#L779)

contracts/IssuanceVault.sol#L681-L792


 - [ ] ID-5
[PolJuniorTranche.notifyYield(uint256)](contracts/PolJuniorTranche.sol#L87-L93) ignores return value by [mzusd.transfer(polPayout,yieldAmount)](contracts/PolJuniorTranche.sol#L91)

contracts/PolJuniorTranche.sol#L87-L93


 - [ ] ID-6
[IssuanceVault.withdraw(address,uint256)](contracts/IssuanceVault.sol#L191-L205) ignores return value by [usdc.transfer(to,amount)](contracts/IssuanceVault.sol#L203)

contracts/IssuanceVault.sol#L191-L205


 - [ ] ID-7
[ReservoirUSDC.withdraw(uint256,address)](contracts/ReservoirUSDC.sol#L62-L75) ignores return value by [usdc.transfer(to,amount)](contracts/ReservoirUSDC.sol#L70)

contracts/ReservoirUSDC.sol#L62-L75


 - [ ] ID-8
[Tranche.claim(uint256)](contracts/Tranche.sol#L234-L250) ignores return value by [IERC20(asset()).transfer(msg.sender,userAssets)](contracts/Tranche.sol#L247)

contracts/Tranche.sol#L234-L250


 - [ ] ID-9
[PolJuniorTranche.withdraw(uint256,address)](contracts/PolJuniorTranche.sol#L75-L83) ignores return value by [mzusd.transfer(receiver,assets)](contracts/PolJuniorTranche.sol#L81)

contracts/PolJuniorTranche.sol#L75-L83


## divide-before-multiply
Impact: Medium
Confidence: Medium
 - [ ] ID-10
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L681-L792) performs a multiplication on the result of a division:
	- [basePool = (allocatableMZUSD * baseRewardBps) / BPS](contracts/IssuanceVault.sol#L687)
	- [pairBaseShare = (basePool * pairTvl) / totalTvl](contracts/IssuanceVault.sol#L733)

contracts/IssuanceVault.sol#L681-L792


 - [ ] ID-11
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L681-L792) performs a multiplication on the result of a division:
	- [basePool = (allocatableMZUSD * baseRewardBps) / BPS](contracts/IssuanceVault.sol#L687)
	- [baseShare = (basePool * trancheTvl) / totalTvl](contracts/IssuanceVault.sol#L773)

contracts/IssuanceVault.sol#L681-L792


 - [ ] ID-12
[MZUSD.requestWithdrawal(uint256)](contracts/MZUSD.sol#L135-L151) performs a multiplication on the result of a division:
	- [usdcOut = amountMZ / SCALE](contracts/MZUSD.sol#L136)
	- [burnAmount = usdcOut * SCALE](contracts/MZUSD.sol#L138)

contracts/MZUSD.sol#L135-L151


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-13
[IssuanceVault._rebalance()](contracts/IssuanceVault.sol#L807-L825) uses a dangerous strict equality:
	- [available == 0](contracts/IssuanceVault.sol#L820)

contracts/IssuanceVault.sol#L807-L825


 - [ ] ID-14
[IssuanceVault.setBuffer(uint256,uint16)](contracts/IssuanceVault.sol#L391-L411) uses a dangerous strict equality:
	- [available == 0](contracts/IssuanceVault.sol#L405)

contracts/IssuanceVault.sol#L391-L411


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-15
[IssuanceVault._rebalance().sent](contracts/IssuanceVault.sol#L811) is a local variable never initialized

contracts/IssuanceVault.sol#L811


 - [ ] ID-16
[IssuanceVault._allocateYieldToTranches(uint256).share1](contracts/IssuanceVault.sol#L739) is a local variable never initialized

contracts/IssuanceVault.sol#L739


 - [ ] ID-17
[IssuanceVault._allocateYieldToTranches(uint256).totalTvl](contracts/IssuanceVault.sol#L689) is a local variable never initialized

contracts/IssuanceVault.sol#L689


 - [ ] ID-18
[IssuanceVault._allocateYieldToTranches(uint256).lastNonZeroIndex](contracts/IssuanceVault.sol#L690) is a local variable never initialized

contracts/IssuanceVault.sol#L690


 - [ ] ID-19
[IssuanceVault._rebalance().pulled](contracts/IssuanceVault.sol#L812) is a local variable never initialized

contracts/IssuanceVault.sol#L812


 - [ ] ID-20
[IssuanceVault._allocateYieldToTranches(uint256).share0](contracts/IssuanceVault.sol#L738) is a local variable never initialized

contracts/IssuanceVault.sol#L738


 - [ ] ID-21
[IssuanceVault._allocateYieldToTranches(uint256).allocated](contracts/IssuanceVault.sol#L708) is a local variable never initialized

contracts/IssuanceVault.sol#L708


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-22
[LossManager.applyLoss(uint256)](contracts/LossManager.sol#L93-L117) ignores return value by [IVault(vault).advanceEpoch()](contracts/LossManager.sol#L107)

contracts/LossManager.sol#L93-L117


 - [ ] ID-23
[IssuanceVault._rebalance()](contracts/IssuanceVault.sol#L807-L825) ignores return value by [usdc.approve(address(reservoir),sent)](contracts/IssuanceVault.sol#L815)

contracts/IssuanceVault.sol#L807-L825


## missing-zero-check
Impact: Low
Confidence: Medium
 - [ ] ID-24
[NavOracleAutomation.constructor(address,uint256).vault_](contracts/automation/NavOracleAutomation.sol#L59) lacks a zero-check on :
		- [vault = vault_](contracts/automation/NavOracleAutomation.sol#L63)

contracts/automation/NavOracleAutomation.sol#L59


 - [ ] ID-25
[PolJuniorTranche.initialize(address).polPayoutAddress](contracts/PolJuniorTranche.sol#L46) lacks a zero-check on :
		- [polPayout = polPayoutAddress](contracts/PolJuniorTranche.sol#L55)

contracts/PolJuniorTranche.sol#L46


 - [ ] ID-26
[NavOracleAutomation.constructor(address,uint256).lossManager_](contracts/automation/NavOracleAutomation.sol#L55) lacks a zero-check on :
		- [lossManager = lossManager_](contracts/automation/NavOracleAutomation.sol#L64)

contracts/automation/NavOracleAutomation.sol#L55


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-27
Reentrancy in [LossManager.applyLoss(uint256)](contracts/LossManager.sol#L93-L117):
	External calls:
	- [IVault(vault).advanceEpoch()](contracts/LossManager.sol#L107)
	- [(burnedMZ,uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss))](contracts/LossManager.sol#L109)
		- [ITranche(t0).burnMZUSD(burn0)](contracts/LossManager.sol#L173)
		- [ITranche(t1).burnMZUSD(burn1)](contracts/LossManager.sol#L178)
		- [ITranche(t0).burnMZUSD(burnAmount)](contracts/LossManager.sol#L193)
	State variables written after the call(s):
	- [lastUncoveredLossMZ = uncoveredMZ](contracts/LossManager.sol#L111)
	- [totalUncoveredLossMZ += uncoveredMZ](contracts/LossManager.sol#L113)

contracts/LossManager.sol#L93-L117


 - [ ] ID-28
Reentrancy in [ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L52-L59):
	External calls:
	- [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L54)
	State variables written after the call(s):
	- [depositedBy[msg.sender] += amount](contracts/ReservoirUSDC.sol#L56)

contracts/ReservoirUSDC.sol#L52-L59


## reentrancy-events
Impact: Low
Confidence: Medium
 - [ ] ID-29
Reentrancy in [ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L52-L59):
	External calls:
	- [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L54)
	Event emitted after the call(s):
	- [Deposited(msg.sender,amount)](contracts/ReservoirUSDC.sol#L58)

contracts/ReservoirUSDC.sol#L52-L59


 - [ ] ID-30
Reentrancy in [IssuanceVault.withdraw(address,uint256)](contracts/IssuanceVault.sol#L191-L205):
	External calls:
	- [reservoir.withdraw(amount - idle,address(this))](contracts/IssuanceVault.sol#L200)
	- [usdc.transfer(to,amount)](contracts/IssuanceVault.sol#L203)
	Event emitted after the call(s):
	- [WithdrawnUSDCFromVault(to,amount)](contracts/IssuanceVault.sol#L204)

contracts/IssuanceVault.sol#L191-L205


 - [ ] ID-31
Reentrancy in [IssuanceVault._rebalance()](contracts/IssuanceVault.sol#L807-L825):
	External calls:
	- [usdc.approve(address(reservoir),sent)](contracts/IssuanceVault.sol#L815)
	- [reservoir.deposit(sent)](contracts/IssuanceVault.sol#L816)
	- [reservoir.withdraw(pulled,address(this))](contracts/IssuanceVault.sol#L822)
	Event emitted after the call(s):
	- [Rebalanced(sent,pulled,usdc.balanceOf(address(this)))](contracts/IssuanceVault.sol#L824)

contracts/IssuanceVault.sol#L807-L825


 - [ ] ID-32
Reentrancy in [Tranche.claim(uint256)](contracts/Tranche.sol#L234-L250):
	External calls:
	- [IERC20(asset()).transfer(msg.sender,userAssets)](contracts/Tranche.sol#L247)
	Event emitted after the call(s):
	- [WithdrawalClaimed(msg.sender,epochId,userAssets)](contracts/Tranche.sol#L249)

contracts/Tranche.sol#L234-L250


 - [ ] ID-33
Reentrancy in [MZUSD.requestWithdrawal(uint256)](contracts/MZUSD.sol#L135-L151):
	External calls:
	- [vault.withdraw(msg.sender,usdcOut)](contracts/MZUSD.sol#L148)
	Event emitted after the call(s):
	- [Withdrawal(msg.sender,usdcOut)](contracts/MZUSD.sol#L150)

contracts/MZUSD.sol#L135-L151


 - [ ] ID-34
Reentrancy in [NavOracleAutomation._applyPending()](contracts/automation/NavOracleAutomation.sol#L150-L164):
	External calls:
	- [IVault(vault).distributeYield(deltaUSDC)](contracts/automation/NavOracleAutomation.sol#L158)
	- [ILossManager(lossManager).applyLoss(deltaUSDC)](contracts/automation/NavOracleAutomation.sol#L160)
	Event emitted after the call(s):
	- [NavApplied(isYield,deltaUSDC,readyAt)](contracts/automation/NavOracleAutomation.sol#L163)

contracts/automation/NavOracleAutomation.sol#L150-L164


 - [ ] ID-35
Reentrancy in [PolJuniorTranche.notifyYield(uint256)](contracts/PolJuniorTranche.sol#L87-L93):
	External calls:
	- [mzusd.transfer(polPayout,yieldAmount)](contracts/PolJuniorTranche.sol#L91)
	Event emitted after the call(s):
	- [PolPayoutNotified(yieldAmount)](contracts/PolJuniorTranche.sol#L92)

contracts/PolJuniorTranche.sol#L87-L93


 - [ ] ID-36
Reentrancy in [LossManager.applyLoss(uint256)](contracts/LossManager.sol#L93-L117):
	External calls:
	- [IVault(vault).advanceEpoch()](contracts/LossManager.sol#L107)
	- [(burnedMZ,uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss))](contracts/LossManager.sol#L109)
		- [ITranche(t0).burnMZUSD(burn0)](contracts/LossManager.sol#L173)
		- [ITranche(t1).burnMZUSD(burn1)](contracts/LossManager.sol#L178)
		- [ITranche(t0).burnMZUSD(burnAmount)](contracts/LossManager.sol#L193)
	Event emitted after the call(s):
	- [LossApplied(usdcLoss,_toMZ(usdcLoss),burnedMZ,uncoveredMZ,totalUncoveredLossMZ)](contracts/LossManager.sol#L116)

contracts/LossManager.sol#L93-L117


## costly-loop
Impact: Informational
Confidence: Medium
 - [ ] ID-37
[IssuanceVault.setTrancheConfig(IssuanceVault.TrancheInfo[],bool[],uint16)](contracts/IssuanceVault.sol#L342-L386) has costly operations inside a loop:
	- [delete tranchePairedTo[tranches[i_scope_0].tranche]](contracts/IssuanceVault.sol#L366)

contracts/IssuanceVault.sol#L342-L386


## cyclomatic-complexity
Impact: Informational
Confidence: High
 - [ ] ID-38
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L681-L792) has a high cyclomatic complexity (15).

contracts/IssuanceVault.sol#L681-L792


 - [ ] ID-39
[IssuanceVault.setTrancheConfig(IssuanceVault.TrancheInfo[],bool[],uint16)](contracts/IssuanceVault.sol#L342-L386) has a high cyclomatic complexity (14).

contracts/IssuanceVault.sol#L342-L386


## redundant-statements
Impact: Informational
Confidence: High
 - [ ] ID-40
Redundant expression "[performData](contracts/automation/NavOracleAutomation.sol#L136)" in[NavOracleAutomation](contracts/automation/NavOracleAutomation.sol#L17-L190)

contracts/automation/NavOracleAutomation.sol#L136


 - [ ] ID-41
Redundant expression "[checkData](contracts/automation/NavOracleAutomation.sol#L126)" in[NavOracleAutomation](contracts/automation/NavOracleAutomation.sol#L17-L190)

contracts/automation/NavOracleAutomation.sol#L126


 - [ ] ID-42
Redundant expression "[performData](contracts/automation/UmbrellaEpochFinalizer.sol#L56)" in[UmbrellaEpochFinalizer](contracts/automation/UmbrellaEpochFinalizer.sol#L12-L67)

contracts/automation/UmbrellaEpochFinalizer.sol#L56


 - [ ] ID-43
Redundant expression "[checkData](contracts/automation/UmbrellaEpochFinalizer.sol#L44)" in[UmbrellaEpochFinalizer](contracts/automation/UmbrellaEpochFinalizer.sol#L12-L67)

contracts/automation/UmbrellaEpochFinalizer.sol#L44


## unused-import
Impact: Informational
Confidence: High
 - [ ] ID-44
The following unused import(s) in contracts/AccessManagerImport.sol should be removed:
	-import "@openzeppelin/contracts/access/manager/AccessManager.sol"; (contracts/AccessManagerImport.sol#4)

* * *

'forge clean' running (wd: /Users/anik/Developer/mezzanine)

'forge config --json' running

'forge build --build-info --skip */test/foundry/fuzz/** */script/foundry/** --force' running (wd: /Users/anik/Developer/mezzanine)

INFO:Detectors:

IssuanceVault.withdraw(address,uint256) (contracts/IssuanceVault.sol#191-205) ignores return value by usdc.transfer(to,amount) (contracts/IssuanceVault.sol#203)

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#681-792) ignores return value by mzusdToken.transfer(t.tranche,share0) (contracts/IssuanceVault.sol#750)

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#681-792) ignores return value by mzusdToken.transfer(pairedAddr,share1) (contracts/IssuanceVault.sol#754)

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#681-792) ignores return value by mzusdToken.transfer(t.tranche,totalShare) (contracts/IssuanceVault.sol#779)

MZUSD.deposit(uint256) (contracts/MZUSD.sol#110-123) ignores return value by usdc.transferFrom(msg.sender,address(vault),amountUSDC) (contracts/MZUSD.sol#117)

PolJuniorTranche.withdraw(uint256,address) (contracts/PolJuniorTranche.sol#75-83) ignores return value by mzusd.transfer(receiver,assets) (contracts/PolJuniorTranche.sol#81)

PolJuniorTranche.notifyYield(uint256) (contracts/PolJuniorTranche.sol#87-93) ignores return value by mzusd.transfer(polPayout,yieldAmount) (contracts/PolJuniorTranche.sol#91)

ReservoirUSDC.deposit(uint256) (contracts/ReservoirUSDC.sol#52-59) ignores return value by usdc.transferFrom(msg.sender,address(this),amount) (contracts/ReservoirUSDC.sol#54)

ReservoirUSDC.withdraw(uint256,address) (contracts/ReservoirUSDC.sol#62-75) ignores return value by usdc.transfer(to,amount) (contracts/ReservoirUSDC.sol#70)

Tranche.claim(uint256) (contracts/Tranche.sol#234-250) ignores return value by IERC20(asset()).transfer(msg.sender,userAssets) (contracts/Tranche.sol#247)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#unchecked-transfer

INFO:Detectors:

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#681-792) performs a multiplication on the result of a division:

	- basePool = (allocatableMZUSD * baseRewardBps) / BPS (contracts/IssuanceVault.sol#687)

	- baseShare = (basePool * trancheTvl) / totalTvl (contracts/IssuanceVault.sol#773)

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#681-792) performs a multiplication on the result of a division:

	- basePool = (allocatableMZUSD * baseRewardBps) / BPS (contracts/IssuanceVault.sol#687)

	- pairBaseShare = (basePool * pairTvl) / totalTvl (contracts/IssuanceVault.sol#733)

MZUSD.requestWithdrawal(uint256) (contracts/MZUSD.sol#135-151) performs a multiplication on the result of a division:

	- usdcOut = amountMZ / SCALE (contracts/MZUSD.sol#136)

	- burnAmount = usdcOut * SCALE (contracts/MZUSD.sol#138)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#divide-before-multiply

INFO:Detectors:

IssuanceVault._rebalance() (contracts/IssuanceVault.sol#807-825) uses a dangerous strict equality:

	- available == 0 (contracts/IssuanceVault.sol#820)

IssuanceVault.setBuffer(uint256,uint16) (contracts/IssuanceVault.sol#391-411) uses a dangerous strict equality:

	- available == 0 (contracts/IssuanceVault.sol#405)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#dangerous-strict-equalities

INFO:Detectors:

IssuanceVault._allocateYieldToTranches(uint256).lastNonZeroIndex (contracts/IssuanceVault.sol#690) is a local variable never initialized

IssuanceVault._allocateYieldToTranches(uint256).share0 (contracts/IssuanceVault.sol#738) is a local variable never initialized

IssuanceVault._allocateYieldToTranches(uint256).allocated (contracts/IssuanceVault.sol#708) is a local variable never initialized

IssuanceVault._rebalance().sent (contracts/IssuanceVault.sol#811) is a local variable never initialized

IssuanceVault._allocateYieldToTranches(uint256).share1 (contracts/IssuanceVault.sol#739) is a local variable never initialized

IssuanceVault._allocateYieldToTranches(uint256).totalTvl (contracts/IssuanceVault.sol#689) is a local variable never initialized

IssuanceVault._rebalance().pulled (contracts/IssuanceVault.sol#812) is a local variable never initialized

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#uninitialized-local-variables

INFO:Detectors:

IssuanceVault._rebalance() (contracts/IssuanceVault.sol#807-825) ignores return value by usdc.approve(address(reservoir),sent) (contracts/IssuanceVault.sol#815)

LossManager.applyLoss(uint256) (contracts/LossManager.sol#93-117) ignores return value by IVault(vault).advanceEpoch() (contracts/LossManager.sol#107)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#unused-return

INFO:Detectors:

PolJuniorTranche.initialize(address).polPayoutAddress (contracts/PolJuniorTranche.sol#46) lacks a zero-check on :

		- polPayout = polPayoutAddress (contracts/PolJuniorTranche.sol#55)

NavOracleAutomation.constructor(address,uint256).vault_ (contracts/automation/NavOracleAutomation.sol#59) lacks a zero-check on :

		- vault = vault_ (contracts/automation/NavOracleAutomation.sol#63)

NavOracleAutomation.constructor(address,uint256).lossManager_ (contracts/automation/NavOracleAutomation.sol#55) lacks a zero-check on :

		- lossManager = lossManager_ (contracts/automation/NavOracleAutomation.sol#64)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#missing-zero-address-validation

INFO:Detectors:

Reentrancy in LossManager.applyLoss(uint256) (contracts/LossManager.sol#93-117):

	External calls:

	- IVault(vault).advanceEpoch() (contracts/LossManager.sol#107)

	- (burnedMZ,uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss)) (contracts/LossManager.sol#109)

		- ITranche(t0).burnMZUSD(burn0) (contracts/LossManager.sol#173)

		- ITranche(t1).burnMZUSD(burn1) (contracts/LossManager.sol#178)

		- ITranche(t0).burnMZUSD(burnAmount) (contracts/LossManager.sol#193)

	State variables written after the call(s):

	- lastUncoveredLossMZ = uncoveredMZ (contracts/LossManager.sol#111)

	- totalUncoveredLossMZ += uncoveredMZ (contracts/LossManager.sol#113)

Reentrancy in ReservoirUSDC.deposit(uint256) (contracts/ReservoirUSDC.sol#52-59):

	External calls:

	- usdc.transferFrom(msg.sender,address(this),amount) (contracts/ReservoirUSDC.sol#54)

	State variables written after the call(s):

	- depositedBy[msg.sender] += amount (contracts/ReservoirUSDC.sol#56)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-2

INFO:Detectors:

Reentrancy in NavOracleAutomation._applyPending() (contracts/automation/NavOracleAutomation.sol#150-164):

	External calls:

	- IVault(vault).distributeYield(deltaUSDC) (contracts/automation/NavOracleAutomation.sol#158)

	- ILossManager(lossManager).applyLoss(deltaUSDC) (contracts/automation/NavOracleAutomation.sol#160)

	Event emitted after the call(s):

	- NavApplied(isYield,deltaUSDC,readyAt) (contracts/automation/NavOracleAutomation.sol#163)

Reentrancy in IssuanceVault._rebalance() (contracts/IssuanceVault.sol#807-825):

	External calls:

	- usdc.approve(address(reservoir),sent) (contracts/IssuanceVault.sol#815)

	- reservoir.deposit(sent) (contracts/IssuanceVault.sol#816)

	- reservoir.withdraw(pulled,address(this)) (contracts/IssuanceVault.sol#822)

	Event emitted after the call(s):

	- Rebalanced(sent,pulled,usdc.balanceOf(address(this))) (contracts/IssuanceVault.sol#824)

Reentrancy in LossManager.applyLoss(uint256) (contracts/LossManager.sol#93-117):

	External calls:

	- IVault(vault).advanceEpoch() (contracts/LossManager.sol#107)

	- (burnedMZ,uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss)) (contracts/LossManager.sol#109)

		- ITranche(t0).burnMZUSD(burn0) (contracts/LossManager.sol#173)

		- ITranche(t1).burnMZUSD(burn1) (contracts/LossManager.sol#178)

		- ITranche(t0).burnMZUSD(burnAmount) (contracts/LossManager.sol#193)

	Event emitted after the call(s):

	- LossApplied(usdcLoss,_toMZ(usdcLoss),burnedMZ,uncoveredMZ,totalUncoveredLossMZ) (contracts/LossManager.sol#116)

Reentrancy in Tranche.claim(uint256) (contracts/Tranche.sol#234-250):

	External calls:

	- IERC20(asset()).transfer(msg.sender,userAssets) (contracts/Tranche.sol#247)

	Event emitted after the call(s):

	- WithdrawalClaimed(msg.sender,epochId,userAssets) (contracts/Tranche.sol#249)

Reentrancy in ReservoirUSDC.deposit(uint256) (contracts/ReservoirUSDC.sol#52-59):

	External calls:

	- usdc.transferFrom(msg.sender,address(this),amount) (contracts/ReservoirUSDC.sol#54)

	Event emitted after the call(s):

	- Deposited(msg.sender,amount) (contracts/ReservoirUSDC.sol#58)

Reentrancy in PolJuniorTranche.notifyYield(uint256) (contracts/PolJuniorTranche.sol#87-93):

	External calls:

	- mzusd.transfer(polPayout,yieldAmount) (contracts/PolJuniorTranche.sol#91)

	Event emitted after the call(s):

	- PolPayoutNotified(yieldAmount) (contracts/PolJuniorTranche.sol#92)

Reentrancy in MZUSD.requestWithdrawal(uint256) (contracts/MZUSD.sol#135-151):

	External calls:

	- vault.withdraw(msg.sender,usdcOut) (contracts/MZUSD.sol#148)

	Event emitted after the call(s):

	- Withdrawal(msg.sender,usdcOut) (contracts/MZUSD.sol#150)

Reentrancy in IssuanceVault.withdraw(address,uint256) (contracts/IssuanceVault.sol#191-205):

	External calls:

	- reservoir.withdraw(amount - idle,address(this)) (contracts/IssuanceVault.sol#200)

	- usdc.transfer(to,amount) (contracts/IssuanceVault.sol#203)

	Event emitted after the call(s):

	- WithdrawnUSDCFromVault(to,amount) (contracts/IssuanceVault.sol#204)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-3

INFO:Detectors:

IssuanceVault.setTrancheConfig(IssuanceVault.TrancheInfo[],bool[],uint16) (contracts/IssuanceVault.sol#342-386) has costly operations inside a loop:

	- delete tranchePairedTo[tranches[i_scope_0].tranche] (contracts/IssuanceVault.sol#366)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#costly-operations-inside-a-loop

INFO:Detectors:

IssuanceVault.setTrancheConfig(IssuanceVault.TrancheInfo[],bool[],uint16) (contracts/IssuanceVault.sol#342-386) has a high cyclomatic complexity (14).

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#681-792) has a high cyclomatic complexity (15).

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#cyclomatic-complexity

INFO:Detectors:

Redundant expression "checkData (contracts/automation/NavOracleAutomation.sol#126)" inNavOracleAutomation (contracts/automation/NavOracleAutomation.sol#17-190)

Redundant expression "performData (contracts/automation/NavOracleAutomation.sol#136)" inNavOracleAutomation (contracts/automation/NavOracleAutomation.sol#17-190)

Redundant expression "checkData (contracts/automation/UmbrellaEpochFinalizer.sol#44)" inUmbrellaEpochFinalizer (contracts/automation/UmbrellaEpochFinalizer.sol#12-67)

Redundant expression "performData (contracts/automation/UmbrellaEpochFinalizer.sol#56)" inUmbrellaEpochFinalizer (contracts/automation/UmbrellaEpochFinalizer.sol#12-67)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#redundant-statements

INFO:Detectors:

The following unused import(s) in contracts/AccessManagerImport.sol should be removed:

	-import "@openzeppelin/contracts/access/manager/AccessManager.sol"; (contracts/AccessManagerImport.sol#4)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#unused-imports

INFO:Slither:. analyzed (65 contracts with 91 detectors), 45 result(s) found

