import {expect} from "chai";
import {ethers, upgrades} from "hardhat";
import {parseUnits} from "ethers";
import {takeSnapshot, time} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

import {Vault, ReservoirUSDC, MZUSD, MockUSDC, Tranche, PauseManager} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

describe("Vault Yield Distribution V2", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let usdc: MockUSDC;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;

    let junior: Tranche;
    let mezzanine: Tranche;
    let senior: Tranche;

    const DAY = 24 * 60 * 60;
    const BPS = 10_000n;
    const MZUSD_SCALE = 1_000_000_000_000n;

    before(async () => {
        [deployer, alice, bob, carol] = await ethers.getSigners();
        upgrades.silenceWarnings();

        // ── Mock USDC ───────────────────────────────────────────────
        const MockUSDCFactory = await ethers.getContractFactory("MockUSDC", deployer);
        usdc = (await MockUSDCFactory.deploy()) as unknown as MockUSDC;
        await usdc.waitForDeployment();

        // ── Access & Pause ──────────────────────────────────────────
        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        accessManager = await AccessManagerFactory.deploy(deployer.address);
        await accessManager.waitForDeployment();

        const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
        pauseManager = (await upgrades.deployProxy(PauseManagerFactory, [accessManager.target], {
            kind: "uups",
            initializer: "initialize",
        })) as unknown as PauseManager;

        // ── Reservoir ───────────────────────────────────────────────
        const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
        reservoir = (await upgrades.deployProxy(
            ReservoirFactory,
            [accessManager.target, pauseManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [usdc.target],
            }
        )) as unknown as ReservoirUSDC;

        // ── Vault ───────────────────────────────────────────────────
        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(
            VaultFactory,
            [accessManager.target, pauseManager.target, 0, bob.address, 0, carol.address],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [usdc.target, reservoir.target],
            }
        )) as unknown as Vault;

        // ── MZUSD ──────────────────────────────────────────────────
        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                pauseManager.target,
                to6(1_000_000_000), // _hourlyLimitUSDC
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [usdc.target, vault.target],
            }
        )) as unknown as MZUSD;

        // ── Tranches ────────────────────────────────────────────────
        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);

        senior = (await upgrades.deployProxy(
            TrancheFactory,
            [
                mzusd.target,
                vault.target,
                1,
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

        junior = (await upgrades.deployProxy(
            TrancheFactory,
            [
                mzusd.target,
                vault.target,
                3,
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

        // ── Roles ───────────────────────────────────────────────────
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // Vault admin selectors
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

        // Tranche admin selectors
        const trancheSelectors = [
            senior.interface.getFunction("setUnstakeDelayEpochs").selector,
            senior.interface.getFunction("setDepositLimits").selector,
        ];
        await accessManager.setTargetFunctionRole(senior.target, trancheSelectors, ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(mezzanine.target, trancheSelectors, ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(junior.target, trancheSelectors, ADMIN_ROLE);

        // ── Wire contracts ──────────────────────────────────────────
        await vault.setMZUSD(mzusd.target);
        await vault.setLossManager(deployer.address);
        await vault.setNavOracle(deployer.address);

        // Register tranches (riskPremiumBps=0 initially, configured via setYieldDistribution)
        // Order: senior=idx0, mezzanine=idx1, junior=idx2
        await vault.addTranche({tranche: senior.target, riskPremiumBps: 0, enabled: true});
        await vault.addTranche({tranche: mezzanine.target, riskPremiumBps: 0, enabled: true});
        await vault.addTranche({tranche: junior.target, riskPremiumBps: 0, enabled: true});

        // Default yield distribution: baseReward 40%, senior 20%, mezzanine 20%, junior 20%
        await vault.setYieldDistribution(4000, [2000, 2000, 2000], [true, true, true]);

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    // ── Helpers ──────────────────────────────────────────────────────

    /** Mint mock USDC to `user`, deposit into MZUSD, return MZUSD balance. */
    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        await usdc.mint(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusd.target, usdcAmount6);
        await (await mzusd.connect(user).deposit(usdcAmount6)).wait();
        return await mzusd.balanceOf(user.address);
    }

    /** Deposit MZUSD into a tranche on behalf of `user`. */
    async function depositMZIntoTranche(user: any, tranche: Tranche, mzAmount18: bigint) {
        await mzusd.connect(user).approve(tranche.target, mzAmount18);
        await (await tranche.connect(user).deposit(mzAmount18, user.address)).wait();
    }

    /** Mint mock USDC directly to the reservoir to back future yield mints. */
    async function fundYieldUSDC(amountUSDC: bigint) {
        await usdc.mint(reservoir.target as string, amountUSDC);
    }

    /**
     * Deposit into tranches according to specified proportions of `totalUSDC`.
     *
     * Each entry in `allocations` maps a tranche to a user and a percentage (0-100)
     * of `totalUSDC` to deposit. Percentages do NOT need to sum to 100 — unallocated
     * USDC is simply not deposited.
     *
     * Example – Risk Premium Sheet scenario (30/30/10):
     * ```
     * await depositIntoTranches(to6(1_000_000), [
     *     {tranche: senior,    user: alice, pct: 30},
     *     {tranche: mezzanine, user: bob,   pct: 30},
     *     {tranche: junior,    user: carol, pct: 10},
     * ]);
     * ```
     */
    async function depositIntoTranches(
        totalUSDC: bigint,
        allocations: {tranche: Tranche; user: any; pct: number}[]
    ) {
        for (const {tranche, user, pct} of allocations) {
            const usdcAmount = (totalUSDC * BigInt(pct)) / 100n;
            if (usdcAmount === 0n) continue;
            const mzBalance = await mintMZUSDFor(user, usdcAmount);
            await depositMZIntoTranche(user, tranche, mzBalance);
        }
    }

    // ── Risk Premium Sheet scenarios ─────────────────────────────────

    describe("Risk Premium Sheet scenarios", () => {
        it("Scenario 1: 30/30/10 TVL split, senior 0% / mezz 18% / junior 12% risk premium, 10% protocol fee", async () => {
            const TOTAL_USDC = to6(1_000_000);
            const YIELD_USDC = to6(100_000);

            // ── Configure yield distribution ──────────────────────
            // riskPremium: senior=0%, mezzanine=12%, junior=18%
            // baseRewardBps = 10000 - (0 + 1200 + 1800) = 7000 (70%)
            await vault.setYieldDistribution(7000, [0, 1200, 1800], [true, true, true]);

            // Protocol fee = 10%, no performance fee
            await vault.setFeeRates(0, 1000);

            // ── Seed TVL: 30% senior, 30% mezz, 10% junior ──────
            await depositIntoTranches(TOTAL_USDC, [
                {tranche: senior, user: alice, pct: 30},
                {tranche: mezzanine, user: bob, pct: 30},
                {tranche: junior, user: carol, pct: 10},
            ]);

            // 30% idle MZUSD (not in any tranche)
            await mintMZUSDFor(deployer, (TOTAL_USDC * 30n) / 100n);

            // ── Verify initial state ─────────────────────────────
            const seniorTVL = await senior.totalAssets();
            const mezzTVL = await mezzanine.totalAssets();
            const juniorTVL = await junior.totalAssets();
            expect(seniorTVL).to.equal(to18(300_000));
            expect(mezzTVL).to.equal(to18(300_000));
            expect(juniorTVL).to.equal(to18(100_000));
            expect(await mzusd.totalSupply()).to.equal(to18(1_000_000));

            // All shares are 1:1 before yield
            const seniorPPSBefore = await senior.pricePerShare();
            const mezzPPSBefore = await mezzanine.pricePerShare();
            const juniorPPSBefore = await junior.pricePerShare();
            expect(seniorPPSBefore).to.equal(to18(1));
            expect(mezzPPSBefore).to.equal(to18(1));
            expect(juniorPPSBefore).to.equal(to18(1));

            // ── Distribute yield ─────────────────────────────────
            await time.increase(DAY);
            await fundYieldUSDC(YIELD_USDC);
            await vault.distributeYield(YIELD_USDC);

            // ── Expected yield math ──────────────────────────────
            //
            // mintedGross      = 100,000 MZUSD
            // protocolFee      = 100,000 × 10%       = 10,000 MZUSD
            // allocatable      = 100,000 − 10,000    = 90,000 MZUSD
            //
            // basePool         = 90,000 × 70%        = 63,000 MZUSD
            // totalTvl         = 300k + 300k + 100k   = 700,000 MZUSD
            //
            // ┌───────────┬──────────────────────────────────┬──────────────┬────────────┐
            // │ Tranche   │ baseShare (pool×tvl/totalTvl)    │ riskPremium  │ total      │
            // ├───────────┼──────────────────────────────────┼──────────────┼────────────┤
            // │ Senior    │ 63,000 × 300k/700k = 27,000     │ 90k×0% = 0   │ 27,000     │
            // │ Mezzanine │ 63,000 × 300k/700k = 27,000     │ 90k×18%=16.2k│ 43,200     │
            // │ Junior    │ remainder = 90k − 27k − 43.2k    │ (dust)       │ 19,800     │
            // └───────────┴──────────────────────────────────┴──────────────┴────────────┘
            //
            // Junior dust check: baseShare 9,000 + riskPremium 10,800 = 19,800
            // No rounding dust in this scenario (all divisions are exact).

            const allocatable = to18(90_000);
            const protocolFee = to18(10_000);
            const totalTvl = seniorTVL + mezzTVL + juniorTVL;
            const basePool = (allocatable * 7000n) / BPS;

            // Senior: base share only (riskPremiumBps = 0)
            const seniorBaseShare = (basePool * seniorTVL) / totalTvl;
            const expectedSeniorYield = seniorBaseShare; // 27,000

            // Mezzanine: base share + risk premium
            const mezzBaseShare = (basePool * mezzTVL) / totalTvl;
            const mezzRiskPremium = (allocatable * 1200n) / BPS;
            const expectedMezzYield = mezzBaseShare + mezzRiskPremium; // 43,200

            // Junior: dust catch-all (remainder after senior + mezzanine)
            const expectedJuniorYield = allocatable - expectedSeniorYield - expectedMezzYield; // 19,800

            // Verify human-readable values
            expect(basePool).to.equal(to18(63_000));
            expect(seniorBaseShare).to.equal(to18(27_000));
            expect(mezzBaseShare).to.equal(to18(27_000));
            expect(mezzRiskPremium).to.equal(to18(10_800));
            expect(expectedSeniorYield).to.equal(to18(27_000));
            expect(expectedMezzYield).to.equal(to18(37_800));
            expect(expectedJuniorYield).to.equal(to18(25_200));

            // ── Verify on-chain yield amounts ────────────────────
            expect(await senior.yieldStreamingAmount()).to.equal(expectedSeniorYield);
            expect(await mezzanine.yieldStreamingAmount()).to.equal(expectedMezzYield);
            expect(await junior.yieldStreamingAmount()).to.equal(expectedJuniorYield);

            // Protocol fee minted to carol (protocolFeeReceiver from init)
            expect(await mzusd.balanceOf(carol.address)).to.equal(protocolFee);

            // Vault retains no MZUSD
            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);

            // ── Verify APR from yield amounts (exact) ─────────────
            //
            // return (bps) = yield × 10,000 / TVL
            //
            // Senior:    27,000 / 300,000     =  9.0%   =  900 bps
            // Mezzanine: 37,800 / 300,000     = 12.6%   = 1260 bps
            // Junior:    25,200 / 100,000     = 25.2%   = 2520 bps

            const seniorReturn_bps = (expectedSeniorYield * BPS) / seniorTVL;
            const mezzReturn_bps = (expectedMezzYield * BPS) / mezzTVL;
            const juniorReturn_bps = (expectedJuniorYield * BPS) / juniorTVL;

            expect(seniorReturn_bps).to.equal(900n);
            expect(mezzReturn_bps).to.equal(1260n);
            expect(juniorReturn_bps).to.equal(2520n);

            // ── Cross-check: share price reflects yield after full stream
            await time.increase(DAY);

            const seniorPPSAfter = await senior.pricePerShare();
            const mezzPPSAfter = await mezzanine.pricePerShare();
            const juniorPPSAfter = await junior.pricePerShare();

            // OZ ERC-4626 virtual share offset causes up to 1 wei rounding
            // in convertToAssets, so allow ±1 wei on expected PPS.
            const WAD = to18(1);
            const expectedSeniorPPS = ((seniorTVL + expectedSeniorYield) * WAD) / seniorTVL;
            const expectedMezzPPS = ((mezzTVL + expectedMezzYield) * WAD) / mezzTVL;
            const expectedJuniorPPS = ((juniorTVL + expectedJuniorYield) * WAD) / juniorTVL;

            expect(seniorPPSAfter)
                .to.be.gte(expectedSeniorPPS - 1n)
                .and.lte(expectedSeniorPPS);
            expect(mezzPPSAfter)
                .to.be.gte(expectedMezzPPS - 1n)
                .and.lte(expectedMezzPPS);
            expect(juniorPPSAfter)
                .to.be.gte(expectedJuniorPPS - 1n)
                .and.lte(expectedJuniorPPS);
        });
    });
});
