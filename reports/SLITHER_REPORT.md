**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [unchecked-transfer](#unchecked-transfer) (10 results) (High)
 - [divide-before-multiply](#divide-before-multiply) (4 results) (Medium)
 - [incorrect-equality](#incorrect-equality) (2 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (7 results) (Medium)
 - [unused-return](#unused-return) (4 results) (Medium)
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
[MZUSD.deposit(uint256)](contracts/MZUSD.sol#L118-L131) ignores return value by [usdc.transferFrom(msg.sender,address(vault),amountUSDC)](contracts/MZUSD.sol#L125)

contracts/MZUSD.sol#L118-L131


 - [ ] ID-1
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L686-L797) ignores return value by [mzusdToken.transfer(t.tranche,share0)](contracts/IssuanceVault.sol#L755)

contracts/IssuanceVault.sol#L686-L797


 - [ ] ID-2
[ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L52-L59) ignores return value by [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L54)

contracts/ReservoirUSDC.sol#L52-L59


 - [ ] ID-3
[Tranche.claim(address,uint256)](contracts/Tranche.sol#L220-L256) ignores return value by [IERC20(asset()).transfer(user,userAssets)](contracts/Tranche.sol#L253)

contracts/Tranche.sol#L220-L256


 - [ ] ID-4
[PolJuniorTranche.notifyYield(uint256)](contracts/PolJuniorTranche.sol#L87-L93) ignores return value by [mzusd.transfer(polPayout,yieldAmount)](contracts/PolJuniorTranche.sol#L91)

contracts/PolJuniorTranche.sol#L87-L93


 - [ ] ID-5
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L686-L797) ignores return value by [mzusdToken.transfer(t.tranche,totalShare)](contracts/IssuanceVault.sol#L784)

contracts/IssuanceVault.sol#L686-L797


 - [ ] ID-6
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L686-L797) ignores return value by [mzusdToken.transfer(pairedAddr,share1)](contracts/IssuanceVault.sol#L759)

contracts/IssuanceVault.sol#L686-L797


 - [ ] ID-7
[ReservoirUSDC.withdraw(uint256,address)](contracts/ReservoirUSDC.sol#L62-L75) ignores return value by [usdc.transfer(to,amount)](contracts/ReservoirUSDC.sol#L70)

contracts/ReservoirUSDC.sol#L62-L75


 - [ ] ID-8
[PolJuniorTranche.withdraw(uint256,address)](contracts/PolJuniorTranche.sol#L75-L83) ignores return value by [mzusd.transfer(receiver,assets)](contracts/PolJuniorTranche.sol#L81)

contracts/PolJuniorTranche.sol#L75-L83


 - [ ] ID-9
[IssuanceVault.withdraw(address,uint256)](contracts/IssuanceVault.sol#L193-L207) ignores return value by [usdc.transfer(to,amount)](contracts/IssuanceVault.sol#L205)

contracts/IssuanceVault.sol#L193-L207


## divide-before-multiply
Impact: Medium
Confidence: Medium
 - [ ] ID-10
[MZUSD.requestWithdrawal(uint256)](contracts/MZUSD.sol#L143-L166) performs a multiplication on the result of a division:
	- [usdcOutGross = amountMZ / SCALE](contracts/MZUSD.sol#L144)
	- [burnAmount = usdcOutGross * SCALE](contracts/MZUSD.sol#L146)

contracts/MZUSD.sol#L143-L166


 - [ ] ID-11
[MZUSD.requestWithdrawal(uint256)](contracts/MZUSD.sol#L143-L166) performs a multiplication on the result of a division:
	- [usdcOutGross = amountMZ / SCALE](contracts/MZUSD.sol#L144)
	- [feeUSDC = (usdcOutGross * withdrawalFeeBps) / BPS](contracts/MZUSD.sol#L158)

contracts/MZUSD.sol#L143-L166


 - [ ] ID-12
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L686-L797) performs a multiplication on the result of a division:
	- [basePool = (allocatableMZUSD * baseRewardBps) / BPS](contracts/IssuanceVault.sol#L692)
	- [baseShare = (basePool * trancheTvl) / totalTvl](contracts/IssuanceVault.sol#L778)

contracts/IssuanceVault.sol#L686-L797


 - [ ] ID-13
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L686-L797) performs a multiplication on the result of a division:
	- [basePool = (allocatableMZUSD * baseRewardBps) / BPS](contracts/IssuanceVault.sol#L692)
	- [pairBaseShare = (basePool * pairTvl) / totalTvl](contracts/IssuanceVault.sol#L738)

contracts/IssuanceVault.sol#L686-L797


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-14
[IssuanceVault.setBuffer(uint256,uint16)](contracts/IssuanceVault.sol#L396-L416) uses a dangerous strict equality:
	- [available == 0](contracts/IssuanceVault.sol#L410)

contracts/IssuanceVault.sol#L396-L416


 - [ ] ID-15
[IssuanceVault._rebalance()](contracts/IssuanceVault.sol#L812-L830) uses a dangerous strict equality:
	- [available == 0](contracts/IssuanceVault.sol#L825)

contracts/IssuanceVault.sol#L812-L830


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-16
[IssuanceVault._rebalance().sent](contracts/IssuanceVault.sol#L816) is a local variable never initialized

contracts/IssuanceVault.sol#L816


 - [ ] ID-17
[IssuanceVault._allocateYieldToTranches(uint256).share1](contracts/IssuanceVault.sol#L744) is a local variable never initialized

contracts/IssuanceVault.sol#L744


 - [ ] ID-18
[IssuanceVault._allocateYieldToTranches(uint256).totalTvl](contracts/IssuanceVault.sol#L694) is a local variable never initialized

contracts/IssuanceVault.sol#L694


 - [ ] ID-19
[IssuanceVault._allocateYieldToTranches(uint256).lastNonZeroIndex](contracts/IssuanceVault.sol#L695) is a local variable never initialized

contracts/IssuanceVault.sol#L695


 - [ ] ID-20
[IssuanceVault._rebalance().pulled](contracts/IssuanceVault.sol#L817) is a local variable never initialized

contracts/IssuanceVault.sol#L817


 - [ ] ID-21
[IssuanceVault._allocateYieldToTranches(uint256).share0](contracts/IssuanceVault.sol#L743) is a local variable never initialized

contracts/IssuanceVault.sol#L743


 - [ ] ID-22
[IssuanceVault._allocateYieldToTranches(uint256).allocated](contracts/IssuanceVault.sol#L713) is a local variable never initialized

contracts/IssuanceVault.sol#L713


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-23
[LossManager.applyLoss(uint256)](contracts/LossManager.sol#L93-L117) ignores return value by [IVault(vault).advanceEpoch()](contracts/LossManager.sol#L107)

contracts/LossManager.sol#L93-L117


 - [ ] ID-24
[IssuanceVault._rebalance()](contracts/IssuanceVault.sol#L812-L830) ignores return value by [usdc.approve(address(reservoir),sent)](contracts/IssuanceVault.sol#L820)

contracts/IssuanceVault.sol#L812-L830


 - [ ] ID-25
[NavOracleAutomation._readFreshAnswer(AggregatorV3Interface,AggregatorV3Interface)](contracts/automation/NavOracleAutomation.sol#L229-L255) ignores return value by [(None,supplyAnswer,None,supplyUpdatedAt,None) = totalSupplyOracle_.latestRoundData()](contracts/automation/NavOracleAutomation.sol#L246)

contracts/automation/NavOracleAutomation.sol#L229-L255


 - [ ] ID-26
[NavOracleAutomation._readFreshAnswer(AggregatorV3Interface,AggregatorV3Interface)](contracts/automation/NavOracleAutomation.sol#L229-L255) ignores return value by [(None,navAnswer,None,navUpdatedAt,None) = navOracle_.latestRoundData()](contracts/automation/NavOracleAutomation.sol#L236)

contracts/automation/NavOracleAutomation.sol#L229-L255


## missing-zero-check
Impact: Low
Confidence: Medium
 - [ ] ID-27
[PolJuniorTranche.initialize(address).polPayoutAddress](contracts/PolJuniorTranche.sol#L46) lacks a zero-check on :
		- [polPayout = polPayoutAddress](contracts/PolJuniorTranche.sol#L55)

contracts/PolJuniorTranche.sol#L46


 - [ ] ID-28
[NavOracleAutomation.constructor(address,uint256).lossManager_](contracts/automation/NavOracleAutomation.sol#L71) lacks a zero-check on :
		- [lossManager = lossManager_](contracts/automation/NavOracleAutomation.sol#L80)

contracts/automation/NavOracleAutomation.sol#L71


 - [ ] ID-29
[NavOracleAutomation.constructor(address,uint256).vault_](contracts/automation/NavOracleAutomation.sol#L75) lacks a zero-check on :
		- [vault = vault_](contracts/automation/NavOracleAutomation.sol#L79)

contracts/automation/NavOracleAutomation.sol#L75


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-30
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


 - [ ] ID-31
Reentrancy in [ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L52-L59):
	External calls:
	- [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L54)
	State variables written after the call(s):
	- [depositedBy[msg.sender] += amount](contracts/ReservoirUSDC.sol#L56)

contracts/ReservoirUSDC.sol#L52-L59


## reentrancy-events
Impact: Low
Confidence: Medium
 - [ ] ID-32
Reentrancy in [ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L52-L59):
	External calls:
	- [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L54)
	Event emitted after the call(s):
	- [Deposited(msg.sender,amount)](contracts/ReservoirUSDC.sol#L58)

contracts/ReservoirUSDC.sol#L52-L59


 - [ ] ID-33
Reentrancy in [MZUSD.requestWithdrawal(uint256)](contracts/MZUSD.sol#L143-L166):
	External calls:
	- [vault.withdraw(msg.sender,usdcOutNet)](contracts/MZUSD.sol#L162)
	Event emitted after the call(s):
	- [Withdrawal(msg.sender,usdcOutNet)](contracts/MZUSD.sol#L165)

contracts/MZUSD.sol#L143-L166


 - [ ] ID-34
Reentrancy in [NavOracleAutomation._applyPending()](contracts/automation/NavOracleAutomation.sol#L183-L197):
	External calls:
	- [IVault(vault).distributeYield(deltaUSDC)](contracts/automation/NavOracleAutomation.sol#L191)
	- [ILossManager(lossManager).applyLoss(deltaUSDC)](contracts/automation/NavOracleAutomation.sol#L193)
	Event emitted after the call(s):
	- [NavApplied(isYield,deltaUSDC,readyAt)](contracts/automation/NavOracleAutomation.sol#L196)

contracts/automation/NavOracleAutomation.sol#L183-L197


 - [ ] ID-35
Reentrancy in [Tranche.claim(address,uint256)](contracts/Tranche.sol#L220-L256):
	External calls:
	- [IERC20(asset()).transfer(user,userAssets)](contracts/Tranche.sol#L253)
	Event emitted after the call(s):
	- [WithdrawalClaimed(user,epochId,userAssets)](contracts/Tranche.sol#L255)

contracts/Tranche.sol#L220-L256


 - [ ] ID-36
Reentrancy in [IssuanceVault._rebalance()](contracts/IssuanceVault.sol#L812-L830):
	External calls:
	- [usdc.approve(address(reservoir),sent)](contracts/IssuanceVault.sol#L820)
	- [reservoir.deposit(sent)](contracts/IssuanceVault.sol#L821)
	- [reservoir.withdraw(pulled,address(this))](contracts/IssuanceVault.sol#L827)
	Event emitted after the call(s):
	- [Rebalanced(sent,pulled,usdc.balanceOf(address(this)))](contracts/IssuanceVault.sol#L829)

contracts/IssuanceVault.sol#L812-L830


 - [ ] ID-37
Reentrancy in [IssuanceVault.withdraw(address,uint256)](contracts/IssuanceVault.sol#L193-L207):
	External calls:
	- [reservoir.withdraw(amount - idle,address(this))](contracts/IssuanceVault.sol#L202)
	- [usdc.transfer(to,amount)](contracts/IssuanceVault.sol#L205)
	Event emitted after the call(s):
	- [WithdrawnUSDCFromVault(to,amount)](contracts/IssuanceVault.sol#L206)

contracts/IssuanceVault.sol#L193-L207


 - [ ] ID-38
Reentrancy in [PolJuniorTranche.notifyYield(uint256)](contracts/PolJuniorTranche.sol#L87-L93):
	External calls:
	- [mzusd.transfer(polPayout,yieldAmount)](contracts/PolJuniorTranche.sol#L91)
	Event emitted after the call(s):
	- [PolPayoutNotified(yieldAmount)](contracts/PolJuniorTranche.sol#L92)

contracts/PolJuniorTranche.sol#L87-L93


 - [ ] ID-39
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
 - [ ] ID-40
[IssuanceVault.setTrancheConfig(IssuanceVault.TrancheInfo[],bool[],uint16)](contracts/IssuanceVault.sol#L347-L391) has costly operations inside a loop:
	- [delete tranchePairedTo[tranches[i_scope_0].tranche]](contracts/IssuanceVault.sol#L371)

contracts/IssuanceVault.sol#L347-L391


## cyclomatic-complexity
Impact: Informational
Confidence: High
 - [ ] ID-41
[IssuanceVault._allocateYieldToTranches(uint256)](contracts/IssuanceVault.sol#L686-L797) has a high cyclomatic complexity (15).

contracts/IssuanceVault.sol#L686-L797


 - [ ] ID-42
[IssuanceVault.setTrancheConfig(IssuanceVault.TrancheInfo[],bool[],uint16)](contracts/IssuanceVault.sol#L347-L391) has a high cyclomatic complexity (14).

contracts/IssuanceVault.sol#L347-L391


## redundant-statements
Impact: Informational
Confidence: High
 - [ ] ID-43
Redundant expression "[performData](contracts/automation/UmbrellaEpochFinalizer.sol#L56)" in[UmbrellaEpochFinalizer](contracts/automation/UmbrellaEpochFinalizer.sol#L12-L67)

contracts/automation/UmbrellaEpochFinalizer.sol#L56


 - [ ] ID-44
Redundant expression "[checkData](contracts/automation/UmbrellaEpochFinalizer.sol#L44)" in[UmbrellaEpochFinalizer](contracts/automation/UmbrellaEpochFinalizer.sol#L12-L67)

contracts/automation/UmbrellaEpochFinalizer.sol#L44


 - [ ] ID-45
Redundant expression "[performData](contracts/automation/NavOracleAutomation.sol#L169)" in[NavOracleAutomation](contracts/automation/NavOracleAutomation.sol#L18-L256)

contracts/automation/NavOracleAutomation.sol#L169


 - [ ] ID-46
Redundant expression "[checkData](contracts/automation/NavOracleAutomation.sol#L159)" in[NavOracleAutomation](contracts/automation/NavOracleAutomation.sol#L18-L256)

contracts/automation/NavOracleAutomation.sol#L159


## unused-import
Impact: Informational
Confidence: High
 - [ ] ID-47
The following unused import(s) in contracts/AccessManagerImport.sol should be removed:
	-import "@openzeppelin/contracts/access/manager/AccessManager.sol"; (contracts/AccessManagerImport.sol#4)

* * *

'forge clean' running (wd: /Users/anik/Developer/mezzanine)

'forge config --json' running

'forge build --build-info --skip */test/foundry/fuzz/** */script/foundry/** --force' running (wd: /Users/anik/Developer/mezzanine)

INFO:Detectors:

IssuanceVault.withdraw(address,uint256) (contracts/IssuanceVault.sol#193-207) ignores return value by usdc.transfer(to,amount) (contracts/IssuanceVault.sol#205)

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#686-797) ignores return value by mzusdToken.transfer(t.tranche,share0) (contracts/IssuanceVault.sol#755)

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#686-797) ignores return value by mzusdToken.transfer(pairedAddr,share1) (contracts/IssuanceVault.sol#759)

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#686-797) ignores return value by mzusdToken.transfer(t.tranche,totalShare) (contracts/IssuanceVault.sol#784)

MZUSD.deposit(uint256) (contracts/MZUSD.sol#118-131) ignores return value by usdc.transferFrom(msg.sender,address(vault),amountUSDC) (contracts/MZUSD.sol#125)

PolJuniorTranche.withdraw(uint256,address) (contracts/PolJuniorTranche.sol#75-83) ignores return value by mzusd.transfer(receiver,assets) (contracts/PolJuniorTranche.sol#81)

PolJuniorTranche.notifyYield(uint256) (contracts/PolJuniorTranche.sol#87-93) ignores return value by mzusd.transfer(polPayout,yieldAmount) (contracts/PolJuniorTranche.sol#91)

ReservoirUSDC.deposit(uint256) (contracts/ReservoirUSDC.sol#52-59) ignores return value by usdc.transferFrom(msg.sender,address(this),amount) (contracts/ReservoirUSDC.sol#54)

ReservoirUSDC.withdraw(uint256,address) (contracts/ReservoirUSDC.sol#62-75) ignores return value by usdc.transfer(to,amount) (contracts/ReservoirUSDC.sol#70)

Tranche.claim(address,uint256) (contracts/Tranche.sol#220-256) ignores return value by IERC20(asset()).transfer(user,userAssets) (contracts/Tranche.sol#253)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#unchecked-transfer

INFO:Detectors:

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#686-797) performs a multiplication on the result of a division:

	- basePool = (allocatableMZUSD * baseRewardBps) / BPS (contracts/IssuanceVault.sol#692)

	- baseShare = (basePool * trancheTvl) / totalTvl (contracts/IssuanceVault.sol#778)

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#686-797) performs a multiplication on the result of a division:

	- basePool = (allocatableMZUSD * baseRewardBps) / BPS (contracts/IssuanceVault.sol#692)

	- pairBaseShare = (basePool * pairTvl) / totalTvl (contracts/IssuanceVault.sol#738)

MZUSD.requestWithdrawal(uint256) (contracts/MZUSD.sol#143-166) performs a multiplication on the result of a division:

	- usdcOutGross = amountMZ / SCALE (contracts/MZUSD.sol#144)

	- burnAmount = usdcOutGross * SCALE (contracts/MZUSD.sol#146)

MZUSD.requestWithdrawal(uint256) (contracts/MZUSD.sol#143-166) performs a multiplication on the result of a division:

	- usdcOutGross = amountMZ / SCALE (contracts/MZUSD.sol#144)

	- feeUSDC = (usdcOutGross * withdrawalFeeBps) / BPS (contracts/MZUSD.sol#158)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#divide-before-multiply

INFO:Detectors:

IssuanceVault._rebalance() (contracts/IssuanceVault.sol#812-830) uses a dangerous strict equality:

	- available == 0 (contracts/IssuanceVault.sol#825)

IssuanceVault.setBuffer(uint256,uint16) (contracts/IssuanceVault.sol#396-416) uses a dangerous strict equality:

	- available == 0 (contracts/IssuanceVault.sol#410)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#dangerous-strict-equalities

INFO:Detectors:

IssuanceVault._allocateYieldToTranches(uint256).totalTvl (contracts/IssuanceVault.sol#694) is a local variable never initialized

IssuanceVault._allocateYieldToTranches(uint256).share0 (contracts/IssuanceVault.sol#743) is a local variable never initialized

IssuanceVault._rebalance().sent (contracts/IssuanceVault.sol#816) is a local variable never initialized

IssuanceVault._allocateYieldToTranches(uint256).allocated (contracts/IssuanceVault.sol#713) is a local variable never initialized

IssuanceVault._allocateYieldToTranches(uint256).lastNonZeroIndex (contracts/IssuanceVault.sol#695) is a local variable never initialized

IssuanceVault._rebalance().pulled (contracts/IssuanceVault.sol#817) is a local variable never initialized

IssuanceVault._allocateYieldToTranches(uint256).share1 (contracts/IssuanceVault.sol#744) is a local variable never initialized

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#uninitialized-local-variables

INFO:Detectors:

IssuanceVault._rebalance() (contracts/IssuanceVault.sol#812-830) ignores return value by usdc.approve(address(reservoir),sent) (contracts/IssuanceVault.sol#820)

LossManager.applyLoss(uint256) (contracts/LossManager.sol#93-117) ignores return value by IVault(vault).advanceEpoch() (contracts/LossManager.sol#107)

NavOracleAutomation._readFreshAnswer(AggregatorV3Interface,AggregatorV3Interface) (contracts/automation/NavOracleAutomation.sol#229-255) ignores return value by (None,navAnswer,None,navUpdatedAt,None) = navOracle_.latestRoundData() (contracts/automation/NavOracleAutomation.sol#236)

NavOracleAutomation._readFreshAnswer(AggregatorV3Interface,AggregatorV3Interface) (contracts/automation/NavOracleAutomation.sol#229-255) ignores return value by (None,supplyAnswer,None,supplyUpdatedAt,None) = totalSupplyOracle_.latestRoundData() (contracts/automation/NavOracleAutomation.sol#246)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#unused-return

INFO:Detectors:

PolJuniorTranche.initialize(address).polPayoutAddress (contracts/PolJuniorTranche.sol#46) lacks a zero-check on :

		- polPayout = polPayoutAddress (contracts/PolJuniorTranche.sol#55)

NavOracleAutomation.constructor(address,uint256).vault_ (contracts/automation/NavOracleAutomation.sol#75) lacks a zero-check on :

		- vault = vault_ (contracts/automation/NavOracleAutomation.sol#79)

NavOracleAutomation.constructor(address,uint256).lossManager_ (contracts/automation/NavOracleAutomation.sol#71) lacks a zero-check on :

		- lossManager = lossManager_ (contracts/automation/NavOracleAutomation.sol#80)

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

Reentrancy in NavOracleAutomation._applyPending() (contracts/automation/NavOracleAutomation.sol#183-197):

	External calls:

	- IVault(vault).distributeYield(deltaUSDC) (contracts/automation/NavOracleAutomation.sol#191)

	- ILossManager(lossManager).applyLoss(deltaUSDC) (contracts/automation/NavOracleAutomation.sol#193)

	Event emitted after the call(s):

	- NavApplied(isYield,deltaUSDC,readyAt) (contracts/automation/NavOracleAutomation.sol#196)

Reentrancy in IssuanceVault._rebalance() (contracts/IssuanceVault.sol#812-830):

	External calls:

	- usdc.approve(address(reservoir),sent) (contracts/IssuanceVault.sol#820)

	- reservoir.deposit(sent) (contracts/IssuanceVault.sol#821)

	- reservoir.withdraw(pulled,address(this)) (contracts/IssuanceVault.sol#827)

	Event emitted after the call(s):

	- Rebalanced(sent,pulled,usdc.balanceOf(address(this))) (contracts/IssuanceVault.sol#829)

Reentrancy in LossManager.applyLoss(uint256) (contracts/LossManager.sol#93-117):

	External calls:

	- IVault(vault).advanceEpoch() (contracts/LossManager.sol#107)

	- (burnedMZ,uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss)) (contracts/LossManager.sol#109)

		- ITranche(t0).burnMZUSD(burn0) (contracts/LossManager.sol#173)

		- ITranche(t1).burnMZUSD(burn1) (contracts/LossManager.sol#178)

		- ITranche(t0).burnMZUSD(burnAmount) (contracts/LossManager.sol#193)

	Event emitted after the call(s):

	- LossApplied(usdcLoss,_toMZ(usdcLoss),burnedMZ,uncoveredMZ,totalUncoveredLossMZ) (contracts/LossManager.sol#116)

Reentrancy in Tranche.claim(address,uint256) (contracts/Tranche.sol#220-256):

	External calls:

	- IERC20(asset()).transfer(user,userAssets) (contracts/Tranche.sol#253)

	Event emitted after the call(s):

	- WithdrawalClaimed(user,epochId,userAssets) (contracts/Tranche.sol#255)

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

Reentrancy in MZUSD.requestWithdrawal(uint256) (contracts/MZUSD.sol#143-166):

	External calls:

	- vault.withdraw(msg.sender,usdcOutNet) (contracts/MZUSD.sol#162)

	Event emitted after the call(s):

	- Withdrawal(msg.sender,usdcOutNet) (contracts/MZUSD.sol#165)

Reentrancy in IssuanceVault.withdraw(address,uint256) (contracts/IssuanceVault.sol#193-207):

	External calls:

	- reservoir.withdraw(amount - idle,address(this)) (contracts/IssuanceVault.sol#202)

	- usdc.transfer(to,amount) (contracts/IssuanceVault.sol#205)

	Event emitted after the call(s):

	- WithdrawnUSDCFromVault(to,amount) (contracts/IssuanceVault.sol#206)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-3

INFO:Detectors:

IssuanceVault.setTrancheConfig(IssuanceVault.TrancheInfo[],bool[],uint16) (contracts/IssuanceVault.sol#347-391) has costly operations inside a loop:

	- delete tranchePairedTo[tranches[i_scope_0].tranche] (contracts/IssuanceVault.sol#371)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#costly-operations-inside-a-loop

INFO:Detectors:

IssuanceVault.setTrancheConfig(IssuanceVault.TrancheInfo[],bool[],uint16) (contracts/IssuanceVault.sol#347-391) has a high cyclomatic complexity (14).

IssuanceVault._allocateYieldToTranches(uint256) (contracts/IssuanceVault.sol#686-797) has a high cyclomatic complexity (15).

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#cyclomatic-complexity

INFO:Detectors:

Redundant expression "checkData (contracts/automation/NavOracleAutomation.sol#159)" inNavOracleAutomation (contracts/automation/NavOracleAutomation.sol#18-256)

Redundant expression "performData (contracts/automation/NavOracleAutomation.sol#169)" inNavOracleAutomation (contracts/automation/NavOracleAutomation.sol#18-256)

Redundant expression "checkData (contracts/automation/UmbrellaEpochFinalizer.sol#44)" inUmbrellaEpochFinalizer (contracts/automation/UmbrellaEpochFinalizer.sol#12-67)

Redundant expression "performData (contracts/automation/UmbrellaEpochFinalizer.sol#56)" inUmbrellaEpochFinalizer (contracts/automation/UmbrellaEpochFinalizer.sol#12-67)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#redundant-statements

INFO:Detectors:

The following unused import(s) in contracts/AccessManagerImport.sol should be removed:

	-import "@openzeppelin/contracts/access/manager/AccessManager.sol"; (contracts/AccessManagerImport.sol#4)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#unused-imports

INFO:Slither:. analyzed (67 contracts with 91 detectors), 48 result(s) found

