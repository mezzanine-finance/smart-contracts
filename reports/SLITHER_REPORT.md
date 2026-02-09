**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [unchecked-transfer](#unchecked-transfer) (8 results) (High)
 - [divide-before-multiply](#divide-before-multiply) (2 results) (Medium)
 - [incorrect-equality](#incorrect-equality) (1 results) (Medium)
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
[MZUSD.deposit(uint256)](contracts/MZUSD.sol#L118-L131) ignores return value by [usdc.transferFrom(msg.sender,address(vault),amountUSDC)](contracts/MZUSD.sol#L125)

contracts/MZUSD.sol#L118-L131


 - [ ] ID-1
[Vault._allocateYieldToTranches(uint256)](contracts/Vault.sol#L615-L676) ignores return value by [mzusdToken.transfer(t.tranche,totalShare)](contracts/Vault.sol#L665)

contracts/Vault.sol#L615-L676


 - [ ] ID-2
[Vault.withdraw(address,uint256)](contracts/Vault.sol#L182-L196) ignores return value by [usdc.transfer(to,amount)](contracts/Vault.sol#L194)

contracts/Vault.sol#L182-L196


 - [ ] ID-3
[PolJuniorTranche.notifyYield(uint256)](contracts/PolJuniorTranche.sol#L87-L93) ignores return value by [mzusd.transfer(polPayout,yieldAmount)](contracts/PolJuniorTranche.sol#L91)

contracts/PolJuniorTranche.sol#L87-L93


 - [ ] ID-4
[Tranche.claim(uint256)](contracts/Tranche.sol#L228-L244) ignores return value by [IERC20(asset()).transfer(msg.sender,userAssets)](contracts/Tranche.sol#L241)

contracts/Tranche.sol#L228-L244


 - [ ] ID-5
[ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L53-L61) ignores return value by [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L55)

contracts/ReservoirUSDC.sol#L53-L61


 - [ ] ID-6
[ReservoirUSDC.withdraw(uint256,address)](contracts/ReservoirUSDC.sol#L64-L78) ignores return value by [usdc.transfer(to,amount)](contracts/ReservoirUSDC.sol#L72)

contracts/ReservoirUSDC.sol#L64-L78


 - [ ] ID-7
[PolJuniorTranche.withdraw(uint256,address)](contracts/PolJuniorTranche.sol#L75-L83) ignores return value by [mzusd.transfer(receiver,assets)](contracts/PolJuniorTranche.sol#L81)

contracts/PolJuniorTranche.sol#L75-L83


## divide-before-multiply
Impact: Medium
Confidence: Medium
 - [ ] ID-8
[MZUSD.requestWithdrawal(uint256)](contracts/MZUSD.sol#L143-L159) performs a multiplication on the result of a division:
	- [usdcOut = amountMZ / SCALE](contracts/MZUSD.sol#L144)
	- [burnAmount = usdcOut * SCALE](contracts/MZUSD.sol#L146)

contracts/MZUSD.sol#L143-L159


 - [ ] ID-9
[Vault._allocateYieldToTranches(uint256)](contracts/Vault.sol#L615-L676) performs a multiplication on the result of a division:
	- [basePool = (allocatableMZUSD * baseRewardBps) / BPS](contracts/Vault.sol#L621)
	- [baseShare = (basePool * trancheTvl) / totalTvl](contracts/Vault.sol#L654)

contracts/Vault.sol#L615-L676


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-10
[Vault._rebalance()](contracts/Vault.sol#L691-L709) uses a dangerous strict equality:
	- [available == 0](contracts/Vault.sol#L704)

contracts/Vault.sol#L691-L709


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-11
[Vault._allocateYieldToTranches(uint256).totalTvl](contracts/Vault.sol#L623) is a local variable never initialized

contracts/Vault.sol#L623


 - [ ] ID-12
[Vault._rebalance().sent](contracts/Vault.sol#L695) is a local variable never initialized

contracts/Vault.sol#L695


 - [ ] ID-13
[Vault._allocateYieldToTranches(uint256).allocated](contracts/Vault.sol#L644) is a local variable never initialized

contracts/Vault.sol#L644


 - [ ] ID-14
[Vault._rebalance().pulled](contracts/Vault.sol#L696) is a local variable never initialized

contracts/Vault.sol#L696


 - [ ] ID-15
[Vault._allocateYieldToTranches(uint256).lastNonZeroIndex](contracts/Vault.sol#L624) is a local variable never initialized

contracts/Vault.sol#L624


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-16
[LossManager.applyLoss(uint256)](contracts/LossManager.sol#L116-L140) ignores return value by [IVault(vault).advanceEpoch()](contracts/LossManager.sol#L130)

contracts/LossManager.sol#L116-L140


 - [ ] ID-17
[Vault._rebalance()](contracts/Vault.sol#L691-L709) ignores return value by [usdc.approve(address(reservoir),sent)](contracts/Vault.sol#L699)

contracts/Vault.sol#L691-L709


## missing-zero-check
Impact: Low
Confidence: Medium
 - [ ] ID-18
[NavOracleAutomation.constructor(address,uint256).vault_](contracts/automation/NavOracleAutomation.sol#L59) lacks a zero-check on :
		- [vault = vault_](contracts/automation/NavOracleAutomation.sol#L63)

contracts/automation/NavOracleAutomation.sol#L59


 - [ ] ID-19
[PolJuniorTranche.initialize(address).polPayoutAddress](contracts/PolJuniorTranche.sol#L46) lacks a zero-check on :
		- [polPayout = polPayoutAddress](contracts/PolJuniorTranche.sol#L55)

contracts/PolJuniorTranche.sol#L46


 - [ ] ID-20
[NavOracleAutomation.constructor(address,uint256).lossManager_](contracts/automation/NavOracleAutomation.sol#L55) lacks a zero-check on :
		- [lossManager = lossManager_](contracts/automation/NavOracleAutomation.sol#L64)

contracts/automation/NavOracleAutomation.sol#L55


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-21
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


 - [ ] ID-22
Reentrancy in [ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L53-L61):
	External calls:
	- [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L55)
	State variables written after the call(s):
	- [_trackActor(msg.sender)](contracts/ReservoirUSDC.sol#L58)
		- [actorSeen[actor] = true](contracts/ReservoirUSDC.sol#L92)
	- [_trackActor(msg.sender)](contracts/ReservoirUSDC.sol#L58)
		- [actors.push(actor)](contracts/ReservoirUSDC.sol#L93)
	- [depositedBy[msg.sender] += amount](contracts/ReservoirUSDC.sol#L57)

contracts/ReservoirUSDC.sol#L53-L61


## reentrancy-events
Impact: Low
Confidence: Medium
 - [ ] ID-23
Reentrancy in [Vault.withdraw(address,uint256)](contracts/Vault.sol#L182-L196):
	External calls:
	- [reservoir.withdraw(amount - idle,address(this))](contracts/Vault.sol#L191)
	- [usdc.transfer(to,amount)](contracts/Vault.sol#L194)
	Event emitted after the call(s):
	- [WithdrawnUSDCFromVault(to,amount)](contracts/Vault.sol#L195)

contracts/Vault.sol#L182-L196


 - [ ] ID-24
Reentrancy in [Vault._rebalance()](contracts/Vault.sol#L691-L709):
	External calls:
	- [usdc.approve(address(reservoir),sent)](contracts/Vault.sol#L699)
	- [reservoir.deposit(sent)](contracts/Vault.sol#L700)
	- [reservoir.withdraw(pulled,address(this))](contracts/Vault.sol#L706)
	Event emitted after the call(s):
	- [Rebalanced(sent,pulled,usdc.balanceOf(address(this)))](contracts/Vault.sol#L708)

contracts/Vault.sol#L691-L709


 - [ ] ID-25
Reentrancy in [ReservoirUSDC.deposit(uint256)](contracts/ReservoirUSDC.sol#L53-L61):
	External calls:
	- [usdc.transferFrom(msg.sender,address(this),amount)](contracts/ReservoirUSDC.sol#L55)
	Event emitted after the call(s):
	- [Deposited(msg.sender,amount)](contracts/ReservoirUSDC.sol#L60)

contracts/ReservoirUSDC.sol#L53-L61


 - [ ] ID-26
Reentrancy in [Tranche.claim(uint256)](contracts/Tranche.sol#L228-L244):
	External calls:
	- [IERC20(asset()).transfer(msg.sender,userAssets)](contracts/Tranche.sol#L241)
	Event emitted after the call(s):
	- [WithdrawalClaimed(msg.sender,epochId,userAssets)](contracts/Tranche.sol#L243)

contracts/Tranche.sol#L228-L244


 - [ ] ID-27
Reentrancy in [NavOracleAutomation._applyPending()](contracts/automation/NavOracleAutomation.sol#L150-L164):
	External calls:
	- [IVault(vault).distributeYield(deltaUSDC)](contracts/automation/NavOracleAutomation.sol#L158)
	- [ILossManager(lossManager).applyLoss(deltaUSDC)](contracts/automation/NavOracleAutomation.sol#L160)
	Event emitted after the call(s):
	- [NavApplied(isYield,deltaUSDC,readyAt)](contracts/automation/NavOracleAutomation.sol#L163)

contracts/automation/NavOracleAutomation.sol#L150-L164


 - [ ] ID-28
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


 - [ ] ID-29
Reentrancy in [MZUSD.requestWithdrawal(uint256)](contracts/MZUSD.sol#L143-L159):
	External calls:
	- [vault.withdraw(msg.sender,usdcOut)](contracts/MZUSD.sol#L156)
	Event emitted after the call(s):
	- [Withdrawal(msg.sender,usdcOut)](contracts/MZUSD.sol#L158)

contracts/MZUSD.sol#L143-L159


 - [ ] ID-30
Reentrancy in [PolJuniorTranche.notifyYield(uint256)](contracts/PolJuniorTranche.sol#L87-L93):
	External calls:
	- [mzusd.transfer(polPayout,yieldAmount)](contracts/PolJuniorTranche.sol#L91)
	Event emitted after the call(s):
	- [PolPayoutNotified(yieldAmount)](contracts/PolJuniorTranche.sol#L92)

contracts/PolJuniorTranche.sol#L87-L93


## redundant-statements
Impact: Informational
Confidence: High
 - [ ] ID-31
Redundant expression "[performData](contracts/automation/NavOracleAutomation.sol#L136)" in[NavOracleAutomation](contracts/automation/NavOracleAutomation.sol#L17-L190)

contracts/automation/NavOracleAutomation.sol#L136


 - [ ] ID-32
Redundant expression "[checkData](contracts/automation/NavOracleAutomation.sol#L126)" in[NavOracleAutomation](contracts/automation/NavOracleAutomation.sol#L17-L190)

contracts/automation/NavOracleAutomation.sol#L126


 - [ ] ID-33
Redundant expression "[performData](contracts/automation/UmbrellaEpochFinalizer.sol#L56)" in[UmbrellaEpochFinalizer](contracts/automation/UmbrellaEpochFinalizer.sol#L12-L67)

contracts/automation/UmbrellaEpochFinalizer.sol#L56


 - [ ] ID-34
Redundant expression "[checkData](contracts/automation/UmbrellaEpochFinalizer.sol#L44)" in[UmbrellaEpochFinalizer](contracts/automation/UmbrellaEpochFinalizer.sol#L12-L67)

contracts/automation/UmbrellaEpochFinalizer.sol#L44


## unused-import
Impact: Informational
Confidence: High
 - [ ] ID-35
The following unused import(s) in contracts/AccessManagerImport.sol should be removed:
	-import "@openzeppelin/contracts/access/manager/AccessManager.sol"; (contracts/AccessManagerImport.sol#4)

* * *

'npx hardhat clean' running (wd: /Users/anik/Developer/mezzanine)

'npx hardhat clean --global' running (wd: /Users/anik/Developer/mezzanine)

'npx hardhat compile --force' running (wd: /Users/anik/Developer/mezzanine)

INFO:Detectors:

MZUSD.deposit(uint256) (contracts/MZUSD.sol#118-131) ignores return value by usdc.transferFrom(msg.sender,address(vault),amountUSDC) (contracts/MZUSD.sol#125)

PolJuniorTranche.withdraw(uint256,address) (contracts/PolJuniorTranche.sol#75-83) ignores return value by mzusd.transfer(receiver,assets) (contracts/PolJuniorTranche.sol#81)

PolJuniorTranche.notifyYield(uint256) (contracts/PolJuniorTranche.sol#87-93) ignores return value by mzusd.transfer(polPayout,yieldAmount) (contracts/PolJuniorTranche.sol#91)

ReservoirUSDC.deposit(uint256) (contracts/ReservoirUSDC.sol#53-61) ignores return value by usdc.transferFrom(msg.sender,address(this),amount) (contracts/ReservoirUSDC.sol#55)

ReservoirUSDC.withdraw(uint256,address) (contracts/ReservoirUSDC.sol#64-78) ignores return value by usdc.transfer(to,amount) (contracts/ReservoirUSDC.sol#72)

Tranche.claim(uint256) (contracts/Tranche.sol#228-244) ignores return value by IERC20(asset()).transfer(msg.sender,userAssets) (contracts/Tranche.sol#241)

Vault.withdraw(address,uint256) (contracts/Vault.sol#182-196) ignores return value by usdc.transfer(to,amount) (contracts/Vault.sol#194)

Vault._allocateYieldToTranches(uint256) (contracts/Vault.sol#615-676) ignores return value by mzusdToken.transfer(t.tranche,totalShare) (contracts/Vault.sol#665)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#unchecked-transfer

INFO:Detectors:

MZUSD.requestWithdrawal(uint256) (contracts/MZUSD.sol#143-159) performs a multiplication on the result of a division:

	- usdcOut = amountMZ / SCALE (contracts/MZUSD.sol#144)

	- burnAmount = usdcOut * SCALE (contracts/MZUSD.sol#146)

Vault._allocateYieldToTranches(uint256) (contracts/Vault.sol#615-676) performs a multiplication on the result of a division:

	- basePool = (allocatableMZUSD * baseRewardBps) / BPS (contracts/Vault.sol#621)

	- baseShare = (basePool * trancheTvl) / totalTvl (contracts/Vault.sol#654)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#divide-before-multiply

INFO:Detectors:

Vault._rebalance() (contracts/Vault.sol#691-709) uses a dangerous strict equality:

	- available == 0 (contracts/Vault.sol#704)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#dangerous-strict-equalities

INFO:Detectors:

Vault._rebalance().pulled (contracts/Vault.sol#696) is a local variable never initialized

Vault._allocateYieldToTranches(uint256).lastNonZeroIndex (contracts/Vault.sol#624) is a local variable never initialized

Vault._rebalance().sent (contracts/Vault.sol#695) is a local variable never initialized

Vault._allocateYieldToTranches(uint256).allocated (contracts/Vault.sol#644) is a local variable never initialized

Vault._allocateYieldToTranches(uint256).totalTvl (contracts/Vault.sol#623) is a local variable never initialized

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#uninitialized-local-variables

INFO:Detectors:

LossManager.applyLoss(uint256) (contracts/LossManager.sol#116-140) ignores return value by IVault(vault).advanceEpoch() (contracts/LossManager.sol#130)

Vault._rebalance() (contracts/Vault.sol#691-709) ignores return value by usdc.approve(address(reservoir),sent) (contracts/Vault.sol#699)

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

Reentrancy in LossManager.applyLoss(uint256) (contracts/LossManager.sol#116-140):

	External calls:

	- IVault(vault).advanceEpoch() (contracts/LossManager.sol#130)

	- (burnedMZ,uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss)) (contracts/LossManager.sol#132)

		- ITranche(t0).burnMZUSD(burn0) (contracts/LossManager.sol#324)

		- ITranche(t1).burnMZUSD(burn1) (contracts/LossManager.sol#329)

		- ITranche(t0).burnMZUSD(burnAmount) (contracts/LossManager.sol#344)

	State variables written after the call(s):

	- lastUncoveredLossMZ = uncoveredMZ (contracts/LossManager.sol#134)

	- totalUncoveredLossMZ += uncoveredMZ (contracts/LossManager.sol#136)

Reentrancy in ReservoirUSDC.deposit(uint256) (contracts/ReservoirUSDC.sol#53-61):

	External calls:

	- usdc.transferFrom(msg.sender,address(this),amount) (contracts/ReservoirUSDC.sol#55)

	State variables written after the call(s):

	- _trackActor(msg.sender) (contracts/ReservoirUSDC.sol#58)

		- actorSeen[actor] = true (contracts/ReservoirUSDC.sol#92)

	- _trackActor(msg.sender) (contracts/ReservoirUSDC.sol#58)

		- actors.push(actor) (contracts/ReservoirUSDC.sol#93)

	- depositedBy[msg.sender] += amount (contracts/ReservoirUSDC.sol#57)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-2

INFO:Detectors:

Reentrancy in NavOracleAutomation._applyPending() (contracts/automation/NavOracleAutomation.sol#150-164):

	External calls:

	- IVault(vault).distributeYield(deltaUSDC) (contracts/automation/NavOracleAutomation.sol#158)

	- ILossManager(lossManager).applyLoss(deltaUSDC) (contracts/automation/NavOracleAutomation.sol#160)

	Event emitted after the call(s):

	- NavApplied(isYield,deltaUSDC,readyAt) (contracts/automation/NavOracleAutomation.sol#163)

Reentrancy in Vault._rebalance() (contracts/Vault.sol#691-709):

	External calls:

	- usdc.approve(address(reservoir),sent) (contracts/Vault.sol#699)

	- reservoir.deposit(sent) (contracts/Vault.sol#700)

	- reservoir.withdraw(pulled,address(this)) (contracts/Vault.sol#706)

	Event emitted after the call(s):

	- Rebalanced(sent,pulled,usdc.balanceOf(address(this))) (contracts/Vault.sol#708)

Reentrancy in LossManager.applyLoss(uint256) (contracts/LossManager.sol#116-140):

	External calls:

	- IVault(vault).advanceEpoch() (contracts/LossManager.sol#130)

	- (burnedMZ,uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss)) (contracts/LossManager.sol#132)

		- ITranche(t0).burnMZUSD(burn0) (contracts/LossManager.sol#324)

		- ITranche(t1).burnMZUSD(burn1) (contracts/LossManager.sol#329)

		- ITranche(t0).burnMZUSD(burnAmount) (contracts/LossManager.sol#344)

	Event emitted after the call(s):

	- LossApplied(usdcLoss,_toMZ(usdcLoss),burnedMZ,uncoveredMZ,totalUncoveredLossMZ) (contracts/LossManager.sol#139)

Reentrancy in Tranche.claim(uint256) (contracts/Tranche.sol#228-244):

	External calls:

	- IERC20(asset()).transfer(msg.sender,userAssets) (contracts/Tranche.sol#241)

	Event emitted after the call(s):

	- WithdrawalClaimed(msg.sender,epochId,userAssets) (contracts/Tranche.sol#243)

Reentrancy in ReservoirUSDC.deposit(uint256) (contracts/ReservoirUSDC.sol#53-61):

	External calls:

	- usdc.transferFrom(msg.sender,address(this),amount) (contracts/ReservoirUSDC.sol#55)

	Event emitted after the call(s):

	- Deposited(msg.sender,amount) (contracts/ReservoirUSDC.sol#60)

Reentrancy in PolJuniorTranche.notifyYield(uint256) (contracts/PolJuniorTranche.sol#87-93):

	External calls:

	- mzusd.transfer(polPayout,yieldAmount) (contracts/PolJuniorTranche.sol#91)

	Event emitted after the call(s):

	- PolPayoutNotified(yieldAmount) (contracts/PolJuniorTranche.sol#92)

Reentrancy in MZUSD.requestWithdrawal(uint256) (contracts/MZUSD.sol#143-159):

	External calls:

	- vault.withdraw(msg.sender,usdcOut) (contracts/MZUSD.sol#156)

	Event emitted after the call(s):

	- Withdrawal(msg.sender,usdcOut) (contracts/MZUSD.sol#158)

Reentrancy in Vault.withdraw(address,uint256) (contracts/Vault.sol#182-196):

	External calls:

	- reservoir.withdraw(amount - idle,address(this)) (contracts/Vault.sol#191)

	- usdc.transfer(to,amount) (contracts/Vault.sol#194)

	Event emitted after the call(s):

	- WithdrawnUSDCFromVault(to,amount) (contracts/Vault.sol#195)

Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-3

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

INFO:Slither:. analyzed (65 contracts with 91 detectors), 36 result(s) found

