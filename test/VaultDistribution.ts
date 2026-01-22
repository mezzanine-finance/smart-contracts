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

import {Vault, ReservoirUSDC, MZUSD, IERC20, Tranche, PauseManager} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

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
    let pauseManager: PauseManager;
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

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                pauseManager.target,
                usdcTotalSupply, // _hourlyLimitUSDC (max allowed)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC, vault.target],
            }
        )) as unknown as MZUSD;

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

        // Roles
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // admin: vault.distributeYield/addTranche/updateTranche + config setters used by tests
        const setMZUSDSel = vault.interface.getFunction("setMZUSD").selector;
        const distributeSel = vault.interface.getFunction("distributeYield").selector;
        const advanceEpochSel = vault.interface.getFunction("advanceEpoch").selector;
        const setLossManagerSel = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSel = vault.interface.getFunction("setNavOracle").selector;
        const addTrancheSel = vault.interface.getFunction("addTranche").selector;
        const updateTrancheSel = vault.interface.getFunction("updateTranche").selector;
        const setFeesSel = vault.interface.getFunction("setFees").selector;
        const setEpochConfigSel = vault.interface.getFunction("setEpochConfig").selector;
        await accessManager.setTargetFunctionRole(
            vault.target,
            [
                setMZUSDSel,
                distributeSel,
                advanceEpochSel,
                setLossManagerSel,
                setNavOracleSel,
                addTrancheSel,
                updateTrancheSel,
                setFeesSel,
                setEpochConfigSel,
            ],
            ADMIN_ROLE
        );

        // admin: Tranche config/finalize functions (for tests/helpers)
        const tSetUnstakeDelaySel = junior.interface.getFunction("setUnstakeDelayEpochs").selector;
        const tSetDepositLimitsSel = junior.interface.getFunction("setDepositLimits").selector;
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

        await accessManager.grantRole(VAULT_ROLE, vault.target, 0);

        // vault role: tranche.notifyYield (each tranche)
        const notifySel = junior.interface.getFunction("notifyYield").selector;
        await accessManager.setTargetFunctionRole(junior.target, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(mezzanine.target, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(senior.target, [notifySel], VAULT_ROLE);

        // wire and register
        await vault.setMZUSD(mzusd.target);
        await vault.setLossManager(deployer.address);
        await vault.setNavOracle(deployer.address);

        await vault.addTranche({tranche: junior.target, weight: 2000, enabled: true});
        await vault.addTranche({tranche: mezzanine.target, weight: 3000, enabled: true});
        await vault.addTranche({tranche: senior.target, weight: 5000, enabled: true});

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

    describe("Getters and admin", () => {
        it("Getters sanity", async () => {
            // tranchesLength
            expect(await vault.tranchesLength()).to.equal(3n);

            // tranches
            const [t0, w0, e0] = await vault.tranches(0);
            expect(t0).to.equal(junior.target);
            expect(w0).to.equal(2000n);
            expect(e0).to.equal(true);

            const [t1, w1, e1] = await vault.tranches(1);
            expect(t1).to.equal(mezzanine.target);
            expect(w1).to.equal(3000n);
            expect(e1).to.equal(true);

            const [t2, w2, e2] = await vault.tranches(2);
            expect(t2).to.equal(senior.target);
            expect(w2).to.equal(5000n);
            expect(e2).to.equal(true);

            // Fee fields default
            const perfBps0 = await vault.performanceFeeBps();
            const perfReceiver0 = await vault.performanceFeeReceiver();
            const protBps0 = await vault.protocolFeeBps();
            const protReceiver0 = await vault.protocolFeeReceiver();
            expect(perfBps0).to.equal(0n);
            expect(perfReceiver0).to.equal(bob.address);
            expect(protBps0).to.equal(0n);
            expect(protReceiver0).to.equal(carol.address);

            // After setting fees, getter must reflect updates
            await (
                await vault.connect(deployer).setFees(1111, bob.address, 2222, carol.address)
            ).wait();
            const perfBps1 = await vault.performanceFeeBps();
            const perfReceiver1 = await vault.performanceFeeReceiver();
            const protBps1 = await vault.protocolFeeBps();
            const protReceiver1 = await vault.protocolFeeReceiver();
            expect(perfBps1).to.equal(1111n);
            expect(perfReceiver1).to.equal(bob.address);
            expect(protBps1).to.equal(2222n);
            expect(protReceiver1).to.equal(carol.address);

            // Tranche info updates should be visible through getter
            await (await vault.connect(deployer).updateTranche(1, 1234, false)).wait();
            const [t1b, w1b, e1b] = await vault.tranches(1);
            expect(t1b).to.equal(mezzanine.target);
            expect(w1b).to.equal(1234n);
            expect(e1b).to.equal(false);

            const [emptyTranches, emptyWeights, emptyEnabled] = await vault.getTranches(0, 0);
            expect(emptyTranches.length).to.equal(0);
            expect(emptyWeights.length).to.equal(0);
            expect(emptyEnabled.length).to.equal(0);

            const [allTranches, allWeights, allEnabled] = await vault.getTranches(0, 10);
            expect(allTranches).to.deep.equal([junior.target, mezzanine.target, senior.target]);
            expect(allWeights).to.deep.equal([2000n, 1234n, 5000n]);
            expect(allEnabled).to.deep.equal([true, false, true]);

            const [epochId, epochStart, epochDuration] = await vault.getEpochConfig();
            expect(epochId).to.equal(await vault.currentEpochId());
            expect(epochStart).to.equal(await vault.epochStart());
            expect(epochDuration).to.equal(await vault.epochDuration());

            await usdc.connect(whale).transfer(vault.target as string, to6(5n));
            expect(await vault.currentIdleUSDC()).to.equal(to6(5n));

            // Length unchanged
            expect(await vault.tranchesLength()).to.equal(3n);
        });

        it("Updates reservoir address", async () => {
            const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
            const setReservoirSel = vault.interface.getFunction("setReservoir").selector;
            await accessManager.setTargetFunctionRole(vault.target, [setReservoirSel], ADMIN_ROLE);

            await expect(vault.connect(deployer).setReservoir(bob.address))
                .to.emit(vault, "ReservoirUpdated")
                .withArgs(bob.address);

            expect(await vault.reservoir()).to.equal(bob.address);
        });
    });

    describe("Access control", () => {
        it("Pauses all guarded Vault functions", async () => {
            const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
            const rebalanceSel = vault.interface.getFunction("rebalance").selector;
            const setReservoirSel = vault.interface.getFunction("setReservoir").selector;
            const setBufferSel = vault.interface.getFunction("setBuffer").selector;
            await accessManager.setTargetFunctionRole(
                vault.target,
                [rebalanceSel, setReservoirSel, setBufferSel],
                ADMIN_ROLE
            );

            await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);
            await expect(vault.connect(deployer).distributeYield(0))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await expect(vault.connect(deployer).rebalance())
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            const minted = await mintMZUSDFor(deployer, to6(1n));
            await expect(mzusd.connect(deployer).requestWithdrawal(minted))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await expect(vault.connect(deployer).advanceEpoch())
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await pauseManager.unpauseGlobal(PauseCategory.PROTOCOL);

            await pauseManager.pauseGlobal(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).setReservoir(bob.address))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).setMZUSD(bob.address))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).setFees(1, bob.address, 1, carol.address))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(
                vault
                    .connect(deployer)
                    .addTranche({tranche: carol.address, weight: 1, enabled: true})
            )
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).updateTranche(0, 1000, false))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).setBuffer(1n, 1))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).setEpochConfig(60 * 60))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
        });
    });
    describe("Epoch advancement", () => {
        it("advanceEpoch increments the epoch when called by loss manager", async () => {
            const before = await vault.currentEpochId();

            await time.increase(DAY);
            await (await vault.connect(deployer).advanceEpoch()).wait();

            const after = await vault.currentEpochId();
            expect(after).to.equal(before + 1n);
        });
    });
    describe("Validation", () => {
        it("Fee receiver validation (init + setter)", async () => {
            const VaultFactory = await ethers.getContractFactory("Vault", deployer);

            await expect(
                upgrades.deployProxy(
                    VaultFactory,
                    [
                        reservoir.target,
                        accessManager.target,
                        pauseManager.target,
                        0,
                        ethers.ZeroAddress,
                        0,
                        carol.address,
                    ],
                    {
                        kind: "uups",
                        initializer: "initialize",
                        unsafeAllow: ["constructor", "state-variable-immutable"],
                        constructorArgs: [MAINNET_USDC],
                    }
                )
            ).to.be.revertedWithCustomError(VaultFactory, "ZeroAddress");

            await expect(
                upgrades.deployProxy(
                    VaultFactory,
                    [
                        reservoir.target,
                        accessManager.target,
                        pauseManager.target,
                        10_000,
                        bob.address,
                        1,
                        carol.address,
                    ],
                    {
                        kind: "uups",
                        initializer: "initialize",
                        unsafeAllow: ["constructor", "state-variable-immutable"],
                        constructorArgs: [MAINNET_USDC],
                    }
                )
            ).to.be.revertedWithCustomError(VaultFactory, "TooBigBps");

            await expect(
                vault.connect(deployer).setFees(0, ethers.ZeroAddress, 0, carol.address)
            ).to.be.revertedWithCustomError(vault, "ZeroAddress");
            await expect(
                vault.connect(deployer).setFees(0, bob.address, 0, ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(vault, "ZeroAddress");
            await vault.connect(deployer).setFees(0, bob.address, 0, bob.address);
        });

        it("Enforces tranche weight limit for add/update", async () => {
            const limit = await vault.TRANCHE_WEIGHT_LIMIT();
            const over = limit + 1n;

            await expect(
                vault.connect(deployer).updateTranche(0, over, true)
            ).to.be.revertedWithCustomError(vault, "TooBigBps");
            await vault.connect(deployer).updateTranche(0, limit, true);

            await expect(
                vault
                    .connect(deployer)
                    .addTranche({tranche: alice.address, weight: over, enabled: true})
            ).to.be.revertedWithCustomError(vault, "TooBigBps");
            await vault
                .connect(deployer)
                .addTranche({tranche: alice.address, weight: limit, enabled: true});
        });
    });

    describe("Yield distribution", () => {
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

        it("Long pause still allows only one distribution per epoch", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));

            const epochBefore = await vault.currentEpochId();
            const startBefore = await vault.epochStart();
            const duration = BigInt(await vault.epochDuration());

            await time.increase(duration * 3n + 5n);

            const tx = await vault.connect(deployer).distributeYield(to6(1n));
            const receipt = await tx.wait();
            const block = await ethers.provider.getBlock(receipt!.blockNumber);
            const startAfter = await vault.epochStart();

            expect(startAfter).to.equal(BigInt(block!.timestamp));
            expect(startAfter).to.be.greaterThanOrEqual(startBefore + duration * 3n);
            expect(await vault.currentEpochId()).to.equal(epochBefore + 1n);

            await expect(
                vault.connect(deployer).distributeYield(to6(1n))
            ).to.be.revertedWithCustomError(vault, "EpochTooSoon");

            await time.increase(duration);
            await (await vault.connect(deployer).distributeYield(to6(1n))).wait();
            expect(await vault.currentEpochId()).to.equal(epochBefore + 2n);
        });

        it("Weight scaling does not change allocation", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(10n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(10n)));

            await (await vault.connect(deployer).updateTranche(0, 1, true)).wait();
            await (await vault.connect(deployer).updateTranche(1, 2, true)).wait();
            await (await vault.connect(deployer).updateTranche(2, 3, true)).wait();

            await time.increase(DAY);

            const reportedUSDC = to6(11n);

            const snapshotInner = await takeSnapshot();
            const bJ0 = await mzusd.balanceOf(junior.target);
            const bM0 = await mzusd.balanceOf(mezzanine.target);
            const bS0 = await mzusd.balanceOf(senior.target);
            await (await vault.connect(deployer).distributeYield(reportedUSDC)).wait();
            const bJ1 = await mzusd.balanceOf(junior.target);
            const bM1 = await mzusd.balanceOf(mezzanine.target);
            const bS1 = await mzusd.balanceOf(senior.target);
            const partJSmall = bJ1 - bJ0;
            const partMSmall = bM1 - bM0;
            const partSSmall = bS1 - bS0;

            await snapshotInner.restore();

            await (await vault.connect(deployer).updateTranche(0, 1000, true)).wait();
            await (await vault.connect(deployer).updateTranche(1, 2000, true)).wait();
            await (await vault.connect(deployer).updateTranche(2, 3000, true)).wait();

            const bJ2 = await mzusd.balanceOf(junior.target);
            const bM2 = await mzusd.balanceOf(mezzanine.target);
            const bS2 = await mzusd.balanceOf(senior.target);
            await (await vault.connect(deployer).distributeYield(reportedUSDC)).wait();
            const bJ3 = await mzusd.balanceOf(junior.target);
            const bM3 = await mzusd.balanceOf(mezzanine.target);
            const bS3 = await mzusd.balanceOf(senior.target);
            const partJLarge = bJ3 - bJ2;
            const partMLarge = bM3 - bM2;
            const partSLarge = bS3 - bS2;

            expect(partJSmall).to.equal(partJLarge);
            expect(partMSmall).to.equal(partMLarge);
            expect(partSSmall).to.equal(partSLarge);
        });

        it("Supports arbitrary weight granularity", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(20n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(30n)));

            await (await vault.connect(deployer).updateTranche(0, 10, true)).wait();
            await (await vault.connect(deployer).updateTranche(1, 55, true)).wait();
            await (await vault.connect(deployer).updateTranche(2, 5600, true)).wait();

            await time.increase(DAY);

            const reportedUSDC = to6(13n);
            const expectedYield = to18(13n);
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

            const tvlJ = await junior.totalAssets();
            const tvlM = await mezzanine.totalAssets();
            const tvlS = await senior.totalAssets();

            const scoreJ = 10n * tvlJ;
            const scoreM = 55n * tvlM;
            const scoreS = 5600n * tvlS;
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

            const bJ1 = await mzusd.balanceOf(junior.target);
            const bM1 = await mzusd.balanceOf(mezzanine.target);
            const bS1 = await mzusd.balanceOf(senior.target);

            expect(bJ1 - bJ0).to.equal(partJ);
            expect(bM1 - bM0).to.equal(partM);
            expect(bS1 - bS0).to.equal(partSWithDust);

            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });

        it("Allocates correctly when weights sum above 10k", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(20n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(30n)));

            await (await vault.connect(deployer).updateTranche(0, 8000, true)).wait();
            await (await vault.connect(deployer).updateTranche(1, 9000, true)).wait();
            await (await vault.connect(deployer).updateTranche(2, 10_000, true)).wait();

            await time.increase(DAY);

            const reportedUSDC = to6(19n);
            const expectedYield = to18(19n);
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

            const tvlJ = await junior.totalAssets();
            const tvlM = await mezzanine.totalAssets();
            const tvlS = await senior.totalAssets();

            const scoreJ = 8000n * tvlJ;
            const scoreM = 9000n * tvlM;
            const scoreS = 10_000n * tvlS;
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

            const bJ1 = await mzusd.balanceOf(junior.target);
            const bM1 = await mzusd.balanceOf(mezzanine.target);
            const bS1 = await mzusd.balanceOf(senior.target);

            expect(bJ1 - bJ0).to.equal(partJ);
            expect(bM1 - bM0).to.equal(partM);
            expect(bS1 - bS0).to.equal(partSWithDust);

            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });

        it("Sends dust to the last tranche even if it has the smallest weight", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(10n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(10n)));

            await (await vault.connect(deployer).updateTranche(0, 9999, true)).wait();
            await (await vault.connect(deployer).updateTranche(1, 8000, true)).wait();
            await (await vault.connect(deployer).updateTranche(2, 1, true)).wait();

            await time.increase(DAY);

            const reportedUSDC = to6(13n);
            const expectedYield = to18(13n);
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

            const tvlJ = await junior.totalAssets();
            const tvlM = await mezzanine.totalAssets();
            const tvlS = await senior.totalAssets();

            const scoreJ = 9999n * tvlJ;
            const scoreM = 8000n * tvlM;
            const scoreS = 1n * tvlS;
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

            const bJ1 = await mzusd.balanceOf(junior.target);
            const bM1 = await mzusd.balanceOf(mezzanine.target);
            const bS1 = await mzusd.balanceOf(senior.target);

            expect(bJ1 - bJ0).to.equal(partJ);
            expect(bM1 - bM0).to.equal(partM);
            expect(bS1 - bS0).to.equal(partSWithDust);

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

        it("Only enabled non-zero weights participate in allocation", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(10n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(10n)));

            await (await vault.connect(deployer).updateTranche(0, 0, true)).wait();
            await (await vault.connect(deployer).updateTranche(1, 4000, false)).wait();
            await (await vault.connect(deployer).updateTranche(2, 6000, true)).wait();

            await time.increase(DAY);

            const reportedUSDC = to6(7n);
            const expectedYield = to18(7n);
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

            await expect(tx).to.not.emit(junior, "YieldNotified");
            await expect(tx).to.not.emit(mezzanine, "YieldNotified");
            await expect(tx)
                .to.emit(senior, "YieldNotified")
                .withArgs(newEpochId, expectedYield, startTs, endTs);

            const bJ1 = await mzusd.balanceOf(junior.target);
            const bM1 = await mzusd.balanceOf(mezzanine.target);
            const bS1 = await mzusd.balanceOf(senior.target);

            expect(bJ1).to.equal(bJ0);
            expect(bM1).to.equal(bM0);
            expect(bS1 - bS0).to.equal(expectedYield);

            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });

        it("Skips enabled tranche with zero TVL", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(30n)));

            const tvlM = await mezzanine.totalAssets();
            expect(tvlM).to.equal(0n);

            await time.increase(DAY);

            const reportedUSDC = to6(8n);
            const expectedYield = to18(8n);
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

            const tvlJ = await junior.totalAssets();
            const tvlS = await senior.totalAssets();

            const scoreJ = 2000n * tvlJ;
            const scoreM = 0n;
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
            await expect(tx).to.not.emit(mezzanine, "YieldNotified");
            await expect(tx)
                .to.emit(senior, "YieldNotified")
                .withArgs(newEpochId, partSWithDust, startTs, endTs);

            const bJ1 = await mzusd.balanceOf(junior.target);
            const bM1 = await mzusd.balanceOf(mezzanine.target);
            const bS1 = await mzusd.balanceOf(senior.target);
            expect(bJ1 - bJ0).to.equal(partJ);
            expect(bM1).to.equal(bM0);
            expect(bS1 - bS0).to.equal(partSWithDust);
        });

        it("Skips zero allocation tranches without reverting", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6("0.000001")));
            await depositMZIntoTranche(bob, senior, await mintMZUSDFor(bob, to6(1000n)));

            await (await vault.connect(deployer).updateTranche(0, 1, true)).wait();
            await (await vault.connect(deployer).updateTranche(1, 0, false)).wait();
            await (await vault.connect(deployer).updateTranche(2, 10_000, true)).wait();

            await time.increase(DAY);

            const bJ0 = await mzusd.balanceOf(junior.target);
            const bS0 = await mzusd.balanceOf(senior.target);

            const reportedUSDC = to6("0.000001");
            const expectedYield = to18("0.000001");

            const tx = await vault.connect(deployer).distributeYield(reportedUSDC);
            await tx.wait();

            const bJ1 = await mzusd.balanceOf(junior.target);
            const bS1 = await mzusd.balanceOf(senior.target);

            expect(bJ1).to.equal(bJ0);
            expect(bS1 - bS0).to.equal(expectedYield);
            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });
        it("Epoch advances, fees minted (fees = 100%), and no tranche notify/transfer happens", async () => {
            await time.increase(DAY);

            const perfReceiver = bob.address;
            await (
                await vault.connect(deployer).setFees(10_000, perfReceiver, 0, carol.address)
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

            await expect(tx)
                .to.emit(vault, "YieldDistributed")
                .withArgs(usdcReported, 0n, epochAfter);
        });

        it("Fees can be paid to the same receiver for both fee types", async () => {
            await time.increase(DAY);

            const receiver = bob.address;
            const perfBps = 4000;
            const protBps = 6000; // total 100%
            await (
                await vault.connect(deployer).setFees(perfBps, receiver, protBps, receiver)
            ).wait();

            const usdcReported = 55n;
            const expectedGross = usdcReported * 1_000_000_000_000n; // * 1e12 -> 18d MZUSD

            const feeBalBefore = await mzusd.balanceOf(receiver);

            const tx = await vault.connect(deployer).distributeYield(usdcReported);
            await expect(tx).to.not.emit(junior, "YieldNotified");
            await expect(tx).to.not.emit(mezzanine, "YieldNotified");
            await expect(tx).to.not.emit(senior, "YieldNotified");

            const feeBalAfter = await mzusd.balanceOf(receiver);
            expect(feeBalAfter - feeBalBefore).to.equal(expectedGross);

            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });

        it("Fees paid, dust folds into last tranche", async () => {
            // TVLs with awkward numbers
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(101n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(203n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(307n)));

            const perfReceiver = bob.address;
            const protReceiver = carol.address;

            const perfBps = 321n; // 3.21%
            const protBps = 123n; // 1.23%

            await (
                await vault.connect(deployer).setFees(perfBps, perfReceiver, protBps, protReceiver)
            ).wait();

            await time.increase(DAY);

            const usdcReported = to6(123n);
            const mintedGross = 123n * 1_000_000_000_000_000_000n; // 123 * 1e18

            const epochBefore = await vault.currentEpochId();
            const newEpochId = epochBefore + 1n;

            const perfBefore = await mzusd.balanceOf(perfReceiver);
            const protBefore = await mzusd.balanceOf(protReceiver);

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
            const amountForTranches = allocatable;

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

        it("Distributes a tiny yield amount correctly", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(1n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(1n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(1n)));

            await time.increase(DAY);

            const reportedUSDC = to6(1n);
            const expectedYield = to18(1n);
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

            const tvlJ = await junior.totalAssets();
            const tvlM = await mezzanine.totalAssets();
            const tvlS = await senior.totalAssets();

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

            const bJ1 = await mzusd.balanceOf(junior.target);
            const bM1 = await mzusd.balanceOf(mezzanine.target);
            const bS1 = await mzusd.balanceOf(senior.target);
            expect(bJ1 - bJ0).to.equal(partJ);
            expect(bM1 - bM0).to.equal(partM);
            expect(bS1 - bS0).to.equal(partSWithDust);

            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });

        it("Distributes a large yield amount without overflow", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(2n)));
            await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(3n)));
            await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(5n)));

            await time.increase(DAY);

            const reportedUSDC = to6(1_000_000_000n);
            const expectedYield = to18(1_000_000_000n);
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

            const tvlJ = await junior.totalAssets();
            const tvlM = await mezzanine.totalAssets();
            const tvlS = await senior.totalAssets();

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

            const bJ1 = await mzusd.balanceOf(junior.target);
            const bM1 = await mzusd.balanceOf(mezzanine.target);
            const bS1 = await mzusd.balanceOf(senior.target);
            expect(bJ1 - bJ0).to.equal(partJ);
            expect(bM1 - bM0).to.equal(partM);
            expect(bS1 - bS0).to.equal(partSWithDust);

            await expect(tx)
                .to.emit(vault, "YieldDistributed")
                .withArgs(reportedUSDC, expectedYield, newEpochId);

            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });

        it("Queued epoch duration does not affect the current epoch", async () => {
            // Ensure TVL > 0 so allocation is attempted
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));

            await time.increase(DAY - 60);

            await (await vault.connect(deployer).setEpochConfig(60 * 60)).wait();
            expect(await vault.pendingEpochDuration()).to.equal(3600n);

            await expect(
                vault.connect(deployer).distributeYield(to6(1n))
            ).to.be.revertedWithCustomError(vault, "EpochTooSoon");

            await time.increase(60);

            const tx = await vault.connect(deployer).distributeYield(to6(1n));
            await tx.wait();

            expect(await vault.pendingEpochDuration()).to.equal(0n);
            expect((await junior.yieldStreamEnd()) - (await junior.yieldStreamStart())).to.equal(
                3600n
            );
        });

        it("Latest queued epoch duration is applied on next epoch", async () => {
            // TVL > 0 so allocation is attempted.
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));

            await (await vault.connect(deployer).setEpochConfig(60 * 60)).wait();
            await (await vault.connect(deployer).setEpochConfig(2 * 60 * 60)).wait();

            await time.increase(DAY);

            await (await vault.connect(deployer).distributeYield(to6(1n))).wait();

            expect((await junior.yieldStreamEnd()) - (await junior.yieldStreamStart())).to.equal(
                2n * 3600n
            );
        });

        it("Reverts InvalidEpochDuration for out-of-bounds values", async () => {
            const MIN = 60 * 60; // 1 hour
            const MAX = 30 * 24 * 60 * 60; // 30 days

            await expect(
                vault.connect(deployer).setEpochConfig(MIN - 1)
            ).to.be.revertedWithCustomError(vault, "InvalidEpochDuration");

            await expect(
                vault.connect(deployer).setEpochConfig(MAX + 1)
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
});
