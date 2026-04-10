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
    IssuanceVault,
    ReservoirUSDC,
    MZUSD,
    IERC20,
    Tranche,
    PolJuniorTranche,
    PauseManager,
} from "../typechain-types";
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

describe("IssuanceVault Yield Allocation Math", () => {
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
    let vault: IssuanceVault;
    let lossManagerRef: any;
    let navOracleRef: any;
    let navOracleSigner: any;

    let junior: Tranche;
    let mezzanine: Tranche;
    let senior: Tranche;
    let juniorPol: PolJuniorTranche;

    let whale: any;

    const DAY = 24 * 60 * 60;
    const BPS = 10_000n;
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
            unsafeAllow: ["constructor"],
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

        const SanctionsListFactory = await ethers.getContractFactory("MockSanctionsList", deployer);
        const sanctionsList = await SanctionsListFactory.deploy();
        const AllowlistFactory = await ethers.getContractFactory("Allowlist", deployer);
        const allowlist = await upgrades.deployProxy(
            AllowlistFactory,
            [accessManager.target, sanctionsList.target],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        );
        await allowlist.addBatch([deployer.address, alice.address, bob.address, carol.address]);

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                pauseManager.target,
                allowlist.target,
                usdcTotalSupply, // _hourlyLimitUSDC (max allowed)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, carol.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        })) as unknown as IssuanceVault;

        // ── Tranches ────────────────────────────────────────────────
        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);

        senior = (await upgrades.deployProxy(TrancheFactory, [1, 0, "Senior Tranche", "sMZUSD"], {
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

        junior = (await upgrades.deployProxy(TrancheFactory, [3, 0, "Junior Tranche", "JLT"], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target, false],
        })) as unknown as Tranche;

        const PolFactory = await ethers.getContractFactory("PolJuniorTranche", deployer);
        juniorPol = (await upgrades.deployProxy(PolFactory, [bob.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target],
        })) as unknown as PolJuniorTranche;

        const MockLossManagerFactory = await ethers.getContractFactory(
            "MockLossManagerRef",
            deployer
        );
        lossManagerRef = await MockLossManagerFactory.deploy(vault.target, mzusd.target);
        await lossManagerRef.waitForDeployment();

        const MockNavOracleFactory = await ethers.getContractFactory(
            "MockNavOracleAutomationRef",
            deployer
        );
        navOracleRef = await MockNavOracleFactory.deploy(
            vault.target,
            lossManagerRef.target,
            mzusd.target
        );
        await navOracleRef.waitForDeployment();
        navOracleSigner = await imp(navOracleRef.target as string);

        // ── Roles ───────────────────────────────────────────────────
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // IssuanceVault admin selectors
        const vaultSelectors = [
            vault.interface.getFunction("distributeYield").selector,
            vault.interface.getFunction("advanceEpoch").selector,
            vault.interface.getFunction("setLossManager").selector,
            vault.interface.getFunction("setNavOracle").selector,
            vault.interface.getFunction("registerTranche").selector,
            vault.interface.getFunction("setTrancheConfig").selector,
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

        // MZUSD admin selectors
        const mzusdSelectors = [mzusd.interface.getFunction("setVault").selector];
        await accessManager.setTargetFunctionRole(mzusd.target, mzusdSelectors, ADMIN_ROLE);

        // ── Wire contracts ──────────────────────────────────────────
        await mzusd.setVault(vault.target);
        await vault.setLossManager(lossManagerRef);
        await vault.setNavOracle(navOracleRef);

        // Register tranches (riskPremiumBps=0 initially, configured via setYieldDistribution)
        // Order: senior=idx0, mezzanine=idx1, junior=idx2, juniorPol=idx3
        await vault.registerTranche(senior.target);
        await vault.registerTranche(mezzanine.target);
        await vault.registerTranche(junior.target);
        await vault.registerTranche(juniorPol.target);

        // Default yield distribution: baseReward 40%, senior 20%, mezzanine 20%, junior 20%, juniorPol disabled
        await vault.setTrancheConfig(
            [
                {tranche: senior.target, riskPremiumBps: 2000, enabled: true},
                {tranche: mezzanine.target, riskPremiumBps: 2000, enabled: true},
                {tranche: junior.target, riskPremiumBps: 2000, enabled: true},
                {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
            ],
            [false, false, false, false],
            4000
        );

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    // ── Helpers ──────────────────────────────────────────────────────

    /** Transfer USDC from whale to `user`, deposit into MZUSD, return MZUSD balance. */
    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusd.target, usdcAmount6);
        await (await mzusd.connect(user).deposit(usdcAmount6)).wait();
        return await mzusd.balanceOf(user.address);
    }

    /** Deposit MZUSD into a tranche on behalf of `user`. */
    async function depositMZIntoTranche(user: any, tranche: Tranche, mzAmount18: bigint) {
        await mzusd.connect(user).approve(tranche.target, mzAmount18);
        await (await tranche.connect(user).deposit(mzAmount18, user.address)).wait();
    }

    /** Transfer USDC from whale to the reservoir to back future yield mints. */
    async function fundYieldUSDC(amountUSDC: bigint) {
        await usdc.connect(whale).transfer(reservoir.target as string, amountUSDC);
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

    /** Deposit MZUSD into the POL Junior tranche (direct transfer, user deposits disabled). */
    async function depositMZIntoPol(mzAmount18: bigint) {
        await mzusd.connect(deployer).transfer(juniorPol.target as string, mzAmount18);
    }

    // ── Risk Premium Sheet scenarios ─────────────────────────────────

    describe("Risk Premium Sheet scenarios", () => {
        it("Scenario 1: 30/30/10 TVL split, senior 0% / mezz 12% / junior 18% risk premium, 10% protocol fee", async () => {
            const TOTAL_USDC = to6(1_000_000);
            const YIELD_USDC = to6(100_000);

            // ── Configure yield distribution ──────────────────────
            // riskPremium: senior=0%, mezzanine=12%, junior=18%
            // baseRewardBps = 10000 - (0 + 1200 + 1800) = 7000 (70%)
            await vault.setTrancheConfig(
                [
                    {tranche: senior.target, riskPremiumBps: 0, enabled: true},
                    {tranche: mezzanine.target, riskPremiumBps: 1200, enabled: true},
                    {tranche: junior.target, riskPremiumBps: 1800, enabled: true},
                    {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                ],
                [false, false, false, false],
                7000
            );

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
            await vault.connect(navOracleSigner).distributeYield(YIELD_USDC);

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
            // │ Senior    │ 63,000 × 300k/700k = 27,000      │ 90k×0% = 0   │ 27,000     │
            // │ Mezzanine │ 63,000 × 300k/700k = 27,000      │90k×12%=10.8k │ 37,800     │
            // │ Junior    │ remainder = 90k − 27k − 37.8k    │ (dust)       │ 25,200     │
            // └───────────┴──────────────────────────────────┴──────────────┴────────────┘
            //
            // Junior cross-check: baseShare 9,000 + riskPremium 16,200 = 25,200
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
            const expectedMezzYield = mezzBaseShare + mezzRiskPremium; // 37,800

            // Junior: dust catch-all (remainder after senior + mezzanine)
            const expectedJuniorYield = allocatable - expectedSeniorYield - expectedMezzYield; // 25,200

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

            // IssuanceVault retains no MZUSD
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

        it("Scenario 1b: 30/30/8/2 TVL split with paired Junior+JuniorPOL — same as Scenario 1 but pair splits the junior share", async () => {
            const TOTAL_USDC = to6(1_000_000);
            const YIELD_USDC = to6(100_000);

            // ── Configure yield distribution ──────────────────────
            // Same risk premiums as Scenario 1: senior=0%, mezzanine=12%, junior=18%
            // Junior and JuniorPOL are paired; JuniorPOL riskPremiumBps must be 0.
            // baseRewardBps = 10000 - (0 + 1200 + 1800 + 0) = 7000 (70%)
            await vault.setTrancheConfig(
                [
                    {tranche: senior.target, riskPremiumBps: 0, enabled: true},
                    {tranche: mezzanine.target, riskPremiumBps: 1200, enabled: true},
                    {tranche: junior.target, riskPremiumBps: 1800, enabled: true},
                    {tranche: juniorPol.target, riskPremiumBps: 0, enabled: true},
                ],
                [false, false, true, true],
                7000
            );

            // Protocol fee = 10%, no performance fee (same as Scenario 1)
            await vault.setFeeRates(0, 1000);

            // ── Seed TVL: 30% senior, 30% mezz, 8% junior, 2% juniorPOL ──
            await depositIntoTranches(TOTAL_USDC, [
                {tranche: senior, user: alice, pct: 30},
                {tranche: mezzanine, user: bob, pct: 30},
                {tranche: junior, user: carol, pct: 8},
            ]);
            // POL: mint MZUSD and transfer directly (user deposits disabled)
            const polMz = await mintMZUSDFor(deployer, (TOTAL_USDC * 2n) / 100n);
            await depositMZIntoPol(polMz);

            // 30% idle MZUSD (not in any tranche)
            await mintMZUSDFor(deployer, (TOTAL_USDC * 30n) / 100n);

            // ── Verify initial state ─────────────────────────────
            const seniorTVL = await senior.totalAssets();
            const mezzTVL = await mezzanine.totalAssets();
            const juniorTVL = await junior.totalAssets();
            const juniorPolTVL = await juniorPol.totalAssets();
            expect(seniorTVL).to.equal(to18(300_000));
            expect(mezzTVL).to.equal(to18(300_000));
            expect(juniorTVL).to.equal(to18(80_000));
            expect(juniorPolTVL).to.equal(to18(20_000));
            expect(await mzusd.totalSupply()).to.equal(to18(1_000_000));

            // ── Distribute yield ─────────────────────────────────
            await time.increase(DAY);
            await fundYieldUSDC(YIELD_USDC);
            await vault.connect(navOracleSigner).distributeYield(YIELD_USDC);

            // ── Expected yield math ──────────────────────────────
            //
            // mintedGross      = 100,000 MZUSD
            // protocolFee      = 100,000 × 10%       = 10,000 MZUSD
            // allocatable      = 100,000 − 10,000    = 90,000 MZUSD
            //
            // basePool         = 90,000 × 70%        = 63,000 MZUSD
            // totalTvl         = 300k + 300k + 80k + 20k = 700,000 MZUSD
            //
            // Same totalTvl as Scenario 1 (700k), so senior & mezzanine
            // get identical amounts:
            //
            // ┌───────────────┬──────────────────────────────────────┬──────────────┬────────────┐
            // │ Tranche       │ baseShare (pool×tvl/totalTvl)        │ riskPremium  │ total      │
            // ├───────────────┼──────────────────────────────────────┼──────────────┼────────────┤
            // │ Senior        │ 63,000 × 300k/700k = 27,000          │ 90k×0% = 0   │ 27,000     │
            // │ Mezzanine     │ 63,000 × 300k/700k = 27,000          │90k×12%=10.8k │ 37,800     │
            // │ Junior+POL    │ combined base + risk premium          │ (pair)       │ 25,200     │
            // │   → Junior    │ 25,200 × 80k/100k = 20,160           │              │ 20,160     │
            // │   → JuniorPOL │ 25,200 − 20,160    = 5,040           │              │  5,040     │
            // └───────────────┴──────────────────────────────────────┴──────────────┴────────────┘
            //
            // Junior+POL pair total cross-check:
            //   pairTvl   = 80k + 20k = 100k
            //   baseShare = 63,000 × 100k/700k = 9,000
            //   riskPrem  = 90,000 × 18% = 16,200
            //   total     = 9,000 + 16,200 = 25,200 (same as Scenario 1 junior solo)

            const allocatable = to18(90_000);
            const protocolFee = to18(10_000);
            const totalTvl = seniorTVL + mezzTVL + juniorTVL + juniorPolTVL;
            const basePool = (allocatable * 7000n) / BPS;

            // Senior: base share only (identical to Scenario 1)
            const seniorBaseShare = (basePool * seniorTVL) / totalTvl;
            const expectedSeniorYield = seniorBaseShare; // 27,000

            // Mezzanine: base share + risk premium (identical to Scenario 1)
            const mezzBaseShare = (basePool * mezzTVL) / totalTvl;
            const mezzRiskPremium = (allocatable * 1200n) / BPS;
            const expectedMezzYield = mezzBaseShare + mezzRiskPremium; // 37,800

            // Junior+POL pair: dust catch-all (last non-zero index is in the pair)
            const pairTotal = allocatable - expectedSeniorYield - expectedMezzYield; // 25,200
            const pairTvl = juniorTVL + juniorPolTVL;
            const expectedJuniorYield = (pairTotal * juniorTVL) / pairTvl; // 20,160
            const expectedJuniorPolYield = pairTotal - expectedJuniorYield; //  5,040

            // Verify key intermediates match Scenario 1
            expect(basePool).to.equal(to18(63_000));
            expect(expectedSeniorYield).to.equal(to18(27_000));
            expect(expectedMezzYield).to.equal(to18(37_800));
            expect(pairTotal).to.equal(to18(25_200));
            expect(expectedJuniorYield).to.equal(to18(20_160));
            expect(expectedJuniorPolYield).to.equal(to18(5_040));

            // ── Verify on-chain yield amounts ────────────────────
            expect(await senior.yieldStreamingAmount()).to.equal(expectedSeniorYield);
            expect(await mezzanine.yieldStreamingAmount()).to.equal(expectedMezzYield);
            expect(await junior.yieldStreamingAmount()).to.equal(expectedJuniorYield);
            // POL tranche forwards yield immediately to polPayout (bob.address),
            // so check bob's MZUSD balance instead of yieldStreamingAmount.
            expect(await mzusd.balanceOf(bob.address)).to.equal(expectedJuniorPolYield);

            // POL tranche TVL unchanged (yield was forwarded out)
            expect(await juniorPol.totalAssets()).to.equal(juniorPolTVL);

            // Protocol fee minted to carol (protocolFeeReceiver from init)
            expect(await mzusd.balanceOf(carol.address)).to.equal(protocolFee);

            // Vault retains no MZUSD
            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);

            // ── Verify APR from yield amounts (exact) ─────────────
            //
            // Senior:     27,000 / 300,000     =  9.0%   =  900 bps  (same as Scenario 1)
            // Mezzanine:  37,800 / 300,000     = 12.6%   = 1260 bps  (same as Scenario 1)
            // Junior:     20,160 /  80,000     = 25.2%   = 2520 bps  (same as Scenario 1)
            // JuniorPOL:   5,040 /  20,000     = 25.2%   = 2520 bps  (matches junior — paired split is fair)

            const seniorReturn_bps = (expectedSeniorYield * BPS) / seniorTVL;
            const mezzReturn_bps = (expectedMezzYield * BPS) / mezzTVL;
            const juniorReturn_bps = (expectedJuniorYield * BPS) / juniorTVL;
            const juniorPolReturn_bps = (expectedJuniorPolYield * BPS) / juniorPolTVL;

            expect(seniorReturn_bps).to.equal(900n);
            expect(mezzReturn_bps).to.equal(1260n);
            expect(juniorReturn_bps).to.equal(2520n);
            expect(juniorPolReturn_bps).to.equal(2520n); // same APR as junior (fair TVL split)

            // ── Cross-check: share price reflects yield after full stream
            await time.increase(DAY);

            const seniorPPSAfter = await senior.pricePerShare();
            const mezzPPSAfter = await mezzanine.pricePerShare();
            const juniorPPSAfter = await junior.pricePerShare();

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

        it("Scenario 2: 45/40 TVL split, senior 0% / junior 30% risk premium, 10% protocol fee", async () => {
            const TOTAL_USDC = to6(1_000_000);
            const YIELD_USDC = to6(80_000); // 8% APR on 1M

            // ── Configure yield distribution ──────────────────────
            // Mezzanine disabled, no deposits there.
            // riskPremium: senior=0%, mezzanine=0% (disabled), junior=30%
            // baseRewardBps = 10000 - (0 + 0 + 3000) = 7000 (70%)
            await vault.setTrancheConfig(
                [
                    {tranche: senior.target, riskPremiumBps: 0, enabled: true},
                    {tranche: mezzanine.target, riskPremiumBps: 0, enabled: false},
                    {tranche: junior.target, riskPremiumBps: 3000, enabled: true},
                    {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                ],
                [false, false, false, false],
                7000
            );

            // Protocol fee = 10%, no performance fee
            await vault.setFeeRates(0, 1000);

            // ── Seed TVL: 45% senior, 40% junior, 15% idle ────
            await depositIntoTranches(TOTAL_USDC, [
                {tranche: senior, user: alice, pct: 45},
                {tranche: junior, user: carol, pct: 40},
            ]);

            // 15% idle MZUSD (unstaked)
            await mintMZUSDFor(deployer, (TOTAL_USDC * 15n) / 100n);

            // ── Verify initial state ─────────────────────────────
            const seniorTVL = await senior.totalAssets();
            const juniorTVL = await junior.totalAssets();
            expect(seniorTVL).to.equal(to18(450_000));
            expect(juniorTVL).to.equal(to18(400_000));
            expect(await mezzanine.totalAssets()).to.equal(0n); // disabled, no deposits
            expect(await mzusd.totalSupply()).to.equal(to18(1_000_000));

            // All shares are 1:1 before yield
            expect(await senior.pricePerShare()).to.equal(to18(1));
            expect(await junior.pricePerShare()).to.equal(to18(1));

            // ── Distribute yield ─────────────────────────────────
            await time.increase(DAY);
            await fundYieldUSDC(YIELD_USDC);
            await vault.connect(navOracleSigner).distributeYield(YIELD_USDC);

            // ── Expected yield math ──────────────────────────────
            //
            // mintedGross      = 80,000 MZUSD
            // protocolFee      = 80,000 × 10%        = 8,000 MZUSD
            // allocatable      = 80,000 − 8,000      = 72,000 MZUSD
            //
            // basePool         = 72,000 × 70%        = 50,400 MZUSD
            // totalTvl         = 450k + 400k          = 850,000 MZUSD
            //
            // TVL ratio is 45:40 (= 9:8), so 9/17 and 8/17 — not evenly
            // divisible. Values are computed via integer division matching
            // the contract's exact Solidity arithmetic.
            //
            // ┌───────────┬──────────────────────────────────┬────────────────┬──────────────┐
            // │ Tranche   │ baseShare (pool×tvl/totalTvl)    │ riskPremium    │ total        │
            // ├───────────┼──────────────────────────────────┼────────────────┼──────────────┤
            // │ Senior    │ 50,400 × 450k/850k ≈ 26,682.35   │ 72k×0% = 0     │ ≈ 26,682.35  │
            // │ Junior    │ remainder = 72k − senior         │ (dust)         │ ≈ 45,317.65  │
            // └───────────┴──────────────────────────────────┴────────────────┴──────────────┘
            //
            // Junior cross-check: base ≈ 23,717.65 + risk 21,600 ≈ 45,317.65

            const allocatable = to18(72_000);
            const protocolFee = to18(8_000);
            const totalTvl = seniorTVL + juniorTVL;
            const basePool = (allocatable * 7000n) / BPS;

            // Senior: base share only (riskPremiumBps = 0)
            const seniorBaseShare = (basePool * seniorTVL) / totalTvl;
            const expectedSeniorYield = seniorBaseShare;

            // Junior: dust catch-all (remainder after senior)
            const expectedJuniorYield = allocatable - expectedSeniorYield;

            // Verify clean intermediates
            expect(allocatable).to.equal(to18(72_000));
            expect(basePool).to.equal(to18(50_400));

            // ── Verify on-chain yield amounts ────────────────────
            expect(await senior.yieldStreamingAmount()).to.equal(expectedSeniorYield);
            expect(await junior.yieldStreamingAmount()).to.equal(expectedJuniorYield);
            expect(await mezzanine.yieldStreamingAmount()).to.equal(0n); // disabled

            // Protocol fee minted to carol
            expect(await mzusd.balanceOf(carol.address)).to.equal(protocolFee);

            // IssuanceVault retains no MZUSD
            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);

            // ── Verify APR from yield amounts ───────────────────
            //
            // Integer division truncates fractional bps:
            // Senior: ≈ 5.93% → 592 bps (spreadsheet rounds to 5.93%)
            // Junior: ≈ 11.33% → 1132 bps (spreadsheet rounds to 11.33%)

            const seniorReturn_bps = (expectedSeniorYield * BPS) / seniorTVL;
            const juniorReturn_bps = (expectedJuniorYield * BPS) / juniorTVL;

            expect(seniorReturn_bps).to.equal(592n);
            expect(juniorReturn_bps).to.equal(1132n);

            // ── Cross-check: share price reflects yield after full stream
            await time.increase(DAY);

            const seniorPPSAfter = await senior.pricePerShare();
            const juniorPPSAfter = await junior.pricePerShare();

            const WAD = to18(1);
            const expectedSeniorPPS = ((seniorTVL + expectedSeniorYield) * WAD) / seniorTVL;
            const expectedJuniorPPS = ((juniorTVL + expectedJuniorYield) * WAD) / juniorTVL;

            expect(seniorPPSAfter)
                .to.be.gte(expectedSeniorPPS - 1n)
                .and.lte(expectedSeniorPPS);
            expect(juniorPPSAfter)
                .to.be.gte(expectedJuniorPPS - 1n)
                .and.lte(expectedJuniorPPS);
        });

        it("Scenario 3 (Strata-style): 80/20 TVL split, no unstaked, senior 0% / junior 29.03% risk premium, 0% fees", async () => {
            const TOTAL_USDC = to6(1_000_000);
            const YIELD_USDC = to6(110_000); // 11% APR on 1M

            // ── Configure yield distribution ──────────────────────
            // Mezzanine disabled, no deposits there.
            // riskPremium: senior=0%, mezzanine=0% (disabled), junior=29.03%
            // baseRewardBps = 10000 - (0 + 0 + 2903) = 7097 (70.97%)
            await vault.setTrancheConfig(
                [
                    {tranche: senior.target, riskPremiumBps: 0, enabled: true},
                    {tranche: mezzanine.target, riskPremiumBps: 0, enabled: false},
                    {tranche: junior.target, riskPremiumBps: 2903, enabled: true},
                    {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                ],
                [false, false, false, false],
                7097
            );

            // ── Seed TVL: 80% senior, 20% junior, 0% idle ─────
            await depositIntoTranches(TOTAL_USDC, [
                {tranche: senior, user: alice, pct: 80},
                {tranche: junior, user: carol, pct: 20},
            ]);

            // No idle MZUSD — all supply is in tranches

            // ── Verify initial state ─────────────────────────────
            const seniorTVL = await senior.totalAssets();
            const juniorTVL = await junior.totalAssets();
            expect(seniorTVL).to.equal(to18(800_000));
            expect(juniorTVL).to.equal(to18(200_000));
            expect(await mezzanine.totalAssets()).to.equal(0n); // disabled, no deposits
            expect(await mzusd.totalSupply()).to.equal(to18(1_000_000));

            // All shares are 1:1 before yield
            expect(await senior.pricePerShare()).to.equal(to18(1));
            expect(await junior.pricePerShare()).to.equal(to18(1));

            // ── Distribute yield ─────────────────────────────────
            await time.increase(DAY);
            await fundYieldUSDC(YIELD_USDC);
            await vault.connect(navOracleSigner).distributeYield(YIELD_USDC);

            // ── Expected yield math ──────────────────────────────
            //
            // mintedGross      = 110,000 MZUSD
            // protocolFee      = 0 (no fees)
            // allocatable      = 110,000 MZUSD
            //
            // basePool         = 110,000 × 70.97%     = 78,067 MZUSD
            // totalTvl         = 800k + 200k           = 1,000,000 MZUSD
            //
            // TVL ratio is 80:20 (= 4:1). basePool × 4/5 = 78,067 × 4/5
            // = 62,453.6 — non-integer, computed via integer division.
            //
            // ┌───────────┬──────────────────────────────────┬─────────────────┬──────────────┐
            // │ Tranche   │ baseShare (pool×tvl/totalTvl)    │ riskPremium     │ total        │
            // ├───────────┼──────────────────────────────────┼─────────────────┼──────────────┤
            // │ Senior    │ 78,067 × 800k/1M ≈ 62,453.6      │ 110k×0% = 0     │ ≈ 62,453.6   │
            // │ Junior    │ remainder = 110k − senior        │ (dust)          │ ≈ 47,546.4   │
            // └───────────┴──────────────────────────────────┴─────────────────┴──────────────┘
            //
            // Junior cross-check: base ≈ 15,613.4 + risk 31,933 ≈ 47,546.4

            const allocatable = to18(110_000);
            const totalTvl = seniorTVL + juniorTVL;
            const basePool = (allocatable * 7097n) / BPS;

            // Senior: base share only (riskPremiumBps = 0)
            const seniorBaseShare = (basePool * seniorTVL) / totalTvl;
            const expectedSeniorYield = seniorBaseShare;

            // Junior: dust catch-all (remainder after senior)
            const expectedJuniorYield = allocatable - expectedSeniorYield;

            // Verify clean intermediates
            expect(allocatable).to.equal(to18(110_000));
            expect(basePool).to.equal(to18(78_067));

            // ── Verify on-chain yield amounts ────────────────────
            expect(await senior.yieldStreamingAmount()).to.equal(expectedSeniorYield);
            expect(await junior.yieldStreamingAmount()).to.equal(expectedJuniorYield);
            expect(await mezzanine.yieldStreamingAmount()).to.equal(0n); // disabled

            // No fees, so no MZUSD minted to fee receivers
            expect(await mzusd.balanceOf(bob.address)).to.equal(0n); // performanceFeeReceiver
            expect(await mzusd.balanceOf(carol.address)).to.equal(0n); // protocolFeeReceiver

            // IssuanceVault retains no MZUSD
            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);

            // ── Verify return from yield amounts ────────────────
            //
            // Integer division truncates fractional bps:
            // Senior: ≈ 7.81% → 780 bps (spreadsheet: 8.05% at 11.34% APR)
            // Junior: ≈ 23.77% → 2377 bps (spreadsheet: 24.51% at 11.34% APR)

            const seniorReturn_bps = (expectedSeniorYield * BPS) / seniorTVL;
            const juniorReturn_bps = (expectedJuniorYield * BPS) / juniorTVL;

            expect(seniorReturn_bps).to.equal(780n);
            expect(juniorReturn_bps).to.equal(2377n);

            // ── Cross-check: share price reflects yield after full stream
            await time.increase(DAY);

            const seniorPPSAfter = await senior.pricePerShare();
            const juniorPPSAfter = await junior.pricePerShare();

            const WAD = to18(1);
            const expectedSeniorPPS = ((seniorTVL + expectedSeniorYield) * WAD) / seniorTVL;
            const expectedJuniorPPS = ((juniorTVL + expectedJuniorYield) * WAD) / juniorTVL;

            expect(seniorPPSAfter)
                .to.be.gte(expectedSeniorPPS - 1n)
                .and.lte(expectedSeniorPPS);
            expect(juniorPPSAfter)
                .to.be.gte(expectedJuniorPPS - 1n)
                .and.lte(expectedJuniorPPS);
        });
    });

    // ── setTrancheConfig unit tests ───────────────────────────────

    describe("setTrancheConfig", () => {
        it("should update baseRewardBps, per-tranche riskPremiumBps and enabled flags", async () => {
            // 3 tranches registered: senior=idx0, mezzanine=idx1, junior=idx2
            // Disabled tranche must have riskPremiumBps = 0.
            await expect(
                vault.setTrancheConfig(
                    [
                        {tranche: senior.target, riskPremiumBps: 1000, enabled: true},
                        {tranche: mezzanine.target, riskPremiumBps: 0, enabled: false},
                        {tranche: junior.target, riskPremiumBps: 2000, enabled: true},
                        {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                    ],
                    [false, false, false, false],
                    7000
                )
            ).to.emit(vault, "TrancheConfigUpdated");

            expect(await vault.baseRewardBps()).to.equal(7000);

            const t0 = await vault.tranches(0);
            const t1 = await vault.tranches(1);
            const t2 = await vault.tranches(2);

            expect(t0.riskPremiumBps).to.equal(1000);
            expect(t0.enabled).to.equal(true);

            expect(t1.riskPremiumBps).to.equal(0);
            expect(t1.enabled).to.equal(false);

            expect(t2.riskPremiumBps).to.equal(2000);
            expect(t2.enabled).to.equal(true);
        });

        it("should revert when isPairedWithNext array length does not match tranches", async () => {
            await expect(
                vault.setTrancheConfig(
                    [
                        {tranche: senior.target, riskPremiumBps: 2500, enabled: true},
                        {tranche: mezzanine.target, riskPremiumBps: 2500, enabled: true},
                        {tranche: junior.target, riskPremiumBps: 2500, enabled: true},
                        {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                    ],
                    [false, false, false],
                    2500
                )
            ).to.be.revertedWithCustomError(vault, "LengthMismatch");
        });

        it("should revert when baseRewardBps + sum(riskPremiumsBps) != 10000", async () => {
            // Total = 5000 + 1000 + 1000 + 1000 + 0 = 8000 (< 10000)
            await expect(
                vault.setTrancheConfig(
                    [
                        {tranche: senior.target, riskPremiumBps: 1000, enabled: true},
                        {tranche: mezzanine.target, riskPremiumBps: 1000, enabled: true},
                        {tranche: junior.target, riskPremiumBps: 1000, enabled: true},
                        {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                    ],
                    [false, false, false, false],
                    5000
                )
            ).to.be.revertedWithCustomError(vault, "InvalidYieldDistribution");

            // Total = 5000 + 2000 + 2000 + 2000 + 0 = 11000 (> 10000)
            await expect(
                vault.setTrancheConfig(
                    [
                        {tranche: senior.target, riskPremiumBps: 2000, enabled: true},
                        {tranche: mezzanine.target, riskPremiumBps: 2000, enabled: true},
                        {tranche: junior.target, riskPremiumBps: 2000, enabled: true},
                        {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                    ],
                    [false, false, false, false],
                    5000
                )
            ).to.be.revertedWithCustomError(vault, "InvalidYieldDistribution");
        });

        it("should revert when second tranche in a pair has riskPremiumBps != 0", async () => {
            await expect(
                vault.setTrancheConfig(
                    [
                        {tranche: senior.target, riskPremiumBps: 2000, enabled: true},
                        {tranche: mezzanine.target, riskPremiumBps: 1000, enabled: true},
                        {tranche: junior.target, riskPremiumBps: 0, enabled: true},
                        {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                    ],
                    [true, true, false, false],
                    7000
                )
            ).to.be.revertedWithCustomError(vault, "PairedTrancheRiskPremiumMustBeZero");
        });

        it("should revert when disabled tranche has non-zero riskPremiumBps", async () => {
            await expect(
                vault.setTrancheConfig(
                    [
                        {tranche: senior.target, riskPremiumBps: 5000, enabled: true},
                        {tranche: mezzanine.target, riskPremiumBps: 3000, enabled: false},
                        {tranche: junior.target, riskPremiumBps: 2000, enabled: true},
                        {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                    ],
                    [false, false, false, false],
                    0
                )
            )
                .to.be.revertedWithCustomError(vault, "DisabledTrancheHasRiskPremium")
                .withArgs(mezzanine.target);
        });

        it("should accept disabled tranche with zero riskPremiumBps", async () => {
            await expect(
                vault.setTrancheConfig(
                    [
                        {tranche: senior.target, riskPremiumBps: 5000, enabled: true},
                        {tranche: mezzanine.target, riskPremiumBps: 0, enabled: false},
                        {tranche: junior.target, riskPremiumBps: 5000, enabled: true},
                        {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                    ],
                    [false, false, false, false],
                    0
                )
            ).to.emit(vault, "TrancheConfigUpdated");
        });

        it("should accept paired tranches when second has riskPremiumBps = 0", async () => {
            await expect(
                vault.setTrancheConfig(
                    [
                        {tranche: senior.target, riskPremiumBps: 3000, enabled: true},
                        {tranche: mezzanine.target, riskPremiumBps: 0, enabled: true},
                        {tranche: junior.target, riskPremiumBps: 0, enabled: true},
                        {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                    ],
                    [true, true, false, false],
                    7000
                )
            ).to.emit(vault, "TrancheConfigUpdated");
        });

        it("should round-trip pair flags and clear stale pairing on reconfiguration", async () => {
            await vault.setTrancheConfig(
                [
                    {tranche: senior.target, riskPremiumBps: 3000, enabled: true},
                    {tranche: mezzanine.target, riskPremiumBps: 0, enabled: true},
                    {tranche: junior.target, riskPremiumBps: 0, enabled: true},
                    {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                ],
                [true, true, false, false],
                7000
            );

            expect(await vault.tranchePairedTo(senior.target)).to.equal(mezzanine.target);
            expect(await vault.tranchePairedTo(mezzanine.target)).to.equal(senior.target);
            expect(await vault.tranchePairedTo(junior.target)).to.equal(ethers.ZeroAddress);

            const [orderBefore, flagsBefore] = await vault.getTrancheOrderAndPairs();
            expect(orderBefore).to.deep.equal([
                senior.target,
                mezzanine.target,
                junior.target,
                juniorPol.target,
            ]);
            expect(flagsBefore).to.deep.equal([true, true, false, false]);

            await vault.setTrancheConfig(
                [
                    {tranche: junior.target, riskPremiumBps: 0, enabled: true},
                    {tranche: senior.target, riskPremiumBps: 0, enabled: true},
                    {tranche: mezzanine.target, riskPremiumBps: 0, enabled: true},
                    {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                ],
                [false, false, false, false],
                10000
            );

            expect(await vault.tranchePairedTo(senior.target)).to.equal(ethers.ZeroAddress);
            expect(await vault.tranchePairedTo(mezzanine.target)).to.equal(ethers.ZeroAddress);
            expect(await vault.tranchePairedTo(junior.target)).to.equal(ethers.ZeroAddress);

            const [orderAfter, flagsAfter] = await vault.getTrancheOrderAndPairs();
            expect(orderAfter).to.deep.equal([
                junior.target,
                senior.target,
                mezzanine.target,
                juniorPol.target,
            ]);
            expect(flagsAfter).to.deep.equal([false, false, false, false]);
        });
    });

    // ── Paired tranche yield distribution ────────────────────────────

    describe("Paired tranche yield distribution", () => {
        it("Paired tranches receive combined base + risk premium, split by TVL", async () => {
            const TOTAL_USDC = to6(1_000_000);
            const YIELD_USDC = to6(100_000);

            // senior + mezzanine paired, junior solo
            // riskPremium: senior=20% (pair premium), mezzanine=0% (required), junior=10%
            // baseRewardBps = 10000 - (2000 + 0 + 1000 + 0) = 7000
            await vault.setTrancheConfig(
                [
                    {tranche: senior.target, riskPremiumBps: 2000, enabled: true},
                    {tranche: mezzanine.target, riskPremiumBps: 0, enabled: true},
                    {tranche: junior.target, riskPremiumBps: 1000, enabled: true},
                    {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                ],
                [true, true, false, false],
                7000
            );

            // TVL: senior=400k, mezzanine=200k, junior=100k
            await depositIntoTranches(TOTAL_USDC, [
                {tranche: senior, user: alice, pct: 40},
                {tranche: mezzanine, user: bob, pct: 20},
                {tranche: junior, user: carol, pct: 10},
            ]);

            const seniorTVL = await senior.totalAssets();
            const mezzTVL = await mezzanine.totalAssets();
            const juniorTVL = await junior.totalAssets();
            expect(seniorTVL).to.equal(to18(400_000));
            expect(mezzTVL).to.equal(to18(200_000));
            expect(juniorTVL).to.equal(to18(100_000));

            const allocatable = to18(100_000);
            const totalTvl = seniorTVL + mezzTVL + juniorTVL;
            const basePool = (allocatable * 7000n) / BPS;

            // Pair (senior+mezzanine): combined base + risk premium
            const pairTvl = seniorTVL + mezzTVL;
            const pairBaseShare = (basePool * pairTvl) / totalTvl;
            const pairRiskPremium = (allocatable * 2000n) / BPS; // senior's riskPremiumBps
            const pairTotal = pairBaseShare + pairRiskPremium;

            // Split by TVL: senior gets 400k/600k, mezzanine gets 200k/600k
            const expectedSeniorYield = (pairTotal * seniorTVL) / pairTvl;
            const expectedMezzYield = pairTotal - expectedSeniorYield;

            // Junior: dust catch-all (last non-zero tranche)
            const expectedJuniorYield = allocatable - pairTotal;

            await time.increase(DAY);
            await fundYieldUSDC(YIELD_USDC);
            await vault.connect(navOracleSigner).distributeYield(YIELD_USDC);

            expect(await senior.yieldStreamingAmount()).to.equal(expectedSeniorYield);
            expect(await mezzanine.yieldStreamingAmount()).to.equal(expectedMezzYield);
            expect(await junior.yieldStreamingAmount()).to.equal(expectedJuniorYield);
            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });

        it("Paired tranche with one having 0 TVL — entire pair share goes to the other", async () => {
            const YIELD_USDC = to6(50_000);

            // senior + mezzanine paired, junior solo
            await vault.setTrancheConfig(
                [
                    {tranche: senior.target, riskPremiumBps: 2000, enabled: true},
                    {tranche: mezzanine.target, riskPremiumBps: 0, enabled: true},
                    {tranche: junior.target, riskPremiumBps: 1000, enabled: true},
                    {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                ],
                [true, true, false, false],
                7000
            );

            // Only deposit into senior (mezzanine has 0 TVL) and junior
            await depositIntoTranches(to6(500_000), [
                {tranche: senior, user: alice, pct: 60},
                {tranche: junior, user: carol, pct: 20},
            ]);

            const seniorTVL = await senior.totalAssets();
            const mezzTVL = await mezzanine.totalAssets();
            const juniorTVL = await junior.totalAssets();
            expect(mezzTVL).to.equal(0n);

            const allocatable = to18(50_000);
            const totalTvl = seniorTVL + juniorTVL; // mezzanine has 0 TVL
            const basePool = (allocatable * 7000n) / BPS;

            // Pair: pairTvl = seniorTVL (mezzTVL is 0), so all goes to senior
            const pairTvl = seniorTVL; // + 0
            const pairBaseShare = (basePool * pairTvl) / totalTvl;
            const pairRiskPremium = (allocatable * 2000n) / BPS;
            const pairTotal = pairBaseShare + pairRiskPremium;

            // All pair yield goes to senior (mezzanine has 0 TVL)
            const expectedSeniorYield = pairTotal;

            // Junior: dust catch-all
            const expectedJuniorYield = allocatable - pairTotal;

            await time.increase(DAY);
            await fundYieldUSDC(YIELD_USDC);
            await vault.connect(navOracleSigner).distributeYield(YIELD_USDC);

            expect(await senior.yieldStreamingAmount()).to.equal(expectedSeniorYield);
            expect(await mezzanine.yieldStreamingAmount()).to.equal(0n);
            expect(await junior.yieldStreamingAmount()).to.equal(expectedJuniorYield);
            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });

        it("Dust assignment works when paired tranche is last", async () => {
            const YIELD_USDC = to6(77_777);

            // junior solo first, then senior + mezzanine paired (last)
            await vault.setTrancheConfig(
                [
                    {tranche: junior.target, riskPremiumBps: 1000, enabled: true},
                    {tranche: senior.target, riskPremiumBps: 2000, enabled: true},
                    {tranche: mezzanine.target, riskPremiumBps: 0, enabled: true},
                    {tranche: juniorPol.target, riskPremiumBps: 0, enabled: false},
                ],
                [false, true, true, false],
                7000
            );

            // TVL: junior=100k, senior=300k, mezzanine=200k
            await depositIntoTranches(to6(600_000), [
                {tranche: junior, user: carol, pct: 16}, // ~100k
                {tranche: senior, user: alice, pct: 50}, // 300k
                {tranche: mezzanine, user: bob, pct: 33}, // ~200k
            ]);

            const juniorTVL = await junior.totalAssets();
            const seniorTVL = await senior.totalAssets();
            const mezzTVL = await mezzanine.totalAssets();

            const allocatable = to18(77_777);
            const totalTvl = juniorTVL + seniorTVL + mezzTVL;
            const basePool = (allocatable * 7000n) / BPS;

            // Junior solo: base + risk premium
            const juniorBaseShare = (basePool * juniorTVL) / totalTvl;
            const juniorRiskPremium = (allocatable * 1000n) / BPS;
            const expectedJuniorYield = juniorBaseShare + juniorRiskPremium;

            // Pair (senior+mezzanine) is last: gets dust (remainder)
            const pairTotal = allocatable - expectedJuniorYield;
            const pairTvl = seniorTVL + mezzTVL;
            const expectedSeniorYield = (pairTotal * seniorTVL) / pairTvl;
            const expectedMezzYield = pairTotal - expectedSeniorYield;

            await time.increase(DAY);
            await fundYieldUSDC(YIELD_USDC);
            await vault.connect(navOracleSigner).distributeYield(YIELD_USDC);

            expect(await junior.yieldStreamingAmount()).to.equal(expectedJuniorYield);
            expect(await senior.yieldStreamingAmount()).to.equal(expectedSeniorYield);
            expect(await mezzanine.yieldStreamingAmount()).to.equal(expectedMezzYield);
            expect(await mzusd.balanceOf(vault.target)).to.equal(0n);
        });
    });
});
