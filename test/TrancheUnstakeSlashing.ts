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
    MZUSD,
    IssuanceVault,
    ReservoirUSDC,
    IERC20,
    Tranche,
    PauseManager,
} from "../typechain-types";
import {grantPausePermissions} from "./helpers/pause";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";
const DAY = 24 * 60 * 60;

const BPS = 10_000n;
const BURNER_ROLE = 5n;
const FINALIZER_ROLE = 8n;

const to6 = (value: string | number | bigint) => parseUnits(value.toString(), 6);
const to18 = (value: string | number | bigint) => parseUnits(value.toString(), 18);

async function imp(addr: string) {
    await setBalance(addr, to18(10));
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

function computeSlash(
    finalizationPrice: bigint,
    snapshotPrice: bigint,
    reductionBps: bigint,
    userShares: bigint,
    shareUnit: bigint
): bigint {
    if (snapshotPrice === 0n || reductionBps === 0n || finalizationPrice <= snapshotPrice) {
        return 0n;
    }

    const yieldPerShare = finalizationPrice - snapshotPrice;
    return (yieldPerShare * reductionBps * userShares) / BPS / shareUnit;
}

describe("Tranche unstake slashing", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let vault: IssuanceVault;
    let mzusd: MZUSD;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;
    let reservoir: ReservoirUSDC;
    let tranche: Tranche;
    let whale: any;
    let lossManagerRef: any;
    let navOracleRef: any;
    let lossManagerSigner: any;
    let navOracleSigner: any;

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

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

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
            {kind: "uups", initializer: "initialize"}
        );
        await allowlist.addBatch([alice.address, bob.address, carol.address]);

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [accessManager.target, pauseManager.target, allowlist.target, usdcTotalSupply],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, bob.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        })) as unknown as IssuanceVault;

        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        tranche = (await upgrades.deployProxy(TrancheFactory, [1, 0, "Senior Tranche", "sMZUSD"], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target, false],
        })) as unknown as Tranche;

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

        lossManagerSigner = await imp(lossManagerRef.target as string);
        navOracleSigner = await imp(navOracleRef.target as string);

        const setVaultSelector = mzusd.interface.getFunction("setVault").selector;
        const burnSelector = mzusd.interface.getFunction("burn").selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSelector], ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(mzusd.target, [burnSelector], BURNER_ROLE);
        await accessManager.grantRole(BURNER_ROLE, tranche.target, 0);

        const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;
        const advanceEpochSelector = vault.interface.getFunction("advanceEpoch").selector;
        const registerTrancheSelector = vault.interface.getFunction("registerTranche").selector;
        const setTrancheConfigSelector = vault.interface.getFunction("setTrancheConfig").selector;
        const setLossManagerSelector = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSelector = vault.interface.getFunction("setNavOracle").selector;

        await accessManager.setTargetFunctionRole(
            vault.target,
            [
                distributeYieldSelector,
                advanceEpochSelector,
                registerTrancheSelector,
                setTrancheConfigSelector,
                setLossManagerSelector,
                setNavOracleSelector,
            ],
            ADMIN_ROLE
        );

        const finalizeEpochSel = tranche.interface.getFunction("finalizeEpoch").selector;
        await accessManager.setTargetFunctionRole(tranche, [finalizeEpochSel], FINALIZER_ROLE);
        await accessManager.grantRole(FINALIZER_ROLE, deployer, 0);

        await mzusd.setVault(vault.target);
        await vault.setLossManager(lossManagerRef.target);
        await vault.setNavOracle(navOracleRef.target);

        await vault.registerTranche(tranche.target);
        await vault.setTrancheConfig(
            [{tranche: tranche.target, riskPremiumBps: 10_000, enabled: true}],
            [false],
            0
        );

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function shareUnit(): Promise<bigint> {
        return 10n ** BigInt(await tranche.decimals());
    }

    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusd.target, usdcAmount6);
        await mzusd.connect(user).deposit(usdcAmount6);
        return mzusd.balanceOf(user.address);
    }

    async function mintAndDepositIntoTranche(user: any, usdcAmount6: bigint): Promise<bigint> {
        const mz = await mintMZUSDFor(user, usdcAmount6);
        await mzusd.connect(user).approve(tranche.target, mz);
        await tranche.connect(user).deposit(mz, user.address);
        return tranche.balanceOf(user.address);
    }

    async function advanceEpoch(yield6 = 0n): Promise<void> {
        await time.increase(DAY);
        await vault.connect(navOracleSigner).distributeYield(yield6);
    }

    it("stores weighted snapshot price for repeated requests in the same epoch", async () => {
        await mintAndDepositIntoTranche(alice, to6(500n));

        await advanceEpoch(to6(120n));
        const targetEpoch = await vault.currentEpochId();

        const scale = await shareUnit();
        const totalShares = await tranche.balanceOf(alice.address);
        const req1 = totalShares / 3n;
        const req2 = totalShares / 4n;

        await tranche.connect(alice).requestWithdrawal(req1);

        const snapshotAfterReq1 = await tranche.userSnapshotPrice(alice.address, targetEpoch);
        expect(snapshotAfterReq1).to.be.gt(0n);

        const epochDuration = await vault.epochDuration();
        await time.increase(epochDuration / 2n);

        const priceAtReq2 = await tranche.convertToAssets(scale);
        await tranche.connect(alice).requestWithdrawal(req2);

        const snapshotAfterReq2 = await tranche.userSnapshotPrice(alice.address, targetEpoch);
        const impliedPriceAtReq2 =
            (snapshotAfterReq2 * (req1 + req2) - snapshotAfterReq1 * req1) / req2;
        const drift =
            impliedPriceAtReq2 > priceAtReq2
                ? impliedPriceAtReq2 - priceAtReq2
                : priceAtReq2 - impliedPriceAtReq2;

        expect(await tranche.userSharesByEpoch(alice.address, targetEpoch)).to.equal(req1 + req2);
        expect(snapshotAfterReq2).to.be.gt(snapshotAfterReq1);
        expect(impliedPriceAtReq2).to.be.gte(snapshotAfterReq1);
        // One-block timestamp drift is expected between view-read and tx execution.
        expect(drift).to.be.lte(5_000_000_000_000n);
    });

    it("reverts when slashing bps are >= 10_000", async () => {
        await expect(
            tranche.connect(deployer).setUnstakeYieldReductionBps(BPS)
        ).to.be.revertedWithCustomError(tranche, "InvalidAmount");

        await expect(
            tranche.connect(deployer).setUnstakeYieldReductionBps(BPS + 1n)
        ).to.be.revertedWithCustomError(tranche, "InvalidAmount");
    });

    it("reverts when non-admin tries to set slashing params", async () => {
        await expect(tranche.connect(alice).setUnstakeYieldReductionBps(1n)).to.be.reverted;
    });

    it("slashes positive pending yield on claim and releases full reserved amount", async () => {
        const slashBps = 5_000n;
        await tranche.connect(deployer).setUnstakeYieldReductionBps(slashBps);

        await mintAndDepositIntoTranche(alice, to6(300n));
        await mintAndDepositIntoTranche(bob, to6(700n));

        await advanceEpoch(to6(100n));

        const targetEpoch = await vault.currentEpochId();
        const aliceShares = await tranche.balanceOf(alice.address);
        const scale = await shareUnit();

        await tranche.connect(alice).requestWithdrawal(aliceShares);
        const snapshotPrice = await tranche.userSnapshotPrice(alice.address, targetEpoch);

        await advanceEpoch(0n);
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);

        const [totalShares, totalAssets, finalizationPrice] =
            await tranche.finalizedEpochs(targetEpoch);
        const fullUserAssets = (aliceShares * totalAssets) / totalShares;

        let expectedSlash = computeSlash(
            finalizationPrice,
            snapshotPrice,
            slashBps,
            aliceShares,
            scale
        );
        if (expectedSlash > fullUserAssets) {
            expectedSlash = fullUserAssets;
        }
        const expectedAssetsOut = fullUserAssets - expectedSlash;

        expect(expectedSlash).to.be.gt(0n);

        const reservedBefore = await tranche.reservedAssets();
        const ppsBeforeClaim = await tranche.convertToAssets(scale);
        const aliceBefore = await mzusd.balanceOf(alice.address);

        await tranche.connect(alice).claim(alice.address, targetEpoch);

        const aliceAfter = await mzusd.balanceOf(alice.address);
        const reservedAfter = await tranche.reservedAssets();
        const ppsAfterClaim = await tranche.convertToAssets(scale);

        expect(aliceAfter - aliceBefore).to.equal(expectedAssetsOut);
        expect(reservedAfter).to.equal(reservedBefore - fullUserAssets);
        expect(ppsAfterClaim).to.be.gt(ppsBeforeClaim);
        expect(await tranche.userSharesByEpoch(alice.address, targetEpoch)).to.equal(0n);
        expect(await tranche.userSnapshotPrice(alice.address, targetEpoch)).to.equal(0n);
    });

    it("claim works when last pending user makes ERC4626 share supply zero after finalize", async () => {
        const slashBps = 4_000n;
        await tranche.connect(deployer).setUnstakeYieldReductionBps(slashBps);

        // Single-user tranche setup: Alice is the only LP and later the only pending withdrawer.
        await mintAndDepositIntoTranche(alice, to6(300n));

        // Start a new epoch with positive streamed yield so slash math has non-zero input.
        await advanceEpoch(to6(90n));
        const targetEpoch = await vault.currentEpochId();
        const scale = await shareUnit();

        const aliceShares = await tranche.balanceOf(alice.address);
        expect(aliceShares).to.be.gt(0n);

        // Move all Alice shares under umbrella; wallet share balance becomes zero.
        await tranche.connect(alice).requestWithdrawal(aliceShares);
        const snapshotPrice = await tranche.userSnapshotPrice(alice.address, targetEpoch);
        expect(await tranche.balanceOf(alice.address)).to.equal(0n);

        // Advance so epoch becomes finalizable; all remaining ERC4626 supply is still umbrella-held.
        await advanceEpoch(0n);
        expect(await tranche.totalSupply()).to.equal(aliceShares);

        // Finalization burns umbrella shares; this is the edge case where totalSupply goes to zero.
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);
        expect(await tranche.totalSupply()).to.equal(0n);

        const [totalShares, totalAssets, finalizationPrice] =
            await tranche.finalizedEpochs(targetEpoch);
        expect(totalShares).to.equal(aliceShares);

        const fullUserAssets = (aliceShares * totalAssets) / totalShares;
        let expectedSlash = computeSlash(
            finalizationPrice,
            snapshotPrice,
            slashBps,
            aliceShares,
            scale
        );
        if (expectedSlash > fullUserAssets) {
            expectedSlash = fullUserAssets;
        }
        const expectedClaim = fullUserAssets - expectedSlash;

        // Claim must still succeed and settle reserved assets correctly despite zero ERC4626 supply.
        const aliceBefore = await mzusd.balanceOf(alice.address);
        await tranche.connect(alice).claim(alice.address, targetEpoch);
        const aliceAfter = await mzusd.balanceOf(alice.address);

        expect(aliceAfter - aliceBefore).to.equal(expectedClaim);
        expect(await tranche.reservedAssets()).to.equal(0n);
        expect(await tranche.userSharesByEpoch(alice.address, targetEpoch)).to.equal(0n);
        expect(await tranche.userSnapshotPrice(alice.address, targetEpoch)).to.equal(0n);
    });

    it("single-user epoch with finalized totalAssets=0 claims zero and clears pending state", async () => {
        // Alice is the only LP and requests full withdrawal into umbrella.
        await mintAndDepositIntoTranche(alice, to6(300n));
        const targetEpoch = await vault.currentEpochId();
        const aliceShares = await tranche.balanceOf(alice.address);
        await tranche.connect(alice).requestWithdrawal(aliceShares);

        // Simulate complete insolvency of tranche assets before finalization.
        const trancheBalanceBeforeBurn = await mzusd.balanceOf(tranche.target);
        await tranche.connect(lossManagerSigner).burnMZUSD(trancheBalanceBeforeBurn);
        expect(await mzusd.balanceOf(tranche.target)).to.equal(0n);
        expect(await tranche.totalAssets()).to.equal(0n);

        // Finalize with non-zero shares but zero assets credited.
        await advanceEpoch(0n);
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);
        const [totalShares, totalAssets, finalizationPrice] =
            await tranche.finalizedEpochs(targetEpoch);
        expect(totalShares).to.equal(aliceShares);
        expect(totalAssets).to.equal(0n);
        expect(finalizationPrice).to.equal(0n);

        // Claim succeeds, pays zero, and clears user pending records.
        const aliceBefore = await mzusd.balanceOf(alice.address);
        await tranche.connect(alice).claim(alice.address, targetEpoch);
        const aliceAfter = await mzusd.balanceOf(alice.address);

        expect(aliceAfter - aliceBefore).to.equal(0n);
        expect(await tranche.reservedAssets()).to.equal(0n);
        expect(await tranche.userSharesByEpoch(alice.address, targetEpoch)).to.equal(0n);
        expect(await tranche.userSnapshotPrice(alice.address, targetEpoch)).to.equal(0n);
    });

    it("multi-user epoch with finalized totalAssets=0 lets all users claim zero", async () => {
        // Two users request full withdrawals in the same epoch.
        await mintAndDepositIntoTranche(alice, to6(300n));
        await mintAndDepositIntoTranche(bob, to6(700n));
        const targetEpoch = await vault.currentEpochId();
        const aliceShares = await tranche.balanceOf(alice.address);
        const bobShares = await tranche.balanceOf(bob.address);
        await tranche.connect(alice).requestWithdrawal(aliceShares);
        await tranche.connect(bob).requestWithdrawal(bobShares);

        // Burn all tranche assets before finalization so finalized totalAssets becomes zero.
        const trancheBalanceBeforeBurn = await mzusd.balanceOf(tranche.target);
        await tranche.connect(lossManagerSigner).burnMZUSD(trancheBalanceBeforeBurn);
        expect(await mzusd.balanceOf(tranche.target)).to.equal(0n);
        expect(await tranche.totalAssets()).to.equal(0n);

        await advanceEpoch(0n);
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);
        const [totalShares, totalAssets, finalizationPrice] =
            await tranche.finalizedEpochs(targetEpoch);

        expect(totalShares).to.equal(aliceShares + bobShares);
        expect(totalAssets).to.equal(0n);
        expect(finalizationPrice).to.equal(0n);

        // Both claims are successful and pay zero.
        const aliceBefore = await mzusd.balanceOf(alice.address);
        const bobBefore = await mzusd.balanceOf(bob.address);
        await tranche.connect(alice).claim(alice.address, targetEpoch);
        await tranche.connect(bob).claim(bob.address, targetEpoch);
        const aliceAfter = await mzusd.balanceOf(alice.address);
        const bobAfter = await mzusd.balanceOf(bob.address);

        expect(aliceAfter - aliceBefore).to.equal(0n);
        expect(bobAfter - bobBefore).to.equal(0n);
        expect(await tranche.reservedAssets()).to.equal(0n);
        expect(await tranche.userSharesByEpoch(alice.address, targetEpoch)).to.equal(0n);
        expect(await tranche.userSharesByEpoch(bob.address, targetEpoch)).to.equal(0n);
    });

    it("max slash bps keeps claim bounded and non-negative", async () => {
        // Use near-maximum slashing to stress the formula under the harshest allowed config.
        const slashBps = 9_999n;
        await tranche.connect(deployer).setUnstakeYieldReductionBps(slashBps);

        // Keep Bob in tranche so Alice does NOT own 100% of finalized epoch assets.
        // This makes Alice's payout a real pro-rata slice (more realistic than a single-user case).
        await mintAndDepositIntoTranche(alice, to6(123n));
        await mintAndDepositIntoTranche(bob, to6(877n));

        // Start a positive-yield epoch. After Alice snapshots, finalization should happen at a higher price,
        // so slashing branch is definitely active (finalizationPrice > snapshotPrice).
        await advanceEpoch(to6(321n));
        const targetEpoch = await vault.currentEpochId();
        const scale = await shareUnit();

        // Alice requests full withdrawal and captures snapshot price used later in slash math.
        const aliceShares = await tranche.balanceOf(alice.address);
        await tranche.connect(alice).requestWithdrawal(aliceShares);
        const snapshotPrice = await tranche.userSnapshotPrice(alice.address, targetEpoch);

        // Move to next epoch and finalize Alice's pending shares into finalizedEpochs snapshot data.
        await advanceEpoch(0n);
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);

        const [totalShares, totalAssets, finalizationPrice] =
            await tranche.finalizedEpochs(targetEpoch);
        // Alice's max claim before slashing: her pro-rata part of finalized assets pool.
        const fullUserAssets = (aliceShares * totalAssets) / totalShares;
        // Pure math slash preview used to compare against the on-chain claim result.
        const rawSlash = computeSlash(
            finalizationPrice,
            snapshotPrice,
            slashBps,
            aliceShares,
            scale
        );

        // Core safety invariant: slash cannot exceed user's own finalized entitlement.
        // If this holds, claim payout fullUserAssets - rawSlash is never negative.
        expect(rawSlash).to.be.lte(fullUserAssets);
        const expectedClaim = fullUserAssets - rawSlash;

        // Execute claim and assert the transfer equals the expected bounded payout.
        const aliceBefore = await mzusd.balanceOf(alice.address);
        await tranche.connect(alice).claim(alice.address, targetEpoch);
        const aliceAfter = await mzusd.balanceOf(alice.address);

        expect(aliceAfter - aliceBefore).to.equal(expectedClaim);
        expect(expectedClaim).to.be.gte(0n);
    });

    it("rounding dust: total claimed never exceeds finalized assets", async () => {
        // Turn off slashing to isolate only floor-division effects in pro-rata claim math.
        // We want this test to cover rounding behavior, not slash behavior.
        await tranche.connect(deployer).setUnstakeYieldReductionBps(0n);

        // Build a 3-user pool with awkward sizes to avoid "too clean" divisibility.
        await mintAndDepositIntoTranche(alice, to6(111n));
        await mintAndDepositIntoTranche(bob, to6(53n));
        await mintAndDepositIntoTranche(carol, to6(37n));

        // Start a yield epoch so finalized assets are not a trivial integer multiple in share space.
        await advanceEpoch(to6(19n));
        const targetEpoch = await vault.currentEpochId();

        const aShares = await tranche.balanceOf(alice.address);
        const bShares = await tranche.balanceOf(bob.address);
        const cShares = await tranche.balanceOf(carol.address);

        // Request non-round partial share amounts to amplify floor-division remainders ("dust").
        const aReq = aShares / 3n + 1n;
        const bReq = bShares / 2n + 1n;
        const cReq = cShares / 5n + 1n;

        // Move selected shares under umbrella for the same epoch.
        await tranche.connect(alice).requestWithdrawal(aReq);
        await tranche.connect(bob).requestWithdrawal(bReq);
        await tranche.connect(carol).requestWithdrawal(cReq);

        // Finalize that epoch and snapshot totalShares/totalAssets used by claim formula.
        await advanceEpoch(0n);
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);

        const [totalShares, totalAssets] = await tranche.finalizedEpochs(targetEpoch);
        expect(totalShares).to.equal(aReq + bReq + cReq);

        // Expected claim per user follows the exact on-chain floor formula:
        // floor(userShares * totalAssets / totalShares).
        const expectedA = (aReq * totalAssets) / totalShares;
        const expectedB = (bReq * totalAssets) / totalShares;
        const expectedC = (cReq * totalAssets) / totalShares;
        const expectedTotalClaimed = expectedA + expectedB + expectedC;

        const aBefore = await mzusd.balanceOf(alice.address);
        const bBefore = await mzusd.balanceOf(bob.address);
        const cBefore = await mzusd.balanceOf(carol.address);

        await tranche.connect(alice).claim(alice.address, targetEpoch);
        await tranche.connect(bob).claim(bob.address, targetEpoch);
        await tranche.connect(carol).claim(carol.address, targetEpoch);

        const aAfter = await mzusd.balanceOf(alice.address);
        const bAfter = await mzusd.balanceOf(bob.address);
        const cAfter = await mzusd.balanceOf(carol.address);

        const actualTotalClaimed = aAfter - aBefore + (bAfter - bBefore) + (cAfter - cBefore);
        // All users must receive exactly the floor-based expectations.
        expect(actualTotalClaimed).to.equal(expectedTotalClaimed);
        // Safety bound: distributed claims can never exceed finalized assets.
        expect(actualTotalClaimed).to.be.lte(totalAssets);

        // Any remainder is integer-division dust. It stays in reservedAssets
        const expectedDust = totalAssets - expectedTotalClaimed;
        expect(await tranche.reservedAssets()).to.equal(expectedDust);
    });

    it("does not slash when finalization price is below snapshot price", async () => {
        await tranche.connect(deployer).setUnstakeYieldReductionBps(5_000n);

        await mintAndDepositIntoTranche(alice, to6(300n));
        await mintAndDepositIntoTranche(bob, to6(700n));

        const targetEpoch = await vault.currentEpochId();
        const aliceShares = await tranche.balanceOf(alice.address);

        await tranche.connect(alice).requestWithdrawal(aliceShares);
        const snapshotPrice = await tranche.userSnapshotPrice(alice.address, targetEpoch);

        const trancheBalanceBeforeLoss = await mzusd.balanceOf(tranche.target);
        const lossAmount = trancheBalanceBeforeLoss / 5n;

        await tranche.connect(lossManagerSigner).burnMZUSD(lossAmount);
        expect(await mzusd.balanceOf(tranche.target)).to.equal(
            trancheBalanceBeforeLoss - lossAmount
        );

        await advanceEpoch(0n);
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);

        const [totalShares, totalAssets, finalizationPrice] =
            await tranche.finalizedEpochs(targetEpoch);
        expect(finalizationPrice).to.be.lt(snapshotPrice);

        const fullUserAssets = (aliceShares * totalAssets) / totalShares;
        const aliceBefore = await mzusd.balanceOf(alice.address);

        await tranche.connect(alice).claim(alice.address, targetEpoch);

        const aliceAfter = await mzusd.balanceOf(alice.address);
        expect(aliceAfter - aliceBefore).to.equal(fullUserAssets);
    });

    it("does not slash two users with different snapshots when loss pushes finalization below both", async () => {
        const slashBps = 5_000n;
        await tranche.connect(deployer).setUnstakeYieldReductionBps(slashBps);

        // 1) Initial TVL split: Alice 300, Bob 700 (total 1000 MZUSD).
        await mintAndDepositIntoTranche(alice, to6(300n));
        await mintAndDepositIntoTranche(bob, to6(700n));

        // 2) Start streaming positive yield to lift PPS above 1.0 before requests.
        // Reported yield: +200 USDC (=> +200 MZUSD streamed linearly over the epoch).
        await advanceEpoch(to6(200n));

        const targetEpoch = await vault.currentEpochId();
        const scale = await shareUnit();

        // 3) Alice requests first -> earlier (lower) snapshot.
        const aliceShares = await tranche.balanceOf(alice.address);
        await tranche.connect(alice).requestWithdrawal(aliceShares);
        const aliceSnapshot = await tranche.userSnapshotPrice(alice.address, targetEpoch);

        // Move forward mid-stream so Bob snapshots at a higher PPS than Alice.
        const epochDuration = await vault.epochDuration();
        await time.increase(epochDuration / 2n);

        // 4) Bob requests later -> higher snapshot.
        const bobShares = await tranche.balanceOf(bob.address);
        await tranche.connect(bob).requestWithdrawal(bobShares);
        const bobSnapshot = await tranche.userSnapshotPrice(bob.address, targetEpoch);

        expect(bobSnapshot).to.be.gt(aliceSnapshot);

        // 5) Apply loss while both are pending:
        // burn 25% of current tranche MZUSD balance to force finalization PPS below both snapshots.
        const trancheBalanceBeforeLoss = await mzusd.balanceOf(tranche.target);
        const lossAmount = trancheBalanceBeforeLoss / 4n;
        await tranche.connect(lossManagerSigner).burnMZUSD(lossAmount);

        // 6) Advance epoch and finalize pending umbrella shares for target epoch.
        await advanceEpoch(0n);
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);

        const [totalShares, totalAssets, finalizationPrice] =
            await tranche.finalizedEpochs(targetEpoch);

        // Core condition for "no slash": final price is below both snapshot prices.
        expect(finalizationPrice).to.be.lt(aliceSnapshot);
        expect(finalizationPrice).to.be.lt(bobSnapshot);

        // Pro-rata full claim amounts from finalized epoch pool.
        const aliceFullAssets = (aliceShares * totalAssets) / totalShares;
        const bobFullAssets = (bobShares * totalAssets) / totalShares;

        // With finalizationPrice <= snapshotPrice, slash math must be exactly zero for both users.
        const aliceExpectedSlash = computeSlash(
            finalizationPrice,
            aliceSnapshot,
            slashBps,
            aliceShares,
            scale
        );
        const bobExpectedSlash = computeSlash(
            finalizationPrice,
            bobSnapshot,
            slashBps,
            bobShares,
            scale
        );
        expect(aliceExpectedSlash).to.equal(0n);
        expect(bobExpectedSlash).to.equal(0n);

        // 7) Claims should transfer full pro-rata assets, with no slashing reduction.
        const aliceBefore = await mzusd.balanceOf(alice.address);
        const bobBefore = await mzusd.balanceOf(bob.address);

        await tranche.connect(alice).claim(alice.address, targetEpoch);
        await tranche.connect(bob).claim(bob.address, targetEpoch);

        const aliceAfter = await mzusd.balanceOf(alice.address);
        const bobAfter = await mzusd.balanceOf(bob.address);

        expect(aliceAfter - aliceBefore).to.equal(aliceFullAssets);
        expect(bobAfter - bobBefore).to.equal(bobFullAssets);
        expect(await tranche.userSnapshotPrice(alice.address, targetEpoch)).to.equal(0n);
        expect(await tranche.userSnapshotPrice(bob.address, targetEpoch)).to.equal(0n);
    });

    it("getUserEpochInfo returns claim preview with slashing", async () => {
        const slashBps = 4_000n;
        await tranche.connect(deployer).setUnstakeYieldReductionBps(slashBps);

        await mintAndDepositIntoTranche(alice, to6(150n));
        await mintAndDepositIntoTranche(bob, to6(350n));

        await advanceEpoch(to6(90n));

        const targetEpoch = await vault.currentEpochId();
        const scale = await shareUnit();
        const aliceShares = await tranche.balanceOf(alice.address);
        const requestedShares = (aliceShares * 2n) / 3n;

        await tranche.connect(alice).requestWithdrawal(requestedShares);
        const snapshotPrice = await tranche.userSnapshotPrice(alice.address, targetEpoch);

        await advanceEpoch(0n);
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);

        const [totalShares, totalAssets, finalizationPrice] =
            await tranche.finalizedEpochs(targetEpoch);

        const fullUserAssets = (requestedShares * totalAssets) / totalShares;
        let expectedSlash = computeSlash(
            finalizationPrice,
            snapshotPrice,
            slashBps,
            requestedShares,
            scale
        );
        if (expectedSlash > fullUserAssets) {
            expectedSlash = fullUserAssets;
        }
        const expectedClaimable = fullUserAssets - expectedSlash;

        const [pendingShares, claimablePreview] = await tranche.getUserEpochInfo(
            alice.address,
            targetEpoch
        );

        expect(pendingShares).to.equal(requestedShares);
        expect(claimablePreview).to.equal(expectedClaimable);

        const aliceBefore = await mzusd.balanceOf(alice.address);
        await tranche.connect(alice).claim(alice.address, targetEpoch);
        const aliceAfter = await mzusd.balanceOf(alice.address);

        expect(aliceAfter - aliceBefore).to.equal(claimablePreview);
    });
});
