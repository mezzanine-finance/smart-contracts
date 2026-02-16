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

const LOSS_MANAGER_ROLE = 3n;
const BURNER_ROLE = 5n;

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
    let navOracleRef: any;
    let navOracleSigner: any;

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

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [accessManager.target, pauseManager.target, usdcTotalSupply],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;
        mzusdAddr = await mzusd.getAddress();

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, carol.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusdAddr, reservoir.target],
        })) as unknown as Vault;
        vaultAddr = await vault.getAddress();

        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);

        junior = (await upgrades.deployProxy(TrancheFactory, [1, 0, "Junior Tranche", "JLT"], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target, false],
        })) as unknown as Tranche;

        mezzanine = (await upgrades.deployProxy(
            TrancheFactory,
            [2, 0, "Mezzanine Tranche", "MLT"],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [vault.target, false],
            }
        )) as unknown as Tranche;

        senior = (await upgrades.deployProxy(TrancheFactory, [3, 0, "Senior Tranche", "sMZUSD"], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target, false],
        })) as unknown as Tranche;

        juniorAddr = await junior.getAddress();
        mezzanineAddr = await mezzanine.getAddress();
        seniorAddr = await senior.getAddress();

        // Deploy POL Junior tranche
        const PolFactory = await ethers.getContractFactory("PolJuniorTranche", deployer);
        pol = (await upgrades.deployProxy(PolFactory, [bob.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target],
        })) as unknown as PolJuniorTranche;
        polAddr = await pol.getAddress();

        // Deploy LossManager
        const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
        lossManager = (await upgrades.deployProxy(
            LossManagerFactory,
            [
                [juniorAddr, mezzanineAddr, seniorAddr],
                [false, false, false],
                0, // maxLossPerTxUSDC (0 = no limit)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [vaultAddr],
            }
        )) as unknown as LossManager;
        lossManagerAddr = await lossManager.getAddress();

        const MockNavOracleFactory = await ethers.getContractFactory(
            "MockNavOracleAutomationRef",
            deployer
        );
        navOracleRef = await MockNavOracleFactory.deploy(vaultAddr, lossManagerAddr, mzusdAddr);
        await navOracleRef.waitForDeployment();
        navOracleSigner = await imp(navOracleRef.target as string);

        // Roles setup
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const setVaultSel = mzusd.interface.getFunction("setVault").selector;
        const burnSel = mzusd.interface.getFunction("burn").selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [setVaultSel], ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(mzusdAddr, [burnSel], BURNER_ROLE);
        await mzusd.setVault(vaultAddr);
        await accessManager.grantRole(BURNER_ROLE, juniorAddr, 0);
        await accessManager.grantRole(BURNER_ROLE, mezzanineAddr, 0);
        await accessManager.grantRole(BURNER_ROLE, seniorAddr, 0);
        await accessManager.grantRole(BURNER_ROLE, polAddr, 0);
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        const polWithdrawSel = pol.interface.getFunction("withdraw").selector;

        await accessManager.setTargetFunctionRole(polAddr, [polWithdrawSel], ADMIN_ROLE);

        // admin: vault distribute + tranche management + epoch config (for integration test)
        const distributeSel = vault.interface.getFunction("distributeYield").selector;
        const advanceEpochSel = vault.interface.getFunction("advanceEpoch").selector;
        const addTrancheSel = vault.interface.getFunction("addTranche").selector;
        const setYieldDistributionSel =
            vault.interface.getFunction("setYieldDistribution").selector;
        const setEpochConfigSel = vault.interface.getFunction("setEpochConfig").selector;
        const setVaultLossManagerSel = vault.interface.getFunction("setLossManager").selector;
        const setVaultNavOracleSel = vault.interface.getFunction("setNavOracle").selector;

        await accessManager.setTargetFunctionRole(
            vaultAddr,
            [
                distributeSel,
                addTrancheSel,
                setYieldDistributionSel,
                setEpochConfigSel,
                setVaultLossManagerSel,
                setVaultNavOracleSel,
            ],
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
        const setOrderSel = lossManager.interface.getFunction("setTrancheOrderAndPairs").selector;
        const setMaxSel = lossManager.interface.getFunction("setMaxLossPerTxUSDC").selector;
        await accessManager.setTargetFunctionRole(
            lossManagerAddr,
            [applyLossSel, setOrderSel, setMaxSel],
            ADMIN_ROLE
        );

        // loss manager role: Vault.advanceEpoch
        await accessManager.grantRole(LOSS_MANAGER_ROLE, lossManagerAddr, 0);

        // wire and register
        await vault.setLossManager(lossManagerAddr);
        await vault.setNavOracle(navOracleRef.target);

        await vault.addTranche(juniorAddr);
        await vault.addTranche(mezzanineAddr);
        await vault.addTranche(seniorAddr);
        // Configure yield distribution: junior=20%, mezzanine=30%, senior=50% risk premium
        await vault.setYieldDistribution(0, [2000, 3000, 5000], [true, true, true]);

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

    async function depositMZIntoPol(mzAmount18: bigint) {
        await (await mzusd.connect(deployer).transfer(polAddr, mzAmount18)).wait();
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

    async function applyLossAndCapture(order: string[], usdcLoss6: bigint) {
        const balancesBefore = await Promise.all(order.map((tranche) => mzusd.balanceOf(tranche)));

        const tx = await lossManager.connect(navOracleSigner).applyLoss(usdcLoss6);
        const receipt = await tx.wait();
        const parsed = parseLossApplied(receipt);
        expect(parsed).to.not.equal(null);
        if (parsed === null) throw new Error("LossApplied event not found");

        const balancesAfter = await Promise.all(order.map((tranche) => mzusd.balanceOf(tranche)));
        const cuts = balancesBefore.map((before, i) => before - balancesAfter[i]);

        return {parsed, cuts};
    }

    function min(a: bigint, b: bigint): bigint {
        return a < b ? a : b;
    }

    describe("Pause guards", () => {
        it("Pauses protocol operations via PauseManager", async () => {
            await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);
            await expect(lossManager.connect(navOracleSigner).applyLoss(1n))
                .to.be.revertedWithCustomError(lossManager, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
        });

        it("Pauses admin operations via PauseManager", async () => {
            await pauseManager.pauseGlobal(PauseCategory.ADMIN);
            await expect(
                lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, mezzanineAddr, seniorAddr],
                        [false, false, false]
                    )
            )
                .to.be.revertedWithCustomError(lossManager, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(lossManager.connect(deployer).setMaxLossPerTxUSDC(1n))
                .to.be.revertedWithCustomError(lossManager, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
        });
    });

    describe("Initialization and views", () => {
        it("Exposes tranche order and pair flags", async () => {
            const len = await lossManager.trancheOrderLength();
            expect(len).to.equal(3n);

            const order = await lossManager.getTrancheOrder();
            expect(order).to.deep.equal([juniorAddr, mezzanineAddr, seniorAddr]);

            const [order2, pairFlags] = await lossManager.getTrancheOrderAndPairs();
            expect(order2).to.deep.equal([juniorAddr, mezzanineAddr, seniorAddr]);
            expect(pairFlags).to.deep.equal([false, false, false]);
        });

        it("Reverts on zero vault address during initialization", async () => {
            const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
            await expect(
                upgrades.deployProxy(LossManagerFactory, [[juniorAddr], [false], 0], {
                    kind: "uups",
                    initializer: "initialize",
                    unsafeAllow: ["constructor", "state-variable-immutable"],
                    constructorArgs: [ethers.ZeroAddress],
                })
            ).to.be.reverted;
        });
    });

    describe("Burn access", () => {
        it("Only LossManager can call tranche burnMZUSD", async () => {
            await expect(junior.connect(deployer).burnMZUSD(1n)).to.be.revertedWithCustomError(
                junior,
                "NotLossManager"
            );
            await expect(pol.connect(deployer).burnMZUSD(1n)).to.be.revertedWithCustomError(
                pol,
                "NotLossManager"
            );
        });
    });

    describe("Loss application flows", () => {
        it("applyLoss burns MZUSD supply via tranche burn", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n)));

            await time.increase(DAY);
            const supplyBefore = await mzusd.totalSupply();

            await (await lossManager.connect(navOracleSigner).applyLoss(to6(1n))).wait();

            const supplyAfter = await mzusd.totalSupply();
            expect(supplyBefore - supplyAfter).to.equal(to18(1n));
        });

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
                    .setTrancheOrderAndPairs(order, new Array(order.length).fill(false));
                await tx1.wait();

                await time.increase(DAY);
                const {parsed, cuts} = await applyLossAndCapture(order, to6(1n));

                // expected burn only from first tranche (they all have enough TVL)
                expected[order[0]] -= burnStep;

                expect(await mzusd.balanceOf(juniorAddr)).to.equal(expected[juniorAddr]);
                expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(expected[mezzanineAddr]);
                expect(await mzusd.balanceOf(seniorAddr)).to.equal(expected[seniorAddr]);

                const usdcLoss = parsed.args.usdcLoss;
                const requestedMZ = parsed.args.requestedMZ;
                const burnedMZ = parsed.args.burnedMZ;
                const uncoveredMZ = parsed.args.uncoveredMZ;

                expect(usdcLoss).to.equal(to6(1n));
                expect(requestedMZ).to.equal(to18(1n));
                expect(burnedMZ).to.equal(to18(1n));
                expect(uncoveredMZ).to.equal(0n);
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
                    .setTrancheOrderAndPairs(
                        [juniorAddr, mezzanineAddr, seniorAddr],
                        [false, false, false]
                    )
            ).wait();

            const j0 = await mzusd.balanceOf(juniorAddr);
            const m0 = await mzusd.balanceOf(mezzanineAddr);
            const s0 = await mzusd.balanceOf(seniorAddr);

            await time.increase(DAY);
            // Apply loss = 10 USDC -> burn 10e18: junior(5) + mezz(5)
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(10n))).wait();

            expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0 - to18(5n));
            expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(m0 - to18(5n));
            expect(await mzusd.balanceOf(seniorAddr)).to.equal(s0);

            // Change order: [senior, mezz, junior]
            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [seniorAddr, mezzanineAddr, juniorAddr],
                        [false, false, false]
                    )
            ).wait();

            const j1 = await mzusd.balanceOf(juniorAddr);
            const m1 = await mzusd.balanceOf(mezzanineAddr);
            const s1 = await mzusd.balanceOf(seniorAddr);

            await time.increase(DAY);
            // Apply loss = 11 USDC -> burn 11e18: senior burns 9, remaining 2 burns from mezz (mezz has 2 left after the first loss)
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(11n))).wait();

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
            await (await vault.connect(navOracleSigner).distributeYield(reported)).wait();

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

            await (await lossManager.connect(navOracleSigner).applyLoss(to6(180n))).wait();

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

        it("Applies loss while shares are pending under umbrella", async () => {
            const depositMZ = await mintMZUSDFor(alice, to6(100n));
            await depositMZIntoTranche(alice, junior, depositMZ);

            const epochId = await vault.currentEpochId();
            const pendingShares = await junior.balanceOf(alice.address);
            await (await junior.connect(alice).requestWithdrawal(pendingShares)).wait();

            await time.increase(DAY);
            const epochBefore = await vault.currentEpochId();
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(40n))).wait();
            const epochAfter = await vault.currentEpochId();
            expect(epochAfter).to.equal(epochBefore + 1n);

            const expectedRemaining = to18(100n) - to18(40n);
            expect(await junior.totalAssets()).to.equal(expectedRemaining);

            await (await junior.connect(deployer).finalizeEpoch(epochId)).wait();
            const [, , totalShares, totalAssets] = await junior.getEpochInfo(epochId);
            expect(totalShares).to.equal(pendingShares);
            expect(totalAssets).to.equal(expectedRemaining);

            const before = await mzusd.balanceOf(alice.address);
            await (await junior.connect(alice).claim(epochId)).wait();
            const after = await mzusd.balanceOf(alice.address);
            expect(after - before).to.equal(expectedRemaining);
        });

        it("Reverts when applyLoss is called twice within the same epoch", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));

            await time.increase(DAY);
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(1n))).wait();

            await expect(
                lossManager.connect(navOracleSigner).applyLoss(to6(1n))
            ).to.be.revertedWithCustomError(vault, "EpochTooSoon");
        });

        it("Does not burn finalized umbrella reserves", async () => {
            await lossManager.setTrancheOrderAndPairs([juniorAddr], [false]);

            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));

            const epochAtRequest = await vault.currentEpochId();
            const sharesToWithdraw = await junior.previewWithdraw(to18(60n));
            await junior.connect(alice).requestWithdrawal(sharesToWithdraw);

            await time.increase(DAY);
            await vault.connect(navOracleSigner).distributeYield(0);

            await junior.connect(deployer).finalizeEpoch(epochAtRequest);

            await time.increase(DAY);
            await lossManager.connect(navOracleSigner).applyLoss(to6(40n));

            const balBefore = await mzusd.balanceOf(alice.address);
            await junior.connect(alice).claim(epochAtRequest);
            const balAfter = await mzusd.balanceOf(alice.address);

            expect(balAfter - balBefore).to.equal(to18(60n));
        });

        it("Accumulates uncovered when loss exceeds non-reserved assets", async () => {
            await lossManager.setTrancheOrderAndPairs([juniorAddr], [false]);

            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));

            const epochAtRequest = await vault.currentEpochId();
            const sharesToWithdraw = await junior.previewWithdraw(to18(60n));
            await junior.connect(alice).requestWithdrawal(sharesToWithdraw);

            await time.increase(DAY);
            await vault.connect(navOracleSigner).distributeYield(0);
            await junior.connect(deployer).finalizeEpoch(epochAtRequest);

            await time.increase(DAY);
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(41n))).wait();

            expect(await lossManager.lastUncoveredLossMZ()).to.equal(to18(1n));
            expect(await lossManager.totalUncoveredLossMZ()).to.equal(to18(1n));

            const balBefore = await mzusd.balanceOf(alice.address);
            await junior.connect(alice).claim(epochAtRequest);
            const balAfter = await mzusd.balanceOf(alice.address);
            expect(balAfter - balBefore).to.equal(to18(60n));
        });

        it("Accumulates uncovered across epochs", async () => {
            await lossManager.setTrancheOrderAndPairs([juniorAddr], [false]);

            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));

            const epochAtRequest = await vault.currentEpochId();
            const sharesToWithdraw = await junior.previewWithdraw(to18(60n));
            await junior.connect(alice).requestWithdrawal(sharesToWithdraw);

            await time.increase(DAY);
            await vault.connect(navOracleSigner).distributeYield(0);
            await junior.connect(deployer).finalizeEpoch(epochAtRequest);

            await time.increase(DAY);
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(41n))).wait();
            expect(await lossManager.lastUncoveredLossMZ()).to.equal(to18(1n));
            expect(await lossManager.totalUncoveredLossMZ()).to.equal(to18(1n));

            await time.increase(DAY);
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(20n))).wait();
            expect(await lossManager.lastUncoveredLossMZ()).to.equal(to18(20n));
            expect(await lossManager.totalUncoveredLossMZ()).to.equal(to18(21n));
        });

        it("Burns all available across all tranches, then accumulates more debt when TVL is zero", async () => {
            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, mezzanineAddr, seniorAddr],
                        [false, false, false]
                    )
            ).wait();

            // Deposit 20 into each tranche, then reserve 10 via umbrella withdrawal.
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(20n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(20n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(20n)));

            const epochAtRequest = await vault.currentEpochId();
            await junior.connect(alice).requestWithdrawal(await junior.previewWithdraw(to18(10n)));
            await mezzanine
                .connect(bob)
                .requestWithdrawal(await mezzanine.previewWithdraw(to18(10n)));
            await senior.connect(carol).requestWithdrawal(await senior.previewWithdraw(to18(10n)));

            await time.increase(DAY);
            await vault.connect(navOracleSigner).distributeYield(0);
            await junior.connect(deployer).finalizeEpoch(epochAtRequest);
            await mezzanine.connect(deployer).finalizeEpoch(epochAtRequest);
            await senior.connect(deployer).finalizeEpoch(epochAtRequest);

            // 10 liquid in each tranche => total burnable 30.
            expect(await junior.totalAssets()).to.equal(to18(10n));
            expect(await mezzanine.totalAssets()).to.equal(to18(10n));
            expect(await senior.totalAssets()).to.equal(to18(10n));

            await time.increase(DAY);
            const {parsed: parsed1, cuts: cuts1} = await applyLossAndCapture(
                [juniorAddr, mezzanineAddr, seniorAddr],
                to6(35n)
            );
            expect(cuts1).to.deep.equal([to18(10n), to18(10n), to18(10n)]);
            expect(parsed1.args.uncoveredMZ).to.equal(to18(5n));
            expect(await lossManager.lastUncoveredLossMZ()).to.equal(to18(5n));
            expect(await lossManager.totalUncoveredLossMZ()).to.equal(to18(5n));

            // After first burn, only reserved balances remain => no liquid TVL.
            expect(await junior.totalAssets()).to.equal(0n);
            expect(await mezzanine.totalAssets()).to.equal(0n);
            expect(await senior.totalAssets()).to.equal(0n);

            await time.increase(DAY);
            const {parsed: parsed2, cuts: cuts2} = await applyLossAndCapture(
                [juniorAddr, mezzanineAddr, seniorAddr],
                to6(7n)
            );
            expect(cuts2).to.deep.equal([0n, 0n, 0n]);
            expect(parsed2.args.burnedMZ).to.equal(0n);
            expect(parsed2.args.uncoveredMZ).to.equal(to18(7n));
            expect(await lossManager.lastUncoveredLossMZ()).to.equal(to18(7n));
            expect(await lossManager.totalUncoveredLossMZ()).to.equal(to18(12n));
        });

        it("Production order pair drains all tranches and next loss accumulates pure debt", async () => {
            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [polAddr, juniorAddr, mezzanineAddr, seniorAddr],
                        [true, true, false, false]
                    )
            ).wait();

            // Keep non-tranche supply so sanity check (loss <= totalSupply) still allows second loss.
            await mintMZUSDFor(carol, to6(100n));

            // Tranche TVL: POL=10, Junior=10, Mezz=10, Senior=10 => total burnable 40.
            await depositMZIntoPol(await mintMZUSDFor(deployer, to6(10n)));
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(10n)));
            await depositMZIntoTranche(deployer, senior, await mintMZUSDFor(deployer, to6(10n)));

            expect(await pol.totalAssets()).to.equal(to18(10n));
            expect(await junior.totalAssets()).to.equal(to18(10n));
            expect(await mezzanine.totalAssets()).to.equal(to18(10n));
            expect(await senior.totalAssets()).to.equal(to18(10n));

            // First loss exceeds aggregate tranche TVL by 5.
            await time.increase(DAY);
            const {parsed: parsed1, cuts: cuts1} = await applyLossAndCapture(
                [polAddr, juniorAddr, mezzanineAddr, seniorAddr],
                to6(45n)
            );
            expect(cuts1).to.deep.equal([to18(10n), to18(10n), to18(10n), to18(10n)]);
            expect(parsed1.args.burnedMZ).to.equal(to18(40n));
            expect(parsed1.args.uncoveredMZ).to.equal(to18(5n));
            expect(await lossManager.lastUncoveredLossMZ()).to.equal(to18(5n));
            expect(await lossManager.totalUncoveredLossMZ()).to.equal(to18(5n));

            // All tranches fully drained.
            expect(await pol.totalAssets()).to.equal(0n);
            expect(await junior.totalAssets()).to.equal(0n);
            expect(await mezzanine.totalAssets()).to.equal(0n);
            expect(await senior.totalAssets()).to.equal(0n);

            // Second loss with zero tranche TVL should produce pure uncovered debt.
            await time.increase(DAY);
            const {parsed: parsed2, cuts: cuts2} = await applyLossAndCapture(
                [polAddr, juniorAddr, mezzanineAddr, seniorAddr],
                to6(7n)
            );
            expect(cuts2).to.deep.equal([0n, 0n, 0n, 0n]);
            expect(parsed2.args.burnedMZ).to.equal(0n);
            expect(parsed2.args.uncoveredMZ).to.equal(to18(7n));
            expect(await lossManager.lastUncoveredLossMZ()).to.equal(to18(7n));
            expect(await lossManager.totalUncoveredLossMZ()).to.equal(to18(12n));
        });

        it("Reverts when loss exceeds total supply sanity bound", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n))); // only 10 total
            await time.increase(DAY);
            await expect(lossManager.connect(navOracleSigner).applyLoss(to6(11n)))
                .to.be.revertedWithCustomError(lossManager, "LossExceedsTotalSupply")
                .withArgs(to6(11n), to6(10n));
        });
    });
    describe("Order configuration validation", () => {
        it("Reverts in setTrancheOrderAndPairs + applyLoss zero", async () => {
            await expect(
                lossManager.connect(deployer).setTrancheOrderAndPairs([], [])
            ).to.be.revertedWithCustomError(lossManager, "ZeroLength");

            await expect(
                lossManager.connect(deployer).setTrancheOrderAndPairs([juniorAddr], [])
            ).to.be.revertedWithCustomError(lossManager, "LengthMismatch");

            await expect(
                lossManager.connect(deployer).setTrancheOrderAndPairs([ethers.ZeroAddress], [false])
            ).to.be.revertedWithCustomError(lossManager, "ZeroAddress");

            await expect(
                lossManager.connect(navOracleSigner).applyLoss(0)
            ).to.be.revertedWithCustomError(lossManager, "ZeroAmount");
        });

        it("Reverts on duplicate tranche in order", async () => {
            await expect(
                lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs([juniorAddr, juniorAddr], [false, false])
            ).to.be.revertedWithCustomError(lossManager, "DuplicateTranche");
        });

        it("Reverts when pair flags are malformed", async () => {
            await expect(
                lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                        [true, false, true, false]
                    )
            ).to.be.revertedWithCustomError(lossManager, "PairNotContiguous");
        });

        it("Reverts when pair flag has no adjacent pair at the end", async () => {
            await expect(
                lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, polAddr, mezzanineAddr],
                        [false, false, true]
                    )
            ).to.be.revertedWithCustomError(lossManager, "PairNotContiguous");
        });

        it("Clears previous pairs on reconfiguration", async () => {
            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                        [true, true, false, false]
                    )
            ).wait();

            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                        [false, false, false, false]
                    )
            ).wait();

            expect(await lossManager.tranchePairedTo(juniorAddr)).to.equal(ethers.ZeroAddress);
            expect(await lossManager.tranchePairedTo(polAddr)).to.equal(ethers.ZeroAddress);
        });
    });

    describe("Limits", () => {
        it("Enforces maxLossPerTxUSDC", async () => {
            await (await lossManager.connect(deployer).setMaxLossPerTxUSDC(to6(5n))).wait();

            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));

            await expect(
                lossManager.connect(navOracleSigner).applyLoss(to6(6n))
            ).to.be.revertedWithCustomError(lossManager, "LimitExceeded");
        });
    });

    describe("Pair mode", () => {
        it("Pair-mode never over-burns tranche TVL in rounding-heavy sequence", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(7n)));
            await depositMZIntoPol(await mintMZUSDFor(deployer, to6(11n)));

            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs([juniorAddr, polAddr], [true, true])
            ).wait();

            const requestedLossesUSDC = [1n, 2n, 1n, 2n, 3n, 1n, 4n, 1n, 1n, 2n];
            for (const requested of requestedLossesUSDC) {
                const jTvlBefore = await junior.totalAssets();
                const pTvlBefore = await pol.totalAssets();
                const pairTVLBefore = jTvlBefore + pTvlBefore;
                if (pairTVLBefore === 0n) break;

                const pairUSDCWhole = pairTVLBefore / to18(1n);
                const usdcLossWhole = requested < pairUSDCWhole ? requested : pairUSDCWhole;
                if (usdcLossWhole === 0n) break;

                await time.increase(DAY);
                const {parsed, cuts} = await applyLossAndCapture(
                    [juniorAddr, polAddr],
                    to6(usdcLossWhole)
                );

                const requestedMZ = parsed.args.requestedMZ;
                const burnedMZ = parsed.args.burnedMZ;
                const uncoveredMZ = parsed.args.uncoveredMZ;

                const cutJ = cuts[0];
                const cutP = cuts[1];
                expect(cutJ <= jTvlBefore).to.equal(true);
                expect(cutP <= pTvlBefore).to.equal(true);
                expect(cutJ + cutP).to.equal(burnedMZ);
                expect(uncoveredMZ).to.equal(0n);
                expect(burnedMZ).to.equal(requestedMZ);
            }
        });

        it("Pair-mode: proportional loss across [Junior, POL Junior] when contiguous and same tranche group", async () => {
            // deposit: junior = 100, pol = 300
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));
            await depositMZIntoPol(await mintMZUSDFor(deployer, to6(300n)));

            // order: [junior, pol, mezz, senior]
            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                        [true, true, false, false]
                    )
            ).wait();

            const j0 = await mzusd.balanceOf(juniorAddr);
            const p0 = await mzusd.balanceOf(polAddr);

            // loss 40 -> split 1:3 -> 10 and 30
            await time.increase(DAY);
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(40n))).wait();

            expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0 - to18(10n));
            expect(await mzusd.balanceOf(polAddr)).to.equal(p0 - to18(30n));
        });

        it("Pair-mode burns full TVL when loss equals pair TVL", async () => {
            const jDeposit = await mintMZUSDFor(alice, to6(100n));
            await depositMZIntoTranche(alice, junior, jDeposit);

            const pDeposit = await mintMZUSDFor(deployer, to6(300n));
            await depositMZIntoPol(pDeposit);

            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                        [true, true, false, false]
                    )
            ).wait();

            const jTvl = await junior.totalAssets();
            const pTvl = await pol.totalAssets();

            const j0 = await mzusd.balanceOf(juniorAddr);
            const p0 = await mzusd.balanceOf(polAddr);

            await time.increase(DAY);
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(400n))).wait();

            expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0 - jTvl);
            expect(await mzusd.balanceOf(polAddr)).to.equal(p0 - pTvl);
            expect(await mzusd.balanceOf(juniorAddr)).to.equal(0n);
            expect(await mzusd.balanceOf(polAddr)).to.equal(0n);
        });

        it("Pair-mode burns only from the tranche with TVL", async () => {
            await depositMZIntoPol(await mintMZUSDFor(deployer, to6(50n)));

            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                        [true, true, false, false]
                    )
            ).wait();

            const j0 = await mzusd.balanceOf(juniorAddr);
            const p0 = await mzusd.balanceOf(polAddr);

            await time.increase(DAY);
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(10n))).wait();

            expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0);
            expect(await mzusd.balanceOf(polAddr)).to.equal(p0 - to18(10n));
        });

        it("Pair-mode passes remainder to the next tranche", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));
            await depositMZIntoPol(await mintMZUSDFor(deployer, to6(5n)));
            await depositMZIntoTranche(alice, mezzanine, await mintMZUSDFor(alice, to6(20n)));

            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                        [true, true, false, false]
                    )
            ).wait();

            const j0 = await mzusd.balanceOf(juniorAddr);
            const p0 = await mzusd.balanceOf(polAddr);
            const m0 = await mzusd.balanceOf(mezzanineAddr);

            await time.increase(DAY);
            await (await lossManager.connect(navOracleSigner).applyLoss(to6(15n))).wait();

            expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0 - to18(5n));
            expect(await mzusd.balanceOf(polAddr)).to.equal(p0 - to18(5n));
            expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(m0 - to18(5n));
        });

        it("Pair mode keeps cuts bounded by TVL (30 iterations)", async () => {
            // Big buffers
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10_000n)));
            await depositMZIntoPol(await mintMZUSDFor(deployer, to6(30_000n)));

            // Put pair first
            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                        [true, true, false, false]
                    )
            ).wait();

            const mStart = await mzusd.balanceOf(mezzanineAddr);
            const sStart = await mzusd.balanceOf(seniorAddr);

            for (let k = 1; k <= 30; k++) {
                const lossUSDC = BigInt((k % 97) + 1); // 1 - 97

                const jTvl = await junior.totalAssets();
                const pTvl = await pol.totalAssets();
                const pairTVL = jTvl + pTvl;

                await time.increase(DAY);
                const {parsed, cuts} = await applyLossAndCapture(
                    [juniorAddr, polAddr, mezzanineAddr, seniorAddr],
                    to6(lossUSDC)
                );

                const requestedMZ = parsed.args.requestedMZ;
                const burnedMZ = parsed.args.burnedMZ;
                const uncoveredMZ = parsed.args.uncoveredMZ;

                const cutJ = cuts[0];
                const cutP = cuts[1];
                expect(cutJ <= jTvl).to.equal(true);
                expect(cutP <= pTvl).to.equal(true);
                expect(cutJ + cutP).to.equal(burnedMZ);
                expect(burnedMZ).to.equal(min(requestedMZ, pairTVL));
                expect(uncoveredMZ).to.equal(0n);

                // untouched (pair always covers)
                expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(mStart);
                expect(await mzusd.balanceOf(seniorAddr)).to.equal(sStart);
            }
        });

        it("Pair-mode works when pair is not first and cuts stay within TVL", async () => {
            // Setup TVL: mezz small, then pair big
            await depositMZIntoTranche(alice, mezzanine, await mintMZUSDFor(alice, to6(200n)));
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));
            await depositMZIntoPol(await mintMZUSDFor(deployer, to6(300n)));

            await (
                await lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [mezzanineAddr, juniorAddr, polAddr, seniorAddr],
                        [false, true, true, false]
                    )
            ).wait();

            for (let k = 1; k <= 20; k++) {
                const lossUSDC = 5n + BigInt(k); // 6..25
                const requestedMZ = to18(lossUSDC);

                const mTvl = await mezzanine.totalAssets();
                const jTvl = await junior.totalAssets();
                const pTvl = await pol.totalAssets();
                const sTvl = await senior.totalAssets();

                await time.increase(DAY);
                const {parsed, cuts} = await applyLossAndCapture(
                    [mezzanineAddr, juniorAddr, polAddr, seniorAddr],
                    to6(lossUSDC)
                );

                const burnedMZ = parsed.args.burnedMZ;
                const cutM = cuts[0];
                const cutJ = cuts[1];
                const cutP = cuts[2];
                const cutS = cuts[3];

                expect(cutM <= mTvl).to.equal(true);
                expect(cutJ <= jTvl).to.equal(true);
                expect(cutP <= pTvl).to.equal(true);
                expect(cutS <= sTvl).to.equal(true);
                expect(cutM + cutJ + cutP + cutS).to.equal(burnedMZ);
                expect(burnedMZ <= requestedMZ).to.equal(true);
            }
        });
    });

    describe("Order configuration validation (edge)", () => {
        it("Pair flags set but NOT contiguous -> reverts in setTrancheOrderAndPairs", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));
            await depositMZIntoPol(await mintMZUSDFor(deployer, to6(300n)));
            await depositMZIntoTranche(alice, mezzanine, await mintMZUSDFor(alice, to6(100n)));

            // Not contiguous: junior, mezz, pol, senior
            await expect(
                lossManager
                    .connect(deployer)
                    .setTrancheOrderAndPairs(
                        [juniorAddr, mezzanineAddr, polAddr, seniorAddr],
                        [true, false, true, false]
                    )
            ).to.be.revertedWithCustomError(lossManager, "PairNotContiguous");
        });
    });
});
