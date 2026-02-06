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
    const MZUSD_SCALE = 1_000_000_000_000n;

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
            [accessManager.target, pauseManager.target, 0, bob.address, 0, carol.address],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC, reservoir.target],
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

        // admin: vault config setters used by tests
        const vaultSelectors = [
            vault.interface.getFunction("setMZUSD").selector,
            vault.interface.getFunction("distributeYield").selector,
            vault.interface.getFunction("advanceEpoch").selector,
            vault.interface.getFunction("setLossManager").selector,
            vault.interface.getFunction("setNavOracle").selector,
            vault.interface.getFunction("addTranche").selector,
            vault.interface.getFunction("setYieldDistribution").selector,
            vault.interface.getFunction("setFeeRates").selector,
            vault.interface.getFunction("setFeeReceivers").selector,
            vault.interface.getFunction("setEpochConfig").selector,
        ];
        await accessManager.setTargetFunctionRole(vault.target, vaultSelectors, ADMIN_ROLE);

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

        // wire and register
        await vault.setMZUSD(mzusd.target);
        await vault.setLossManager(deployer.address);
        await vault.setNavOracle(deployer.address);

        // Register tranches (added disabled with riskPremiumBps=0 by default)
        await vault.addTranche(junior.target);
        await vault.addTranche(mezzanine.target);
        await vault.addTranche(senior.target);

        // Configure default yield distribution
        await vault.setYieldDistribution(4000, [2000, 2000, 2000], [true, true, true]);

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

    async function fundYieldUSDC(amountUSDC: bigint) {
        await usdc.connect(whale).transfer(reservoir.target as string, amountUSDC);
    }

    async function expectSupplyMatchesBacking() {
        const vaultUSDC = await usdc.balanceOf(vault.target);
        const reservoirUSDC = await usdc.balanceOf(reservoir.target);
        const totalUSDC = vaultUSDC + reservoirUSDC;
        const totalSupply = await mzusd.totalSupply();
        expect(totalSupply).to.equal(totalUSDC * MZUSD_SCALE);
    }

    describe("Getters and admin", () => {
        it("Getters sanity", async () => {
            // tranchesLength
            expect(await vault.tranchesLength()).to.equal(3n);

            // tranches — struct fields: tranche, riskPremiumBps, enabled
            const [t0, r0, e0] = await vault.tranches(0);
            expect(t0).to.equal(junior.target);
            expect(r0).to.equal(2000n);
            expect(e0).to.equal(true);

            const [t1, r1, e1] = await vault.tranches(1);
            expect(t1).to.equal(mezzanine.target);
            expect(r1).to.equal(2000n);
            expect(e1).to.equal(true);

            const [t2, r2, e2] = await vault.tranches(2);
            expect(t2).to.equal(senior.target);
            expect(r2).to.equal(2000n);
            expect(e2).to.equal(true);

            // baseRewardBps
            expect(await vault.baseRewardBps()).to.equal(4000n);

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
            await (await vault.connect(deployer).setFeeRates(1111, 2222)).wait();
            await (
                await vault.connect(deployer).setFeeReceivers(bob.address, carol.address)
            ).wait();
            expect(await vault.performanceFeeBps()).to.equal(1111n);
            expect(await vault.performanceFeeReceiver()).to.equal(bob.address);
            expect(await vault.protocolFeeBps()).to.equal(2222n);
            expect(await vault.protocolFeeReceiver()).to.equal(carol.address);

            // Tranche info updates via setYieldDistribution
            await vault.setYieldDistribution(5000, [1000, 1500, 2500], [true, false, true]);

            const [t1b, r1b, e1b] = await vault.tranches(1);
            expect(t1b).to.equal(mezzanine.target);
            expect(r1b).to.equal(1500n);
            expect(e1b).to.equal(false);

            expect(await vault.baseRewardBps()).to.equal(5000n);

            // getTranches
            const [emptyTranches, emptyRisks, emptyEnabled] = await vault.getTranches(0, 0);
            expect(emptyTranches.length).to.equal(0);
            expect(emptyRisks.length).to.equal(0);
            expect(emptyEnabled.length).to.equal(0);

            const [allTranches, allRisks, allEnabled] = await vault.getTranches(0, 10);
            expect(allTranches).to.deep.equal([junior.target, mezzanine.target, senior.target]);
            expect(allRisks).to.deep.equal([1000n, 1500n, 2500n]);
            expect(allEnabled).to.deep.equal([true, false, true]);

            // Epoch config
            const [epochId, epochStart, epochDuration] = await vault.getEpochConfig();
            expect(epochId).to.equal(await vault.currentEpochId());
            expect(epochStart).to.equal(await vault.epochStart());
            expect(epochDuration).to.equal(await vault.epochDuration());

            // currentIdleUSDC
            await usdc.connect(whale).transfer(vault.target as string, to6(5n));
            expect(await vault.currentIdleUSDC()).to.equal(to6(5n));

            // Length unchanged
            expect(await vault.tranchesLength()).to.equal(3n);
        });
    });

    describe("Access control", () => {
        it("Pauses all guarded Vault functions", async () => {
            const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
            const KEEPER_ROLE = 5n;
            const rebalanceSel = vault.interface.getFunction("rebalance").selector;
            const setBufferSel = vault.interface.getFunction("setBuffer").selector;
            await accessManager.setTargetFunctionRole(vault.target, [setBufferSel], ADMIN_ROLE);
            await accessManager.setTargetFunctionRole(vault.target, [rebalanceSel], KEEPER_ROLE);
            await accessManager.grantRole(KEEPER_ROLE, deployer.address, 0);

            await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);
            await expect(vault.connect(deployer).distributeYield(0))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await expect(vault.connect(deployer).rebalance())
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await expect(vault.connect(deployer).advanceEpoch())
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await pauseManager.unpauseGlobal(PauseCategory.PROTOCOL);

            // WITHDRAWALS pause blocks MZUSD.requestWithdrawal and vault.withdraw
            const minted = await mintMZUSDFor(deployer, to6(1n));
            await pauseManager.pauseGlobal(PauseCategory.WITHDRAWALS);
            await expect(mzusd.connect(deployer).requestWithdrawal(minted))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.WITHDRAWALS);
            await pauseManager.unpauseGlobal(PauseCategory.WITHDRAWALS);

            await pauseManager.pauseGlobal(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).setMZUSD(bob.address))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).setFeeRates(1, 1))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).setFeeReceivers(bob.address, carol.address))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(vault.connect(deployer).addTranche(carol.address))
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(
                vault
                    .connect(deployer)
                    .setYieldDistribution(4000, [2000, 2000, 2000], [true, true, true])
            )
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
                        constructorArgs: [MAINNET_USDC, reservoir.target],
                    }
                )
            ).to.be.revertedWithCustomError(VaultFactory, "ZeroAddress");

            const overMax = (await vault.MAX_TOTAL_FEE_BPS()) + 1n;
            await expect(
                upgrades.deployProxy(
                    VaultFactory,
                    [
                        accessManager.target,
                        pauseManager.target,
                        overMax,
                        bob.address,
                        0,
                        carol.address,
                    ],
                    {
                        kind: "uups",
                        initializer: "initialize",
                        unsafeAllow: ["constructor", "state-variable-immutable"],
                        constructorArgs: [MAINNET_USDC, reservoir.target],
                    }
                )
            ).to.be.revertedWithCustomError(VaultFactory, "TooBigBps");

            await expect(
                vault.connect(deployer).setFeeReceivers(ethers.ZeroAddress, carol.address)
            ).to.be.revertedWithCustomError(vault, "ZeroAddress");
            await expect(
                vault.connect(deployer).setFeeReceivers(bob.address, ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(vault, "ZeroAddress");
            await expect(
                vault.connect(deployer).setFeeRates(overMax, 0)
            ).to.be.revertedWithCustomError(vault, "TooBigBps");
            await vault.connect(deployer).setFeeReceivers(bob.address, bob.address);
        });
    });

    describe("Invariants", () => {
        it("MZUSD supply tracks backing USDC across yield distribution", async () => {
            const depositAmountUSDC = to6(100n);
            await mintMZUSDFor(alice, depositAmountUSDC);
            await expectSupplyMatchesBacking();

            const aliceMZ = await mzusd.balanceOf(alice.address);
            await depositMZIntoTranche(alice, junior, aliceMZ);
            await expectSupplyMatchesBacking();

            const yieldUSDC = to6(10n);
            await usdc.connect(whale).transfer(reservoir.target as string, yieldUSDC);
            await time.increase(DAY);

            await (await vault.connect(deployer).distributeYield(yieldUSDC)).wait();
            await expectSupplyMatchesBacking();
        });
    });

    describe("Yield distribution", () => {
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

        it("Epoch advances, fees minted (max 50%), and yield is still allocated", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(1n)));
            await time.increase(DAY);

            const perfReceiver = bob.address;
            const perfBps = 5_000;
            await (await vault.connect(deployer).setFeeRates(perfBps, 0)).wait();
            await (
                await vault.connect(deployer).setFeeReceivers(perfReceiver, carol.address)
            ).wait();

            const usdcReported = 77n; // 0.000077 USDC (still non-zero)
            const expectedGross = usdcReported * 1_000_000_000_000n; // * 1e12 -> 18d MZUSD
            const expectedFee = expectedGross / 2n;
            const expectedAlloc = expectedGross - expectedFee;

            const epochBefore = await vault.currentEpochId();
            const feeBalBefore = await mzusd.balanceOf(perfReceiver);
            const juniorBalBefore = await mzusd.balanceOf(junior.target);

            await fundYieldUSDC(usdcReported);
            const tx = await vault.connect(deployer).distributeYield(usdcReported);
            await tx.wait();

            const epochAfter = await vault.currentEpochId();
            expect(epochAfter).to.equal(epochBefore + 1n);

            const feeBalAfter = await mzusd.balanceOf(perfReceiver);
            expect(feeBalAfter - feeBalBefore).to.equal(expectedFee);

            // Junior is the only tranche with TVL, so it receives all allocatable yield
            const juniorBalAfter = await mzusd.balanceOf(junior.target);
            expect(juniorBalAfter - juniorBalBefore).to.equal(expectedAlloc);

            // No allocation mint should remain on Vault
            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
            await expectSupplyMatchesBacking();
        });

        it("Fees can be paid to the same receiver for both fee types", async () => {
            await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(1n)));
            await time.increase(DAY);

            const receiver = bob.address;
            const perfBps = 2000;
            const protBps = 3000; // total 50%
            await (await vault.connect(deployer).setFeeRates(perfBps, protBps)).wait();
            await (await vault.connect(deployer).setFeeReceivers(receiver, receiver)).wait();

            const usdcReported = 55n;
            const expectedGross = usdcReported * 1_000_000_000_000n; // * 1e12 -> 18d MZUSD
            const expectedFee = (expectedGross * BigInt(perfBps + protBps)) / 10_000n;
            const expectedAlloc = expectedGross - expectedFee;

            const feeBalBefore = await mzusd.balanceOf(receiver);
            const juniorBalBefore = await mzusd.balanceOf(junior.target);

            const tx = await vault.connect(deployer).distributeYield(usdcReported);
            await tx.wait();

            const feeBalAfter = await mzusd.balanceOf(receiver);
            expect(feeBalAfter - feeBalBefore).to.equal(expectedFee);

            // Junior is the only tranche with TVL
            const juniorBalAfter = await mzusd.balanceOf(junior.target);
            expect(juniorBalAfter - juniorBalBefore).to.equal(expectedAlloc);

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

        it("Distribution works with Yield = 0", async () => {
            const before = await vault.currentEpochId();

            await time.increase(DAY);
            await expect(vault.connect(deployer).distributeYield(0)).to.not.be.reverted;

            const after = await vault.currentEpochId();
            expect(after).to.equal(before + 1n);
        });

        it("Reverts TVLZero when all enabled tranches have zero TVL", async () => {
            // No deposits, all tranches have 0 TVL
            await time.increase(DAY);
            await expect(
                vault.connect(deployer).distributeYield(to6(1n))
            ).to.be.revertedWithCustomError(vault, "TVLZero");
        });
    });
});
