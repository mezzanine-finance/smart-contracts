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

import {
    Vault,
    ReservoirUSDC,
    MZUSD,
    IERC20,
    Tranche,
    LossManager,
    PolJuniorTranche,
    PauseManager,
} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

const VAULT_ROLE = 2n;
const LOSS_MANAGER_ROLE = 3n;

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

async function imp(addr: string) {
    await setBalance(addr, to18(10)); // ETH for gas
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("LossManager", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;

    let junior: Tranche;
    let mezzanine: Tranche;
    let senior: Tranche;

    let pol: PolJuniorTranche;

    let vaultAddr: string;
    let mzusdAddr: string;
    let juniorAddr: string;
    let mezzanineAddr: string;
    let seniorAddr: string;
    let lossManagerAddr: string;
    let polAddr: string;

    let lossManager: LossManager;

    let whale: any;

    const DAY = 24 * 60 * 60;

    before(async () => {
        [deployer, alice, bob, carol] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
        usdcTotalSupply = await usdc.totalSupply();
        // Impersonate whale once for speed (reuse across tests)
        whale = await imp(USDC_WHALE);
        upgrades.silenceWarnings();
        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        accessManager = await AccessManagerFactory.deploy(deployer.address);
        await accessManager.waitForDeployment();

        const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
        pauseManager = (await upgrades.deployProxy(PauseManagerFactory, [accessManager.target], {
            kind: "uups",
            initializer: "initialize",
        })) as unknown as PauseManager;

        const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
        reservoir = (await upgrades.deployProxy(
            ReservoirFactory,
            [accessManager.target, pauseManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as ReservoirUSDC;

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(
            VaultFactory,
            [
                reservoir.target,
                accessManager.target,
                pauseManager.target,
                0,
                bob.address,
                0,
                carol.address,
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as Vault;
        vaultAddr = await vault.getAddress();

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [accessManager.target, pauseManager.target, usdcTotalSupply],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC, vault.target],
            }
        )) as unknown as MZUSD;
        mzusdAddr = await mzusd.getAddress();

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
                pauseManager.target,
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [false],
            }
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
                pauseManager.target,
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [false],
            }
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
                pauseManager.target,
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [false],
            }
        )) as unknown as Tranche;

        juniorAddr = await junior.getAddress();
        mezzanineAddr = await mezzanine.getAddress();
        seniorAddr = await senior.getAddress();

        // Deploy POL Junior tranche
        const PolFactory = await ethers.getContractFactory("PolJuniorTranche", deployer);
        pol = (await upgrades.deployProxy(
            PolFactory,
            [
                mzusd.target,
                "POL Junior Tranche",
                "pJLT",
                accessManager.target,
                pauseManager.target,
                bob.address,
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as PolJuniorTranche;
        polAddr = await pol.getAddress();

        // Deploy LossManager
        const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
        lossManager = (await upgrades.deployProxy(
            LossManagerFactory,
            [
                accessManager.target,
                pauseManager.target,
                mzusdAddr,
                vaultAddr,
                [juniorAddr, mezzanineAddr, seniorAddr],
                [0, 0, 0],
                0, // maxLossPerTxUSDC (0 = no limit)
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as LossManager;
        lossManagerAddr = await lossManager.getAddress();

        // Roles setup
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const setLossManagerSel = mzusd.interface.getFunction("setLossManager").selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [setLossManagerSel], ADMIN_ROLE);
        await mzusd.setLossManager(lossManagerAddr);
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        const polWithdrawSel = pol.interface.getFunction("withdraw").selector;
        const polRedeemSel = pol.interface.getFunction("redeem").selector;

        await accessManager.setTargetFunctionRole(
            polAddr,
            [polWithdrawSel, polRedeemSel],
            ADMIN_ROLE
        );

        // admin: vault distribute + tranche management + epoch config (for integration test)
        const setMZUSDSel = vault.interface.getFunction("setMZUSD").selector;
        const distributeSel = vault.interface.getFunction("distributeYield").selector;
        const advanceEpochSel = vault.interface.getFunction("advanceEpoch").selector;
        const addTrancheSel = vault.interface.getFunction("addTranche").selector;
        const updateTrancheSel = vault.interface.getFunction("updateTranche").selector;
        const setEpochConfigSel = vault.interface.getFunction("setEpochConfig").selector;

        await accessManager.setTargetFunctionRole(
            vaultAddr,
            [setMZUSDSel, distributeSel, addTrancheSel, updateTrancheSel, setEpochConfigSel],
            ADMIN_ROLE
        );

        // LossManager must be able to advance epochs (applyLoss hard-fails otherwise)
        await accessManager.setTargetFunctionRole(vaultAddr, [advanceEpochSel], LOSS_MANAGER_ROLE);

        // admin: Tranche config/finalize functions (for tests/helpers)
        const tSetUnstakeDelaySel = junior.interface.getFunction("setUnstakeDelayEpochs").selector;
        const tSetDepositLimitsSel = junior.interface.getFunction("setDepositLimits").selector;
        await accessManager.setTargetFunctionRole(
            juniorAddr,
            [tSetUnstakeDelaySel, tSetDepositLimitsSel],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(
            mezzanineAddr,
            [tSetUnstakeDelaySel, tSetDepositLimitsSel],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(
            seniorAddr,
            [tSetUnstakeDelaySel, tSetDepositLimitsSel],
            ADMIN_ROLE
        );

        // LossManager admin functions
        const applyLossSel = lossManager.interface.getFunction("applyLoss").selector;
        const setOrderSel = lossManager.interface.getFunction("setTrancheOrderAndGroups").selector;
        const setMaxSel = lossManager.interface.getFunction("setMaxLossPerTxUSDC").selector;
        await accessManager.setTargetFunctionRole(
            lossManagerAddr,
            [applyLossSel, setOrderSel, setMaxSel],
            ADMIN_ROLE
        );

        // vault role: tranche.notifyYield
        await accessManager.grantRole(VAULT_ROLE, vaultAddr, 0);

        // loss manager role: Vault.advanceEpoch
        await accessManager.grantRole(LOSS_MANAGER_ROLE, lossManagerAddr, 0);

        // vault role: tranche.notifyYield
        const notifySel = junior.interface.getFunction("notifyYield").selector;
        await accessManager.setTargetFunctionRole(juniorAddr, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(mezzanineAddr, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(seniorAddr, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(polAddr, [notifySel], VAULT_ROLE);

        // wire and register
        await vault.setMZUSD(mzusdAddr);

        await vault.addTranche({tranche: juniorAddr, weightBps: 2000, enabled: true});
        await vault.addTranche({tranche: mezzanineAddr, weightBps: 3000, enabled: true});
        await vault.addTranche({tranche: seniorAddr, weightBps: 5000, enabled: true});

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusdAddr, usdcAmount6);
        await (await mzusd.connect(user).deposit(usdcAmount6)).wait();
        return await mzusd.balanceOf(user.address);
    }

    async function depositMZIntoTranche(user: any, tranche: any, mzAmount18: bigint) {
        const trancheAddr = await tranche.getAddress();
        await mzusd.connect(user).approve(trancheAddr, mzAmount18);
        await (await tranche.connect(user).deposit(mzAmount18, user.address)).wait();
    }

    function parseLossApplied(receipt: any) {
        const logs = receipt.logs ?? [];
        for (const l of logs) {
            try {
                const parsed = lossManager.interface.parseLog(l);
                if (parsed?.name === "LossApplied") return parsed;
                // eslint-disable-next-line no-empty
            } catch {}
        }
        return null;
    }

    function min(a: bigint, b: bigint): bigint {
        return a < b ? a : b;
    }

    it("Pauses protocol operations via PauseManager", async () => {
        await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);
        await expect(lossManager.connect(deployer).applyLoss(1n))
            .to.be.revertedWithCustomError(lossManager, "CategoryPaused")
            .withArgs(PauseCategory.PROTOCOL);
    });

    it("Pauses admin operations via PauseManager", async () => {
        await pauseManager.pauseGlobal(PauseCategory.ADMIN);
        await expect(
            lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups([juniorAddr, mezzanineAddr, seniorAddr], [0, 0, 0])
        )
            .to.be.revertedWithCustomError(lossManager, "CategoryPaused")
            .withArgs(PauseCategory.ADMIN);
        await expect(lossManager.connect(deployer).setMaxLossPerTxUSDC(1n))
            .to.be.revertedWithCustomError(lossManager, "CategoryPaused")
            .withArgs(PauseCategory.ADMIN);
    });

    // Mirrors LossManager pair split logic (floor + remainder to first tranche then second)
    function computePairBurns(lossMZ: bigint, tvl0: bigint, tvl1: bigint) {
        const pairTVL = tvl0 + tvl1;
        if (pairTVL === 0n) return {burn0: 0n, burn1: 0n, lossForPair: 0n};

        const lossForPair = min(lossMZ, pairTVL);

        let burn0 = tvl0 === 0n ? 0n : (lossForPair * tvl0) / pairTVL;
        if (burn0 > tvl0) burn0 = tvl0;

        let burn1 = tvl1 === 0n ? 0n : (lossForPair * tvl1) / pairTVL;
        if (burn1 > tvl1) burn1 = tvl1;

        let rem = lossForPair - (burn0 + burn1);
        if (rem !== 0n) {
            const cap0 = tvl0 - burn0;
            const add0 = min(cap0, rem);
            burn0 += add0;
            rem -= add0;
        }
        if (rem !== 0n) {
            const cap1 = tvl1 - burn1;
            const add1 = min(cap1, rem);
            burn1 += add1;
            rem -= add1;
        }

        return {burn0, burn1, lossForPair};
    }

    it("Reorder tranches repeatedly (applyLoss always burns correctly in the specified order)", async () => {
        // Big buffers so we can burn many times
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5000n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(5000n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(5000n)));

        // permutations
        const perms: string[][] = [
            [juniorAddr, mezzanineAddr, seniorAddr],
            [juniorAddr, seniorAddr, mezzanineAddr],
            [mezzanineAddr, juniorAddr, seniorAddr],
            [mezzanineAddr, seniorAddr, juniorAddr],
            [seniorAddr, juniorAddr, mezzanineAddr],
            [seniorAddr, mezzanineAddr, juniorAddr],
        ];

        // track expected balances
        const expected: Record<string, bigint> = {};
        expected[juniorAddr] = await mzusd.balanceOf(juniorAddr);
        expected[mezzanineAddr] = await mzusd.balanceOf(mezzanineAddr);
        expected[seniorAddr] = await mzusd.balanceOf(seniorAddr);

        const burnStep = to18(1n); // applyLoss(1 USDC) burns 1e18 mzUSD
        for (let i = 0; i < 24; i++) {
            const order: string[] = perms[i % perms.length];

            const tx1 = await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(order, new Array(order.length).fill(0));
            await tx1.wait();

            await time.increase(DAY);
            const tx2 = await lossManager.connect(deployer).applyLoss(to6(1n));
            const receipt2 = await tx2.wait();

            // expected burn only from first tranche (they all have enough TVL)
            expected[order[0]] -= burnStep;

            expect(await mzusd.balanceOf(juniorAddr)).to.equal(expected[juniorAddr]);
            expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(expected[mezzanineAddr]);
            expect(await mzusd.balanceOf(seniorAddr)).to.equal(expected[seniorAddr]);

            // Event should reflect the current order and cuts
            const parsed = parseLossApplied(receipt2);
            expect(parsed).to.not.equal(null);

            const usdcLoss = parsed!.args.usdcLoss as bigint;
            const lossMZ = parsed!.args.lossMZ as bigint;
            const tranchesArr = parsed!.args.tranches as string[];
            const cuts = parsed!.args.cutsMZ as bigint[];

            expect(usdcLoss).to.equal(to6(1n));
            expect(lossMZ).to.equal(to18(1n));
            expect(tranchesArr).to.deep.equal(order);
            expect(cuts.length).to.equal(3);
            expect(cuts[0]).to.equal(to18(1n));
            expect(cuts[1]).to.equal(0n);
            expect(cuts[2]).to.equal(0n);
        }
    });

    it("Should burn correctly (burns across tranches by order, and after order change burns by new order)", async () => {
        // Smaller amounts to force multi-tranche burning
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(7n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(9n)));

        // Order: [junior, mezz, senior]
        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups([juniorAddr, mezzanineAddr, seniorAddr], [0, 0, 0])
        ).wait();

        const j0 = await mzusd.balanceOf(juniorAddr);
        const m0 = await mzusd.balanceOf(mezzanineAddr);
        const s0 = await mzusd.balanceOf(seniorAddr);

        await time.increase(DAY);
        // Apply loss = 10 USDC -> burn 10e18: junior(5) + mezz(5)
        await (await lossManager.connect(deployer).applyLoss(to6(10n))).wait();

        expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0 - to18(5n));
        expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(m0 - to18(5n));
        expect(await mzusd.balanceOf(seniorAddr)).to.equal(s0);

        // Change order: [senior, mezz, junior]
        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups([seniorAddr, mezzanineAddr, juniorAddr], [0, 0, 0])
        ).wait();

        const j1 = await mzusd.balanceOf(juniorAddr);
        const m1 = await mzusd.balanceOf(mezzanineAddr);
        const s1 = await mzusd.balanceOf(seniorAddr);

        await time.increase(DAY);
        // Apply loss = 11 USDC -> burn 11e18: senior burns 9, remaining 2 burns from mezz (mezz has 2 left after the first loss)
        await (await lossManager.connect(deployer).applyLoss(to6(11n))).wait();

        expect(await mzusd.balanceOf(seniorAddr)).to.equal(s1 - to18(9n));
        expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(m1 - to18(2n));
        expect(await mzusd.balanceOf(juniorAddr)).to.equal(j1);
    });

    it("Integration (deposits + vault distributeYield (streaming) + applyLoss)", async () => {
        // 1) Deposit principal into each tranche (100 each)
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(100n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(100n)));

        // 2) Advance epoch and distribute yield (starts streaming on each tranche)
        await time.increase(DAY);
        const reported = to6(30n); // 30 MZUSD total (1:1)
        await (await vault.connect(deployer).distributeYield(reported)).wait();

        // At t=0 of stream: totalAssets should still be equal to principal (yield is fully unaccrued)
        expect(await junior.totalAssets()).to.equal(to18(100n));
        expect(await mezzanine.totalAssets()).to.equal(to18(100n));
        expect(await senior.totalAssets()).to.equal(to18(100n));

        // 3) Apply loss while stream is active.
        // Order defaults: [junior, mezzanine, senior]
        // Loss = 180 -> burns junior(100 + 1s accrued) + mezz(remaining), leaves senior untouched
        const jBalBefore = await mzusd.balanceOf(juniorAddr);
        const mBalBefore = await mzusd.balanceOf(mezzanineAddr);
        const sBalBefore = await mzusd.balanceOf(seniorAddr);
        const duration = await vault.epochDuration();

        // applyLoss advances epoch internally -> make it allowed
        await time.increase(duration);

        // execute applyLoss at streamStart + duration + 1 (yield fully accrued)
        const streamStart = await junior.yieldStreamStart();
        await time.setNextBlockTimestamp(Number(streamStart + duration + 1n));

        const lossMZ = to18(180n);
        const juniorYield = await junior.yieldStreamingAmount();
        const accruedJunior = juniorYield; // full accrual at end+1s

        const expectedJuniorBurn = to18(100n) + accruedJunior;
        const remainingAfterJunior = lossMZ - expectedJuniorBurn;

        await (await lossManager.connect(deployer).applyLoss(to6(180n))).wait();

        const jBalAfter = await mzusd.balanceOf(juniorAddr);
        const mBalAfter = await mzusd.balanceOf(mezzanineAddr);
        const sBalAfter = await mzusd.balanceOf(seniorAddr);

        expect(jBalBefore - jBalAfter).to.equal(expectedJuniorBurn);
        expect(mBalBefore - mBalAfter).to.equal(remainingAfterJunior);
        expect(sBalAfter).to.equal(sBalBefore);

        // Immediately after loss, junior virtual NAV should become 0 (because balance = unaccrued yield)
        expect(await junior.totalAssets()).to.equal(0n);

        // No further streaming in this epoch; ensure getters remain stable (no underflows)
        await time.increase(duration / 2n);
        expect(await junior.totalAssets()).to.equal(0n);
        expect(await mezzanine.totalAssets()).to.be.gt(0n);
        expect(await senior.totalAssets()).to.be.gt(0n);
    });

    it("Revert InsufficientCover if total cover is not enough", async () => {
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n))); // only 10 total
        await time.increase(DAY);
        await expect(
            lossManager.connect(deployer).applyLoss(to6(11n))
        ).to.be.revertedWithCustomError(lossManager, "InsufficientCover");
    });

    it("Reverts in setTrancheOrderAndGroups + applyLoss zero", async () => {
        await expect(
            lossManager.connect(deployer).setTrancheOrderAndGroups([], [])
        ).to.be.revertedWithCustomError(lossManager, "ZeroLength");

        await expect(
            lossManager.connect(deployer).setTrancheOrderAndGroups([juniorAddr], [])
        ).to.be.revertedWithCustomError(lossManager, "LengthMismatch");

        await expect(
            lossManager.connect(deployer).setTrancheOrderAndGroups([ethers.ZeroAddress], [0])
        ).to.be.revertedWithCustomError(lossManager, "ZeroAddress");

        await expect(lossManager.connect(deployer).applyLoss(0)).to.be.revertedWithCustomError(
            lossManager,
            "ZeroAmount"
        );
    });

    it("Reverts on duplicate tranche in order", async () => {
        await expect(
            lossManager.connect(deployer).setTrancheOrderAndGroups([juniorAddr, juniorAddr], [0, 0])
        ).to.be.revertedWithCustomError(lossManager, "DuplicateTranche");
    });

    it("Reverts when group id is reused across pairs", async () => {
        await expect(
            lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                    [1, 1, 1, 1]
                )
        ).to.be.revertedWithCustomError(lossManager, "GroupIdAlreadyAssigned");
    });

    it("Reverts when group id has no adjacent pair at the end", async () => {
        await expect(
            lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups([juniorAddr, polAddr, mezzanineAddr], [0, 0, 1])
        ).to.be.revertedWithCustomError(lossManager, "GroupNotContiguous");
    });

    it("Clears previous groups on reconfiguration", async () => {
        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                    [9, 9, 0, 0]
                )
        ).wait();

        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                    [0, 0, 0, 0]
                )
        ).wait();

        expect(await lossManager.trancheGroup(juniorAddr)).to.equal(0n);
        expect(await lossManager.trancheGroup(polAddr)).to.equal(0n);
    });

    it("Enforces maxLossPerTxUSDC", async () => {
        await (await lossManager.connect(deployer).setMaxLossPerTxUSDC(to6(5n))).wait();

        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));

        await expect(
            lossManager.connect(deployer).applyLoss(to6(6n))
        ).to.be.revertedWithCustomError(lossManager, "LimitExceeded");
    });

    it("Pair-mode: proportional loss across [Junior, POL Junior] when contiguous and same tranche group", async () => {
        // deposit: junior = 100, pol = 300
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));
        await depositMZIntoTranche(alice, pol, await mintMZUSDFor(alice, to6(300n)));

        // order: [junior, pol, mezz, senior]
        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                    [1, 1, 0, 0]
                )
        ).wait();

        const j0 = await mzusd.balanceOf(juniorAddr);
        const p0 = await mzusd.balanceOf(polAddr);

        // loss 40 -> split 1:3 -> 10 and 30
        await time.increase(DAY);
        await (await lossManager.connect(deployer).applyLoss(to6(40n))).wait();

        expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0 - to18(10n));
        expect(await mzusd.balanceOf(polAddr)).to.equal(p0 - to18(30n));
    });

    it("Pair-mode burns full TVL when loss equals pair TVL", async () => {
        const jDeposit = await mintMZUSDFor(alice, to6(100n));
        await depositMZIntoTranche(alice, junior, jDeposit);

        const pDeposit = await mintMZUSDFor(alice, to6(300n));
        await depositMZIntoTranche(alice, pol, pDeposit);

        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                    [2, 2, 0, 0]
                )
        ).wait();

        const jTvl = await junior.totalAssets();
        const pTvl = await pol.totalAssets();

        const j0 = await mzusd.balanceOf(juniorAddr);
        const p0 = await mzusd.balanceOf(polAddr);

        await time.increase(DAY);
        await (await lossManager.connect(deployer).applyLoss(to6(400n))).wait();

        expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0 - jTvl);
        expect(await mzusd.balanceOf(polAddr)).to.equal(p0 - pTvl);
        expect(await mzusd.balanceOf(juniorAddr)).to.equal(0n);
        expect(await mzusd.balanceOf(polAddr)).to.equal(0n);
    });

    it("Pair-mode burns only from the tranche with TVL", async () => {
        await depositMZIntoTranche(alice, pol, await mintMZUSDFor(alice, to6(50n)));

        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                    [3, 3, 0, 0]
                )
        ).wait();

        const j0 = await mzusd.balanceOf(juniorAddr);
        const p0 = await mzusd.balanceOf(polAddr);

        await time.increase(DAY);
        await (await lossManager.connect(deployer).applyLoss(to6(10n))).wait();

        expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0);
        expect(await mzusd.balanceOf(polAddr)).to.equal(p0 - to18(10n));
    });

    it("Pair-mode passes remainder to the next tranche", async () => {
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));
        await depositMZIntoTranche(alice, pol, await mintMZUSDFor(alice, to6(5n)));
        await depositMZIntoTranche(alice, mezzanine, await mintMZUSDFor(alice, to6(20n)));

        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                    [4, 4, 0, 0]
                )
        ).wait();

        const j0 = await mzusd.balanceOf(juniorAddr);
        const p0 = await mzusd.balanceOf(polAddr);
        const m0 = await mzusd.balanceOf(mezzanineAddr);

        await time.increase(DAY);
        await (await lossManager.connect(deployer).applyLoss(to6(15n))).wait();

        expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0 - to18(5n));
        expect(await mzusd.balanceOf(polAddr)).to.equal(p0 - to18(5n));
        expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(m0 - to18(5n));
    });

    it("Pair mode burns match expected proportional split (30 iterations)", async () => {
        // Big buffers
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10_000n)));
        await depositMZIntoTranche(alice, pol, await mintMZUSDFor(alice, to6(30_000n)));

        // Put pair first
        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                    [1, 1, 0, 0]
                )
        ).wait();

        const mStart = await mzusd.balanceOf(mezzanineAddr);
        const sStart = await mzusd.balanceOf(seniorAddr);

        for (let k = 1; k <= 30; k++) {
            const lossUSDC = BigInt((k % 97) + 1); // 1 - 97
            const lossMZ = to18(lossUSDC);

            const jTvl = await junior.totalAssets();
            const pTvl = await pol.totalAssets();

            const jBal0 = await mzusd.balanceOf(juniorAddr);
            const pBal0 = await mzusd.balanceOf(polAddr);

            const {burn0, burn1, lossForPair} = computePairBurns(lossMZ, jTvl, pTvl);
            await time.increase(DAY);
            await (await lossManager.connect(deployer).applyLoss(to6(lossUSDC))).wait();

            expect(await mzusd.balanceOf(juniorAddr)).to.equal(jBal0 - burn0);
            expect(await mzusd.balanceOf(polAddr)).to.equal(pBal0 - burn1);
            expect(burn0 + burn1).to.equal(lossForPair);

            // untouched (pair always covers)
            expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(mStart);
            expect(await mzusd.balanceOf(seniorAddr)).to.equal(sStart);
        }
    });

    it("Pair-mode works when pair is not first (sequential then proportional)", async () => {
        // Setup TVL: mezz small, then pair big
        await depositMZIntoTranche(alice, mezzanine, await mintMZUSDFor(alice, to6(200n)));
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));
        await depositMZIntoTranche(alice, pol, await mintMZUSDFor(alice, to6(300n)));

        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [mezzanineAddr, juniorAddr, polAddr, seniorAddr],
                    [0, 7, 7, 0]
                )
        ).wait();

        for (let k = 1; k <= 20; k++) {
            const lossUSDC = 5n + BigInt(k); // 6..25
            const lossMZ = to18(lossUSDC);

            const mTvl = await mezzanine.totalAssets();
            const jTvl = await junior.totalAssets();
            const pTvl = await pol.totalAssets();

            const mBal0 = await mzusd.balanceOf(mezzanineAddr);
            const jBal0 = await mzusd.balanceOf(juniorAddr);
            const pBal0 = await mzusd.balanceOf(polAddr);

            const burnMezz = min(mTvl, lossMZ);
            const remaining = lossMZ - burnMezz;

            const {burn0, burn1} = computePairBurns(remaining, jTvl, pTvl);

            await time.increase(DAY);
            await (await lossManager.connect(deployer).applyLoss(to6(lossUSDC))).wait();

            expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(mBal0 - burnMezz);
            expect(await mzusd.balanceOf(juniorAddr)).to.equal(jBal0 - burn0);
            expect(await mzusd.balanceOf(polAddr)).to.equal(pBal0 - burn1);
        }
    });

    it("Group Id set but NOT contiguous -> reverts in setTrancheOrderAndGroups", async () => {
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));
        await depositMZIntoTranche(alice, pol, await mintMZUSDFor(alice, to6(300n)));
        await depositMZIntoTranche(alice, mezzanine, await mintMZUSDFor(alice, to6(100n)));

        // Not contiguous: junior, mezz, pol, senior
        await expect(
            lossManager
                .connect(deployer)
                .setTrancheOrderAndGroups(
                    [juniorAddr, mezzanineAddr, polAddr, seniorAddr],
                    [1, 0, 1, 0]
                )
        ).to.be.revertedWithCustomError(lossManager, "GroupNotContiguous");
    });
});
