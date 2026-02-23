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
    const slashPerShare = (yieldPerShare * reductionBps) / BPS;
    return (slashPerShare * userShares) / shareUnit;
}

describe("Tranche unstake slashing", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;

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
        [deployer, alice, bob] = await ethers.getSigners();

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

    it("reverts when slashing or cancel fee bps are >= 10_000", async () => {
        await expect(
            tranche.connect(deployer).setUnstakeYieldReductionBps(BPS)
        ).to.be.revertedWithCustomError(tranche, "InvalidAmount");
        await expect(
            tranche.connect(deployer).setCancelUnstakeFeeBps(BPS)
        ).to.be.revertedWithCustomError(tranche, "InvalidAmount");

        await expect(
            tranche.connect(deployer).setUnstakeYieldReductionBps(BPS + 1n)
        ).to.be.revertedWithCustomError(tranche, "InvalidAmount");
        await expect(
            tranche.connect(deployer).setCancelUnstakeFeeBps(BPS + 1n)
        ).to.be.revertedWithCustomError(tranche, "InvalidAmount");
    });

    it("reverts when non-admin tries to set slashing params", async () => {
        await expect(tranche.connect(alice).setUnstakeYieldReductionBps(1n)).to.be.reverted;
        await expect(tranche.connect(alice).setCancelUnstakeFeeBps(1n)).to.be.reverted;
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

        await tranche.connect(alice).claim(targetEpoch);

        const aliceAfter = await mzusd.balanceOf(alice.address);
        const reservedAfter = await tranche.reservedAssets();
        const ppsAfterClaim = await tranche.convertToAssets(scale);

        expect(aliceAfter - aliceBefore).to.equal(expectedAssetsOut);
        expect(reservedAfter).to.equal(reservedBefore - fullUserAssets);
        expect(ppsAfterClaim).to.be.gt(ppsBeforeClaim);
        expect(await tranche.userSharesByEpoch(alice.address, targetEpoch)).to.equal(0n);
        expect(await tranche.userSnapshotPrice(alice.address, targetEpoch)).to.equal(0n);
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

        await tranche.connect(alice).claim(targetEpoch);

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

        await tranche.connect(alice).claim(targetEpoch);
        await tranche.connect(bob).claim(targetEpoch);

        const aliceAfter = await mzusd.balanceOf(alice.address);
        const bobAfter = await mzusd.balanceOf(bob.address);

        expect(aliceAfter - aliceBefore).to.equal(aliceFullAssets);
        expect(bobAfter - bobBefore).to.equal(bobFullAssets);
        expect(await tranche.userSnapshotPrice(alice.address, targetEpoch)).to.equal(0n);
        expect(await tranche.userSnapshotPrice(bob.address, targetEpoch)).to.equal(0n);
    });

    it("full cancel and re-request in same epoch refreshes snapshot and reduces slash", async () => {
        const slashBps = 5_000n;
        await tranche.connect(deployer).setUnstakeYieldReductionBps(slashBps);
        await tranche.connect(deployer).setCancelUnstakeFeeBps(0n);

        await mintAndDepositIntoTranche(alice, to6(300n));
        await mintAndDepositIntoTranche(bob, to6(700n));

        await advanceEpoch(to6(200n));

        const targetEpoch = await vault.currentEpochId();
        const scale = await shareUnit();
        const aliceShares = await tranche.balanceOf(alice.address);

        await tranche.connect(alice).requestWithdrawal(aliceShares);
        const initialSnapshot = await tranche.userSnapshotPrice(alice.address, targetEpoch);
        expect(initialSnapshot).to.be.gt(0n);

        const epochDuration = await vault.epochDuration();
        await time.increase(epochDuration / 2n);

        await tranche.connect(alice).cancelUnstake(targetEpoch, aliceShares);
        expect(await tranche.userSharesByEpoch(alice.address, targetEpoch)).to.equal(0n);
        expect(await tranche.userSnapshotPrice(alice.address, targetEpoch)).to.equal(0n);

        await tranche.connect(alice).requestWithdrawal(aliceShares);
        const refreshedSnapshot = await tranche.userSnapshotPrice(alice.address, targetEpoch);
        expect(refreshedSnapshot).to.be.gt(initialSnapshot);

        await advanceEpoch(0n);
        await tranche.connect(deployer).finalizeEpoch(targetEpoch);

        const [totalShares, totalAssets, finalizationPrice] =
            await tranche.finalizedEpochs(targetEpoch);
        const fullUserAssets = (aliceShares * totalAssets) / totalShares;

        let slashWithInitial = computeSlash(
            finalizationPrice,
            initialSnapshot,
            slashBps,
            aliceShares,
            scale
        );
        if (slashWithInitial > fullUserAssets) {
            slashWithInitial = fullUserAssets;
        }

        let slashWithRefreshed = computeSlash(
            finalizationPrice,
            refreshedSnapshot,
            slashBps,
            aliceShares,
            scale
        );
        if (slashWithRefreshed > fullUserAssets) {
            slashWithRefreshed = fullUserAssets;
        }

        expect(slashWithRefreshed).to.be.lt(slashWithInitial);

        const aliceBefore = await mzusd.balanceOf(alice.address);
        await tranche.connect(alice).claim(targetEpoch);
        const aliceAfter = await mzusd.balanceOf(alice.address);

        expect(aliceAfter - aliceBefore).to.equal(fullUserAssets - slashWithRefreshed);
    });

    it("applies cancel fee burn and keeps snapshot unchanged on partial cancel", async () => {
        const cancelFeeBps = 1_000n;
        await tranche.connect(deployer).setCancelUnstakeFeeBps(cancelFeeBps);

        await mintAndDepositIntoTranche(alice, to6(200n));
        await advanceEpoch(to6(40n));

        const targetEpoch = await vault.currentEpochId();
        const totalShares = await tranche.balanceOf(alice.address);
        const requestedShares = (totalShares * 3n) / 5n;

        await tranche.connect(alice).requestWithdrawal(requestedShares);

        const snapshotBefore = await tranche.userSnapshotPrice(alice.address, targetEpoch);
        const userWalletBefore = await tranche.balanceOf(alice.address);
        const supplyBefore = await tranche.totalSupply();

        const cancelShares = requestedShares / 2n;
        const sharesToBurn = (cancelShares * cancelFeeBps) / BPS;
        const returnShares = cancelShares - sharesToBurn;

        await tranche.connect(alice).cancelUnstake(targetEpoch, cancelShares);

        const userWalletAfter = await tranche.balanceOf(alice.address);
        const supplyAfter = await tranche.totalSupply();
        const userSharesLeft = requestedShares - cancelShares;

        expect(userWalletAfter - userWalletBefore).to.equal(returnShares);
        expect(supplyAfter).to.equal(supplyBefore - sharesToBurn);
        expect(await tranche.userSharesByEpoch(alice.address, targetEpoch)).to.equal(
            userSharesLeft
        );
        expect(await tranche.userSnapshotPrice(alice.address, targetEpoch)).to.equal(
            snapshotBefore
        );

        await tranche.connect(alice).cancelUnstake(targetEpoch, userSharesLeft);

        expect(await tranche.userSharesByEpoch(alice.address, targetEpoch)).to.equal(0n);
        expect(await tranche.userSnapshotPrice(alice.address, targetEpoch)).to.equal(0n);
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
        await tranche.connect(alice).claim(targetEpoch);
        const aliceAfter = await mzusd.balanceOf(alice.address);

        expect(aliceAfter - aliceBefore).to.equal(claimablePreview);
    });
});
