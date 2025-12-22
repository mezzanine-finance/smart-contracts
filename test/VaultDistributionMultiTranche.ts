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
const USDC_WHALE = "0x38AAEF3782910bdd9eA3566C839788Af6FF9B200";

// Role for Vault to call MZUSD.mint + Tranche.notifyYield
const VAULT_ROLE = 2n;

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

async function imp(addr: string) {
    await setBalance(addr, to18(10)); // ETH for gas
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe.only("Vault distributeYield - multi tranche allocation", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;

    let accessManager: any;
    let usdc: IERC20;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;

    let junior: Tranche;
    let mezzanine: Tranche;
    let senior: Tranche;

    const DAY = 24 * 60 * 60;

    before(async () => {
        [deployer, alice, bob, carol] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
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
                0, // _hourlyLimitUSDC (0 = limit off)
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
            [
                mzusd.target,
                vault.target,
                1,
                0,
                "Junior Tranche",
                "JLT",
                accessManager.target,
                false,
                ethers.ZeroAddress,
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as Tranche;

        mezzanine = (await upgrades.deployProxy(
            TrancheFactory,
            [
                mzusd.target,
                vault.target,
                2,
                0,
                "Mezzanine Tranche",
                "MLT",
                accessManager.target,
                false,
                ethers.ZeroAddress,
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as Tranche;

        senior = (await upgrades.deployProxy(
            TrancheFactory,
            [
                mzusd.target,
                vault.target,
                3,
                0,
                "Senior Tranche",
                "sMZUSD",
                accessManager.target,
                false,
                ethers.ZeroAddress,
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as Tranche;

        // Roles
        const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();

        // public: MZUSD deposit/requestWithdrawal
        const depSel = mzusd.interface.getFunction("deposit")!.selector;
        const reqSel = mzusd.interface.getFunction("requestWithdrawal")!.selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [depSel, reqSel], PUBLIC_ROLE);

        // admin: MZUSD.setVault
        const setVaultSel = mzusd.interface.getFunction("setVault")!.selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSel], ADMIN_ROLE);

        // admin: vault.distributeYield/addTranche/updateTranche
        const distributeSel = vault.interface.getFunction("distributeYield")!.selector;
        const addTrancheSel = vault.interface.getFunction("addTranche")!.selector;
        const updateTrancheSel = vault.interface.getFunction("updateTranche")!.selector;
        await accessManager.setTargetFunctionRole(
            vault.target,
            [distributeSel, addTrancheSel, updateTrancheSel],
            ADMIN_ROLE
        );

        // vault role: MZUSD.mint
        const mintSel = mzusd.interface.getFunction("mint")!.selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [mintSel], VAULT_ROLE);
        await accessManager.grantRole(VAULT_ROLE, vault.target, 0);

        // vault role: tranche.notifyYield (each tranche)
        const notifySel = junior.interface.getFunction("notifyYield")!.selector;
        await accessManager.setTargetFunctionRole(junior.target, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(mezzanine.target, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(senior.target, [notifySel], VAULT_ROLE);

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
        const whale = await imp(USDC_WHALE);
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusd.target, usdcAmount6);
        await (await mzusd.connect(user).deposit(usdcAmount6)).wait();
        return await mzusd.balanceOf(user.address);
    }

    async function depositMZIntoTranche(user: any, tranche: Tranche, mzAmount18: bigint) {
        await mzusd.connect(user).approve(tranche.target, mzAmount18);
        await (await tranche.connect(user).deposit(mzAmount18, user.address)).wait();
    }

    it("Distributes yield by weight*TVL and sends dust to first enabled tranche", async () => {
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

        await expect(tx)
            .to.emit(junior, "YieldNotified")
            .withArgs(newEpochId, partJ, startTs, endTs);
        await expect(tx).to.emit(mezzanine, "YieldNotified").withArgs(newEpochId, partM, startTs, endTs);
        await expect(tx)
            .to.emit(senior, "YieldNotified")
            .withArgs(newEpochId, partS, startTs, endTs);

        await expect(tx)
            .to.emit(vault, "YieldDistributed")
            .withArgs(reportedUSDC, expectedYield, newEpochId);

        expect(await junior.yieldStreamingAmount()).to.equal(partJ);
        expect(await mezzanine.yieldStreamingAmount()).to.equal(partM);
        expect(await senior.yieldStreamingAmount()).to.equal(partS);

        const bJ1 = await mzusd.balanceOf(junior.target);
        const bM1 = await mzusd.balanceOf(mezzanine.target);
        const bS1 = await mzusd.balanceOf(senior.target);

        // dust is sent to firstEnabledTranche (junior) as a plain transfer (without notifyYield)
        expect(bM1 - bM0).to.equal(partM);
        expect(bS1 - bS0).to.equal(partS);
        expect(bJ1 - bJ0).to.equal(partJ + dust);

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

        await expect(tx)
            .to.emit(junior, "YieldNotified")
            .withArgs(newEpochId, partJ, startTs, endTs);
        await expect(tx).to.not.emit(mezzanine, "YieldNotified");
        await expect(tx)
            .to.emit(senior, "YieldNotified")
            .withArgs(newEpochId, partS, startTs, endTs);

        const bJ1 = await mzusd.balanceOf(junior.target);
        const bM1 = await mzusd.balanceOf(mezzanine.target);
        const bS1 = await mzusd.balanceOf(senior.target);

        expect(bM1).to.equal(bM0); // no allocation
        expect(bS1 - bS0).to.equal(partS);
        expect(bJ1 - bJ0).to.equal(partJ + dust); // dust again to first enabled tranche (junior)

        expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
    });
});
