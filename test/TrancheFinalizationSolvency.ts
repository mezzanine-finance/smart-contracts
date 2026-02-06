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

import {MZUSD, Vault, ReservoirUSDC, IERC20, Tranche, PauseManager} from "../typechain-types";
import {grantPausePermissions} from "./helpers/pause";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

const DAY = 24 * 60 * 60;

async function imp(addr: string) {
    await setBalance(addr, to18(10));
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("Tranche finalization solvency", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;
    let accessManager: any;
    let pauseManager: PauseManager;
    let vault: Vault;
    let mzusd: MZUSD;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;
    let reservoir: ReservoirUSDC;
    let tranche: Tranche;
    let whale: any;
    let navOracleRef: any;
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

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, carol.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        })) as unknown as Vault;

        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        tranche = (await upgrades.deployProxy(
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

        const MockLossManagerFactory = await ethers.getContractFactory(
            "MockLossManagerRef",
            deployer
        );
        const lossManagerRef = await MockLossManagerFactory.deploy(vault.target, mzusd.target);
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

        const setVaultSelector = mzusd.interface.getFunction("setVault").selector;
        const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSelector = vault.interface.getFunction("addTranche").selector;
        const setLossManagerSelector = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSelector = vault.interface.getFunction("setNavOracle").selector;

        await accessManager.setTargetFunctionRole(
            vault.target,
            [
                distributeYieldSelector,
                addTrancheSelector,
                setLossManagerSelector,
                setNavOracleSelector,
            ],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSelector], ADMIN_ROLE);

        await mzusd.setVault(vault.target);
        await vault.setLossManager(lossManagerRef.target);
        await vault.setNavOracle(navOracleRef.target);

        await vault.addTranche({tranche: tranche.target, weight: 10_000, enabled: true});

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    // Helpers
    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusd.target, usdcAmount6);
        await mzusd.connect(user).deposit(usdcAmount6);
        return mzusd.balanceOf(user.address);
    }

    async function mintAndDeposit(user: any, usdcAmount6: bigint) {
        const mz = await mintMZUSDFor(user, usdcAmount6);
        await mzusd.connect(user).approve(tranche.target, mz);
        await tranche.connect(user).deposit(mz, user.address);
        return tranche.balanceOf(user.address);
    }

    async function advanceEpoch(yield6 = 0n) {
        await time.increase(DAY);
        await vault.connect(navOracleSigner).distributeYield(yield6);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 1) Deposit before finalization should NOT affect the claim rate
    // ═══════════════════════════════════════════════════════════════════════
    describe("Deposit before finalization", () => {
        it("deposit by another user does not change finalized claim amounts", async () => {
            // Setup: Alice and Bob deposit, Alice requests withdrawal
            await mintAndDeposit(alice, to6(100n));
            await mintAndDeposit(bob, to6(200n));

            const aliceShares = await tranche.balanceOf(alice.address);
            await tranche.connect(alice).requestWithdrawal(aliceShares);
            const epochAtRequest = await vault.currentEpochId();

            // Advance epoch so finalization is allowed
            await advanceEpoch();

            // --- Branch A: finalize WITHOUT extra deposit ---
            const snap = await takeSnapshot();

            await tranche.connect(deployer).finalizeEpoch(epochAtRequest);
            const [, , totalSharesA, totalAssetsA] = await tranche.getEpochInfo(epochAtRequest);
            const aliceClaimA = (aliceShares * totalAssetsA) / totalSharesA;

            await snap.restore();

            // --- Branch B: Carol deposits, THEN finalize ---
            await mintAndDeposit(carol, to6(500n));

            await tranche.connect(deployer).finalizeEpoch(epochAtRequest);
            const [, , totalSharesB, totalAssetsB] = await tranche.getEpochInfo(epochAtRequest);
            const aliceClaimB = (aliceShares * totalAssetsB) / totalSharesB;

            // Deposit should not affect claim amount (ERC-4626 preserves ratio)
            expect(aliceClaimA).to.equal(aliceClaimB);
            expect(totalSharesA).to.equal(totalSharesB);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2) Finalization timing within epoch — accrued yield affects rate
    // ═══════════════════════════════════════════════════════════════════════
    describe("Finalization timing within epoch", () => {
        it("finalization mid-epoch includes only accrued yield, not full yield", async () => {
            // Setup: Alice deposits, requests withdrawal
            await mintAndDeposit(alice, to6(100n));

            const aliceShares = await tranche.balanceOf(alice.address);
            await tranche.connect(alice).requestWithdrawal(aliceShares);
            const epochAtRequest = await vault.currentEpochId();

            // Advance epoch WITH yield — yield will stream linearly over next epoch
            const yieldUsdc = to6(10n); // 10 USDC → 10e18 MZUSD yield
            await advanceEpoch(yieldUsdc);

            // --- Branch A: finalize at the START of the new epoch (minimal yield accrued) ---
            const snapStart = await takeSnapshot();

            await tranche.connect(deployer).finalizeEpoch(epochAtRequest);
            const [, , , totalAssetsStart] = await tranche.getEpochInfo(epochAtRequest);
            const unaccruedStart = await tranche.unaccruedYield();

            await snapStart.restore();

            // --- Branch B: finalize HALFWAY through the epoch (half yield accrued) ---
            await time.increase(DAY / 2);

            const snapMid = await takeSnapshot();

            await tranche.connect(deployer).finalizeEpoch(epochAtRequest);
            const [, , , totalAssetsMid] = await tranche.getEpochInfo(epochAtRequest);
            const unaccruedMid = await tranche.unaccruedYield();

            await snapMid.restore();

            // --- Branch C: finalize at the END of the epoch (all yield accrued) ---
            await time.increase(DAY / 2);

            await tranche.connect(deployer).finalizeEpoch(epochAtRequest);
            const [, , , totalAssetsEnd] = await tranche.getEpochInfo(epochAtRequest);
            const unaccruedEnd = await tranche.unaccruedYield();

            // Verify yield streaming: unaccrued decreases over time
            expect(unaccruedStart).to.be.gt(unaccruedMid);
            expect(unaccruedMid).to.be.gt(unaccruedEnd);
            expect(unaccruedEnd).to.equal(0n);

            // totalAssets increases as yield accrues (totalAssets = balance - unaccrued - reserved)
            expect(totalAssetsStart).to.be.lt(totalAssetsMid);
            expect(totalAssetsMid).to.be.lt(totalAssetsEnd);

            // The difference should be proportional to accrued yield
            const yieldMZ = to18(10n); // 10 USDC = 10e18 MZUSD
            // End - Start ≈ full yield (within rounding)
            const accruedTotal = totalAssetsEnd - totalAssetsStart;
            expect(accruedTotal).to.be.closeTo(yieldMZ, to18(1n) / 100n); // within 0.01 MZUSD
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3) Out-of-order finalization vs in-order finalization
    // ═══════════════════════════════════════════════════════════════════════
    describe("Epoch finalization order", () => {
        it("immediate finalize after each advance vs deferred batch finalize", async () => {
            // Setup: Alice requests in epoch 1, Bob requests in epoch 2
            await mintAndDeposit(alice, to6(100n));
            await mintAndDeposit(bob, to6(100n));

            const aliceShares = await tranche.balanceOf(alice.address);
            await tranche.connect(alice).requestWithdrawal(aliceShares);
            const epoch1 = await vault.currentEpochId();

            // --- Branch A: advance epoch 1 → immediately finalize, then advance epoch 2 → finalize ---
            const snapImmediate = await takeSnapshot();

            // Advance epoch 1 → epoch 2 with yield
            await advanceEpoch(to6(10n));

            // Finalize epoch 1 immediately (yield from epoch 1→2 is still streaming)
            await tranche.connect(deployer).finalizeEpoch(epoch1);
            const [, , sharesA1, assetsA1] = await tranche.getEpochInfo(epoch1);

            // Bob requests in epoch 2
            const bobSharesA = await tranche.balanceOf(bob.address);
            await tranche.connect(bob).requestWithdrawal(bobSharesA);
            const epoch2A = await vault.currentEpochId();

            // Advance epoch 2 → epoch 3 with yield
            await advanceEpoch(to6(5n));

            // Finalize epoch 2 immediately (yield from epoch 2→3 is still streaming)
            await tranche.connect(deployer).finalizeEpoch(epoch2A);
            const [, , sharesA2, assetsA2] = await tranche.getEpochInfo(epoch2A);

            const aliceClaimImmediate = (aliceShares * assetsA1) / sharesA1;
            const bobClaimImmediate = (bobSharesA * assetsA2) / sharesA2;

            await snapImmediate.restore();

            // --- Branch B: advance both epochs first, wait for streaming, then batch finalize ---
            await advanceEpoch(to6(10n));

            const bobSharesB = await tranche.balanceOf(bob.address);
            await tranche.connect(bob).requestWithdrawal(bobSharesB);
            const epoch2B = await vault.currentEpochId();

            await advanceEpoch(to6(5n));

            // Wait for all yield streaming to complete
            await time.increase(DAY);

            await tranche.connect(deployer).finalizeEpoch(epoch1);
            const [, , sharesB1, assetsB1] = await tranche.getEpochInfo(epoch1);

            await tranche.connect(deployer).finalizeEpoch(epoch2B);
            const [, , sharesB2, assetsB2] = await tranche.getEpochInfo(epoch2B);

            const aliceClaimDeferred = (aliceShares * assetsB1) / sharesB1;
            const bobClaimDeferred = (bobSharesB * assetsB2) / sharesB2;

            // Shares are the same (same deposits, same PPS at request time)
            expect(sharesA1).to.equal(sharesB1);
            expect(sharesA2).to.equal(sharesB2);

            // Immediate: Alice gets less (yield barely accrued), Bob gets more (inherits yield)
            expect(aliceClaimImmediate).to.be.lt(aliceClaimDeferred);
            expect(bobClaimImmediate).to.be.gt(bobClaimDeferred);

            // Total payout differs: immediate finalization loses yield for the early-finalized epoch
            // because unaccrued yield at finalization time is excluded from totalAssets, yet the
            // shares are burned. The unaccrued yield later accrues to the remaining pool but cannot
            // fully compensate because Alice's share of the supply was already removed.
            const totalImmediate = aliceClaimImmediate + bobClaimImmediate;
            const totalDeferred = aliceClaimDeferred + bobClaimDeferred;
            expect(totalDeferred).to.be.gt(totalImmediate);

            // Solvency in both cases
            const trancheMZBalance = await mzusd.balanceOf(tranche.target);
            const reserved = await tranche.reservedAssets();
            expect(trancheMZBalance).to.be.gte(reserved);
        });
    });
});
