import {expect} from "chai";
import {ethers, upgrades, network} from "hardhat";
import {parseUnits} from "ethers";
import {
    impersonateAccount,
    setBalance,
    takeSnapshot,
    time,
} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

import {Vault, ReservoirUSDC, MZUSD, IERC20, Tranche} from "../typechain-types";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

// Role for Vault to call MZUSD.mint + Tranche.notifyYield
const VAULT_ROLE = 2n;

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

async function imp(addr: string) {
    await setBalance(addr, to18(10)); // ETH for gas
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("Vault Yield Distribution", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;

    let accessManager: any;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;

    let junior: Tranche;
    let mezzanine: Tranche;
    let senior: Tranche;

    let whale: any;

    const DAY = 24 * 60 * 60;

    before(async () => {
        [deployer, alice, bob, carol] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
        usdcTotalSupply = await usdc.totalSupply();
        whale = await imp(USDC_WHALE);
        upgrades.silenceWarnings();
        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        accessManager = await AccessManagerFactory.deploy(deployer.address);
        await accessManager.waitForDeployment();

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                usdcTotalSupply, // _initialCapUSDC (max allowed)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;

        const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
        reservoir = (await upgrades.deployProxy(ReservoirFactory, [accessManager.target], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [MAINNET_USDC],
        })) as unknown as ReservoirUSDC;

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(
            VaultFactory,
            [mzusd.target, reservoir.target, accessManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as Vault;

        // 3 tranches
        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);

        junior = (await upgrades.deployProxy(
            TrancheFactory,
            [mzusd.target, vault.target, 1, 0, "Junior Tranche", "JLT", accessManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [false],
            }
        )) as unknown as Tranche;

        mezzanine = (await upgrades.deployProxy(
            TrancheFactory,
            [mzusd.target, vault.target, 2, 0, "Mezzanine Tranche", "MLT", accessManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [false],
            }
        )) as unknown as Tranche;

        senior = (await upgrades.deployProxy(
            TrancheFactory,
            [mzusd.target, vault.target, 3, 0, "Senior Tranche", "sMZUSD", accessManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [false],
            }
        )) as unknown as Tranche;

        // Roles
        const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();

        // public: MZUSD deposit/requestWithdrawal + token ops
        const depSel = mzusd.interface.getFunction("deposit").selector;
        const reqSel = mzusd.interface.getFunction("requestWithdrawal").selector;
        const approveSel = mzusd.interface.getFunction("approve").selector;
        const transferSel = mzusd.interface.getFunction("transfer").selector;
        const transferFromSel = mzusd.interface.getFunction("transferFrom").selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [depSel, reqSel], PUBLIC_ROLE);
        await accessManager.setTargetFunctionRole(
            mzusd.target,
            [approveSel, transferSel, transferFromSel],
            PUBLIC_ROLE
        );

        // public: Tranche user-facing functions
        const tDepSel = junior.interface.getFunction("deposit").selector;
        const tReqSel = junior.interface.getFunction("requestWithdrawal").selector;
        const tCancelSel = junior.interface.getFunction("cancelUnstake").selector;
        const tClaimSel = junior.interface.getFunction("claim").selector;

        await accessManager.setTargetFunctionRole(
            junior.target,
            [tDepSel, tReqSel, tCancelSel, tClaimSel],
            PUBLIC_ROLE
        );
        await accessManager.setTargetFunctionRole(
            mezzanine.target,
            [tDepSel, tReqSel, tCancelSel, tClaimSel],
            PUBLIC_ROLE
        );
        await accessManager.setTargetFunctionRole(
            senior.target,
            [tDepSel, tReqSel, tCancelSel, tClaimSel],
            PUBLIC_ROLE
        );

        // admin: MZUSD.setVault
        const setVaultSel = mzusd.interface.getFunction("setVault").selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSel], ADMIN_ROLE);

        // admin: vault.distributeYield/addTranche/updateTranche + config setters used by tests
        const distributeSel = vault.interface.getFunction("distributeYield").selector;
        const advanceEpochSel = vault.interface.getFunction("advanceEpoch").selector;
        const addTrancheSel = vault.interface.getFunction("addTranche").selector;
        const updateTrancheSel = vault.interface.getFunction("updateTranche").selector;
        const setFeesSel = vault.interface.getFunction("setFees").selector;
        const setInsuranceSel = vault.interface.getFunction("setInsurance").selector;
        const setEpochConfigSel = vault.interface.getFunction("setEpochConfig").selector;
        await accessManager.setTargetFunctionRole(
            vault.target,
            [
                distributeSel,
                advanceEpochSel,
                addTrancheSel,
                updateTrancheSel,
                setFeesSel,
                setInsuranceSel,
                setEpochConfigSel,
            ],
            ADMIN_ROLE
        );

        // admin: Tranche config/finalize functions (for tests/helpers)
        const tFinalizeSel = junior.interface.getFunction("finalizeEpoch").selector;
        const tSetUnstakeDelaySel = junior.interface.getFunction("setUnstakeDelayEpochs").selector;
        const tSetDepositLimitsSel = junior.interface.getFunction("setDepositLimits").selector;

        await accessManager.setTargetFunctionRole(junior.target, [tFinalizeSel], PUBLIC_ROLE);
        await accessManager.setTargetFunctionRole(mezzanine.target, [tFinalizeSel], PUBLIC_ROLE);
        await accessManager.setTargetFunctionRole(senior.target, [tFinalizeSel], PUBLIC_ROLE);
        await accessManager.setTargetFunctionRole(
            junior.target,
            [tSetUnstakeDelaySel, tSetDepositLimitsSel],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(
            mezzanine.target,
            [tSetUnstakeDelaySel, tSetDepositLimitsSel],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(
            senior.target,
            [tSetUnstakeDelaySel, tSetDepositLimitsSel],
            ADMIN_ROLE
        );

        // vault role: MZUSD.mint
        const mintSel = mzusd.interface.getFunction("mint").selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [mintSel], VAULT_ROLE);
        await accessManager.grantRole(VAULT_ROLE, vault.target, 0);

        // vault role: tranche.notifyYield (each tranche)
        const notifySel = junior.interface.getFunction("notifyYield").selector;
        await accessManager.setTargetFunctionRole(junior.target, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(mezzanine.target, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(senior.target, [notifySel], VAULT_ROLE);

        const trancheDepositSel = junior.interface.getFunction("deposit").selector;
        const trancheMintSel = junior.interface.getFunction("mint").selector;
        const trancheRequestSel = junior.interface.getFunction("requestWithdrawal").selector;
        const trancheCancelSel = junior.interface.getFunction("cancelUnstake").selector;
        const trancheClaimSel = junior.interface.getFunction("claim").selector;
        const trancheWithdrawSel = junior.interface.getFunction("withdraw").selector;
        const trancheRedeemSel = junior.interface.getFunction("redeem").selector;
        const trancheApproveSel = junior.interface.getFunction("approve").selector;
        const trancheTransferSel = junior.interface.getFunction("transfer").selector;
        const trancheTransferFromSel = junior.interface.getFunction("transferFrom").selector;
        const trancheSelectors = [
            trancheDepositSel,
            trancheMintSel,
            trancheRequestSel,
            trancheCancelSel,
            trancheClaimSel,
            trancheWithdrawSel,
            trancheRedeemSel,
            trancheApproveSel,
            trancheTransferSel,
            trancheTransferFromSel,
        ];
        await accessManager.setTargetFunctionRole(junior.target, trancheSelectors, PUBLIC_ROLE);
        await accessManager.setTargetFunctionRole(mezzanine.target, trancheSelectors, PUBLIC_ROLE);
        await accessManager.setTargetFunctionRole(senior.target, trancheSelectors, PUBLIC_ROLE);

        // wire and register
        await mzusd.setVault(vault.target);

        await vault.addTranche({tranche: junior.target, weightBps: 2000, enabled: true});
        await vault.addTranche({tranche: mezzanine.target, weightBps: 3000, enabled: true});
        await vault.addTranche({tranche: senior.target, weightBps: 5000, enabled: true});

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusd.target, usdcAmount6);
        await (await mzusd.connect(user).deposit(usdcAmount6)).wait();
        return await mzusd.balanceOf(user.address);
    }

    async function depositMZIntoTranche(user: any, tranche: Tranche, mzAmount18: bigint) {
        await mzusd.connect(user).approve(tranche.target, mzAmount18);
        await (await tranche.connect(user).deposit(mzAmount18, user.address)).wait();
    }

    it("Getters sanity", async () => {
        // tranchesLength
        expect(await vault.tranchesLength()).to.equal(3n);

        // getTrancheInfo
        const [t0, w0, e0] = await vault.getTrancheInfo(0);
        expect(t0).to.equal(junior.target);
        expect(w0).to.equal(2000n);
        expect(e0).to.equal(true);

        const [t1, w1, e1] = await vault.getTrancheInfo(1);
        expect(t1).to.equal(mezzanine.target);
        expect(w1).to.equal(3000n);
        expect(e1).to.equal(true);

        const [t2, w2, e2] = await vault.getTrancheInfo(2);
        expect(t2).to.equal(senior.target);
        expect(w2).to.equal(5000n);
        expect(e2).to.equal(true);

        // getFeesConfig defaults
        const [perfBps0, perfReceiver0, protBps0, protReceiver0] = await vault.getFeesConfig();
        expect(perfBps0).to.equal(0n);
        expect(perfReceiver0).to.equal(ethers.ZeroAddress);
        expect(protBps0).to.equal(0n);
        expect(protReceiver0).to.equal(ethers.ZeroAddress);

        // After setting fees, getter must reflect updates
        await (
            await vault.connect(deployer).setFees(1111, bob.address, 2222, carol.address)
        ).wait();
        const [perfBps1, perfReceiver1, protBps1, protReceiver1] = await vault.getFeesConfig();
        expect(perfBps1).to.equal(1111n);
        expect(perfReceiver1).to.equal(bob.address);
        expect(protBps1).to.equal(2222n);
        expect(protReceiver1).to.equal(carol.address);

        // Tranche info updates should be visible through getter
        await (await vault.connect(deployer).updateTranche(1, 1234, false)).wait();
        const [t1b, w1b, e1b] = await vault.getTrancheInfo(1);
        expect(t1b).to.equal(mezzanine.target);
        expect(w1b).to.equal(1234n);
        expect(e1b).to.equal(false);

        // Length unchanged
        expect(await vault.tranchesLength()).to.equal(3n);
    });

    it("Distributes yield by weight*TVL and sends dust (as yield part) to last tranche", async () => {
        const tvlJ = to18(101n);
        const tvlM = to18(203n);
        const tvlS = to18(307n);

        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(101n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(203n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(307n)));

        expect(await junior.totalAssets()).to.equal(tvlJ);
        expect(await mezzanine.totalAssets()).to.equal(tvlM);
        expect(await senior.totalAssets()).to.equal(tvlS);

        await time.increase(DAY);

        const reportedUSDC = to6(123n);
        const expectedYield = to18(123n);
        const newEpochId = (await vault.currentEpochId()) + 1n;

        const bJ0 = await mzusd.balanceOf(junior.target);
        const bM0 = await mzusd.balanceOf(mezzanine.target);
        const bS0 = await mzusd.balanceOf(senior.target);

        const tx = await vault.connect(deployer).distributeYield(reportedUSDC);
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);
        const startTs = BigInt(block!.timestamp);
        const duration = BigInt(await vault.epochDuration());
        const endTs = startTs + duration;

        // exact allocation math (same as Vault)
        const scoreJ = 2000n * tvlJ;
        const scoreM = 3000n * tvlM;
        const scoreS = 5000n * tvlS;
        const totalScore = scoreJ + scoreM + scoreS;

        const partJ = (expectedYield * scoreJ) / totalScore;
        const partM = (expectedYield * scoreM) / totalScore;
        const partS = (expectedYield * scoreS) / totalScore;
        const dust = expectedYield - (partJ + partM + partS);
        const partSWithDust = partS + dust;

        await expect(tx)
            .to.emit(junior, "YieldNotified")
            .withArgs(newEpochId, partJ, startTs, endTs);
        await expect(tx)
            .to.emit(mezzanine, "YieldNotified")
            .withArgs(newEpochId, partM, startTs, endTs);
        await expect(tx)
            .to.emit(senior, "YieldNotified")
            .withArgs(newEpochId, partSWithDust, startTs, endTs);

        await expect(tx)
            .to.emit(vault, "YieldDistributed")
            .withArgs(reportedUSDC, expectedYield, newEpochId);

        expect(await junior.yieldStreamingAmount()).to.equal(partJ);
        expect(await mezzanine.yieldStreamingAmount()).to.equal(partM);
        expect(await senior.yieldStreamingAmount()).to.equal(partSWithDust);

        const bJ1 = await mzusd.balanceOf(junior.target);
        const bM1 = await mzusd.balanceOf(mezzanine.target);
        const bS1 = await mzusd.balanceOf(senior.target);

        expect(bM1 - bM0).to.equal(partM);
        expect(bS1 - bS0).to.equal(partSWithDust);
        expect(bJ1 - bJ0).to.equal(partJ);

        // Vault should have no leftover MZUSD
        expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
    });

    it("Disabled tranche doesn't receive yield + notifyYield", async () => {
        // equal TVLs to make it easier, but still exact math + dust
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(50n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(50n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(50n)));

        // disable Mezzanine (idx = 1 because we added junior, mezzanine, senior in that order)
        await vault.connect(deployer).updateTranche(1, 3000, false);

        await time.increase(DAY);

        const reportedUSDC = to6(10n);
        const expectedYield = to18(10n);
        const newEpochId = (await vault.currentEpochId()) + 1n;

        const bJ0 = await mzusd.balanceOf(junior.target);
        const bM0 = await mzusd.balanceOf(mezzanine.target);
        const bS0 = await mzusd.balanceOf(senior.target);

        const tx = await vault.connect(deployer).distributeYield(reportedUSDC);
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);
        const startTs = BigInt(block!.timestamp);
        const duration = BigInt(await vault.epochDuration());
        const endTs = startTs + duration;

        // With mezzanine disabled, only junior + senior are scored.
        const tvlJ = await junior.totalAssets();
        const tvlS = await senior.totalAssets();
        const scoreJ = 2000n * tvlJ;
        const scoreS = 5000n * tvlS;
        const totalScore = scoreJ + scoreS;

        const partJ = (expectedYield * scoreJ) / totalScore;
        const partS = (expectedYield * scoreS) / totalScore;
        const dust = expectedYield - (partJ + partS);
        const partSWithDust = partS + dust;

        await expect(tx)
            .to.emit(junior, "YieldNotified")
            .withArgs(newEpochId, partJ, startTs, endTs);
        await expect(tx).to.not.emit(mezzanine, "YieldNotified");
        await expect(tx)
            .to.emit(senior, "YieldNotified")
            .withArgs(newEpochId, partSWithDust, startTs, endTs);

        const bJ1 = await mzusd.balanceOf(junior.target);
        const bM1 = await mzusd.balanceOf(mezzanine.target);
        const bS1 = await mzusd.balanceOf(senior.target);

        expect(bM1).to.equal(bM0); // no allocation
        expect(bS1 - bS0).to.equal(partSWithDust);
        expect(bJ1 - bJ0).to.equal(partJ);

        expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
    });
    it("Epoch advances, fees minted (fees = 100%), and no tranche notify/transfer happens", async () => {
        await time.increase(DAY);

        const perfReceiver = bob.address;
        await (
            await vault.connect(deployer).setFees(10_000, perfReceiver, 0, ethers.ZeroAddress)
        ).wait();

        const usdcReported = 77n; // 0.000077 USDC (still non-zero)
        const expectedGross = usdcReported * 1_000_000_000_000n; // * 1e12 -> 18d MZUSD

        const epochBefore = await vault.currentEpochId();
        const feeBalBefore = await mzusd.balanceOf(perfReceiver);

        const tx = await vault.connect(deployer).distributeYield(usdcReported);
        await expect(tx).to.not.emit(junior, "YieldNotified");
        await expect(tx).to.not.emit(mezzanine, "YieldNotified");
        await expect(tx).to.not.emit(senior, "YieldNotified");

        const epochAfter = await vault.currentEpochId();
        expect(epochAfter).to.equal(epochBefore + 1n);

        const feeBalAfter = await mzusd.balanceOf(perfReceiver);
        expect(feeBalAfter - feeBalBefore).to.equal(expectedGross);

        // No allocation mint should remain on Vault
        expect(await mzusd.balanceOf(vault.target)).to.equal(0n);

        await expect(tx).to.emit(vault, "YieldDistributed").withArgs(usdcReported, 0n, epochAfter);
    });

    it("Fees paid, insurance receives cut, dust folds into last tranche", async () => {
        // TVLs with awkward numbers
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(101n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(203n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(307n)));

        const perfReceiver = bob.address;
        const protReceiver = carol.address;
        const insurance = alice.address;

        const perfBps = 321n; // 3.21%
        const protBps = 123n; // 1.23%
        const insBps = 777n; // 7.77%

        await (
            await vault.connect(deployer).setFees(perfBps, perfReceiver, protBps, protReceiver)
        ).wait();
        await (await vault.connect(deployer).setInsurance(insurance, insBps)).wait();

        await time.increase(DAY);

        const usdcReported = to6(123n);
        const mintedGross = 123n * 1_000_000_000_000_000_000n; // 123 * 1e18

        const epochBefore = await vault.currentEpochId();
        const newEpochId = epochBefore + 1n;

        const perfBefore = await mzusd.balanceOf(perfReceiver);
        const protBefore = await mzusd.balanceOf(protReceiver);
        const insBefore = await mzusd.balanceOf(insurance);

        const bJ0 = await mzusd.balanceOf(junior.target);
        const bM0 = await mzusd.balanceOf(mezzanine.target);
        const bS0 = await mzusd.balanceOf(senior.target);

        const tx = await vault.connect(deployer).distributeYield(usdcReported);
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);
        const startTs = BigInt(block!.timestamp);
        const duration = BigInt(await vault.epochDuration());
        const endTs = startTs + duration;

        const perfFee = (mintedGross * perfBps) / 10_000n;
        const protFee = (mintedGross * protBps) / 10_000n;
        const allocatable = mintedGross - perfFee - protFee;

        const insCut = (allocatable * insBps) / 10_000n;
        const amountForTranches = allocatable - insCut;

        const tvlJ = await junior.totalAssets();
        const tvlM = await mezzanine.totalAssets();
        const tvlS = await senior.totalAssets();

        const scoreJ = 2000n * tvlJ;
        const scoreM = 3000n * tvlM;
        const scoreS = 5000n * tvlS;
        const totalScore = scoreJ + scoreM + scoreS;

        const partJ = (amountForTranches * scoreJ) / totalScore;
        const partM = (amountForTranches * scoreM) / totalScore;
        const partS = (amountForTranches * scoreS) / totalScore;
        const allocated = partJ + partM + partS;
        const dust = amountForTranches - allocated;
        const partSWithDust = partS + dust;

        // notifyYield amounts include dust in the last tranche
        await expect(tx)
            .to.emit(junior, "YieldNotified")
            .withArgs(newEpochId, partJ, startTs, endTs);
        await expect(tx)
            .to.emit(mezzanine, "YieldNotified")
            .withArgs(newEpochId, partM, startTs, endTs);
        await expect(tx)
            .to.emit(senior, "YieldNotified")
            .withArgs(newEpochId, partSWithDust, startTs, endTs);

        // Fees should be minted out
        const perfAfter = await mzusd.balanceOf(perfReceiver);
        const protAfter = await mzusd.balanceOf(protReceiver);
        expect(perfAfter - perfBefore).to.equal(perfFee);
        expect(protAfter - protBefore).to.equal(protFee);

        // Insurance receives only the cut
        const insAfter = await mzusd.balanceOf(insurance);
        expect(insAfter - insBefore).to.equal(insCut);

        // Tranches receive their parts, dust is folded into the last tranche
        const bJ1 = await mzusd.balanceOf(junior.target);
        const bM1 = await mzusd.balanceOf(mezzanine.target);
        const bS1 = await mzusd.balanceOf(senior.target);
        expect(bJ1 - bJ0).to.equal(partJ);
        expect(bM1 - bM0).to.equal(partM);
        expect(bS1 - bS0).to.equal(partSWithDust);

        await expect(tx)
            .to.emit(vault, "YieldDistributed")
            .withArgs(usdcReported, amountForTranches, newEpochId);

        // Vault should have no leftover MZUSD after distributing
        expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
    });

    it("Change tranche config mid-flight (disable first tranche + change weights)", async () => {
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(20n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(30n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(40n)));

        // First distribution (starts stream)
        await time.increase(DAY);
        await (await vault.connect(deployer).distributeYield(to6(10n))).wait();

        // Disable junior and change weights
        await (await vault.connect(deployer).updateTranche(0, 2000, false)).wait();
        await (await vault.connect(deployer).updateTranche(1, 9000, true)).wait();
        await (await vault.connect(deployer).updateTranche(2, 1000, true)).wait();

        // Next epoch distribution (previous streams fully accrued by now)
        await time.increase(DAY);

        const tvlM = await mezzanine.totalAssets();
        const tvlS = await senior.totalAssets();

        const usdcReported = to6(11n);
        const expectedYield = 11n * 1_000_000_000_000_000_000n;

        const scoreM = 9000n * tvlM;
        const scoreS = 1000n * tvlS;
        const totalScore = scoreM + scoreS;

        const partM = (expectedYield * scoreM) / totalScore;
        const partS = (expectedYield * scoreS) / totalScore;
        const dust = expectedYield - (partM + partS);
        const partSWithDust = partS + dust;

        const bJ0 = await mzusd.balanceOf(junior.target);
        const bM0 = await mzusd.balanceOf(mezzanine.target);
        const bS0 = await mzusd.balanceOf(senior.target);

        const epochBefore = await vault.currentEpochId();
        const newEpochId = epochBefore + 1n;

        const tx = await vault.connect(deployer).distributeYield(usdcReported);

        // Junior should not be notified at all
        await expect(tx).to.not.emit(junior, "YieldNotified");

        // Mezzanine & Senior are notified
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);
        const startTs = BigInt(block!.timestamp);
        const duration = BigInt(await vault.epochDuration());
        const endTs = startTs + duration;

        await expect(tx)
            .to.emit(mezzanine, "YieldNotified")
            .withArgs(newEpochId, partM, startTs, endTs);
        await expect(tx)
            .to.emit(senior, "YieldNotified")
            .withArgs(newEpochId, partSWithDust, startTs, endTs);

        const bJ1 = await mzusd.balanceOf(junior.target);
        const bM1 = await mzusd.balanceOf(mezzanine.target);
        const bS1 = await mzusd.balanceOf(senior.target);

        expect(bJ1).to.equal(bJ0);
        expect(bS1 - bS0).to.equal(partSWithDust);
        expect(bM1 - bM0).to.equal(partM);

        expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
    });

    it("Weight = 0 (tranches are ignored)", async () => {
        // Give all tranches TVL so TVLZero isn't the reason for a revert
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(10n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(10n)));

        // mezzanine has weight = 0 (enabled) -> should get nothing
        await (await vault.connect(deployer).updateTranche(1, 0, true)).wait();
        await time.increase(DAY);

        const bM0 = await mzusd.balanceOf(mezzanine.target);
        const txA = await vault.connect(deployer).distributeYield(to6(9n));
        await expect(txA).to.not.emit(mezzanine, "YieldNotified");
        const bM1 = await mzusd.balanceOf(mezzanine.target);
        expect(bM1).to.equal(bM0);

        // all weights = 0 (enabled) -> WeightsZero
        await (await vault.connect(deployer).updateTranche(0, 0, true)).wait();
        await (await vault.connect(deployer).updateTranche(1, 0, true)).wait();
        await (await vault.connect(deployer).updateTranche(2, 0, true)).wait();

        await time.increase(DAY);
        await expect(
            vault.connect(deployer).distributeYield(to6(1n))
        ).to.be.revertedWithCustomError(vault, "WeightsZero");
    });

    it("Shortening epochDuration can make the next distributeYield hit YieldStreamIsActive", async () => {
        // Ensure TVL > 0 so allocation is attempted
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));

        // First distribution uses default epochDuration = 1 day and starts a 1-day stream
        await time.increase(DAY);
        await (await vault.connect(deployer).distributeYield(to6(2n))).wait();

        // Shorten epoch duration to 1 hour WITHOUT resetting epochStart
        await (await vault.connect(deployer).setEpochConfig(60 * 60, false)).wait();

        // After 1 hour, epoch is allowed to advance, but the tranche stream is still active (it was 1 day)
        await time.increase(60 * 60);

        await expect(
            vault.connect(deployer).distributeYield(to6(1n))
        ).to.be.revertedWithCustomError(junior, "YieldStreamIsActive");
    });

    it("Stress for resetStart = false", async () => {
        // TVL > 0 so allocation is attempted.
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));

        // Default duration is 1 day. Move close to 1 day but not enough -> still EpochTooSoon.
        await time.increase(DAY - 60);
        await expect(
            vault.connect(deployer).distributeYield(to6(1n))
        ).to.be.revertedWithCustomError(vault, "EpochTooSoon");

        // Shorten epoch duration to 1 hour WITHOUT resetting epochStart
        // Since we've already passed > 1 hour since the original epochStart, distributeYield should be allowed now
        await (await vault.connect(deployer).setEpochConfig(60 * 60, false)).wait();

        const epochBefore = await vault.currentEpochId();
        const expectedEpoch = epochBefore + 1n;

        const tx = await vault.connect(deployer).distributeYield(to6(1n));
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);
        const startTs = BigInt(block!.timestamp);
        const endTs = startTs + 3600n;

        // Whole yield goes to junior (others have TVL=0).
        const expectedYield = to18(1n);
        await expect(tx)
            .to.emit(junior, "YieldNotified")
            .withArgs(expectedEpoch, expectedYield, startTs, endTs);

        // Stream is 1 hour
        expect((await junior.yieldStreamEnd()) - (await junior.yieldStreamStart())).to.equal(3600n);
    });

    it("Stress for resetStart = true", async () => {
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));

        // First distribution under default 1 day duration -> starts a 1-day stream
        await time.increase(DAY);
        await (await vault.connect(deployer).distributeYield(to6(2n))).wait();

        const streamStart1 = await junior.yieldStreamStart();
        const streamEnd1 = await junior.yieldStreamEnd();
        expect(streamEnd1 - streamStart1).to.equal(BigInt(DAY));

        const epochAfterFirst = await vault.currentEpochId();

        // Now shorten epoch duration to 1 hour and reset epochStart
        await (await vault.connect(deployer).setEpochConfig(60 * 60, true)).wait();

        // After 1 hour Vault would allow next epoch, but tranche still has an active (old) 1-day stream -> revert
        await time.increase(60 * 60);

        await expect(
            vault.connect(deployer).distributeYield(to6(1n))
        ).to.be.revertedWithCustomError(junior, "YieldStreamIsActive");

        // Revert must rollback Vault epoch advancement attempt
        expect(await vault.currentEpochId()).to.equal(epochAfterFirst);

        // After enough time passes (past old stream), distribution should succeed and new stream uses 1 hour
        await time.increase(DAY);

        const epochBeforeSecond = await vault.currentEpochId();
        const expectedEpoch2 = epochBeforeSecond + 1n;

        const tx2 = await vault.connect(deployer).distributeYield(to6(1n));
        const receipt2 = await tx2.wait();
        const block2 = await ethers.provider.getBlock(receipt2!.blockNumber);
        const startTs2 = BigInt(block2!.timestamp);
        const endTs2 = startTs2 + 3600n;

        await expect(tx2)
            .to.emit(junior, "YieldNotified")
            .withArgs(expectedEpoch2, to18(1n), startTs2, endTs2);

        expect((await junior.yieldStreamEnd()) - (await junior.yieldStreamStart())).to.equal(3600n);
    });

    it("Reverts InvalidEpochDuration for out-of-bounds values", async () => {
        const MIN = 60 * 60; // 1 hour
        const MAX = 30 * 24 * 60 * 60; // 30 days

        await expect(
            vault.connect(deployer).setEpochConfig(MIN - 1, false)
        ).to.be.revertedWithCustomError(vault, "InvalidEpochDuration");

        await expect(
            vault.connect(deployer).setEpochConfig(MAX + 1, false)
        ).to.be.revertedWithCustomError(vault, "InvalidEpochDuration");
    });

    it("Distribution works with Yield = 0 ", async () => {
        const before = await vault.currentEpochId();

        await time.increase(DAY);
        await expect(vault.connect(deployer).distributeYield(0)).to.not.be.reverted;

        const after = await vault.currentEpochId();
        expect(after).to.equal(before + 1n);
    });
});
