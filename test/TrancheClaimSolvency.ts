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
    LossManager,
    PauseManager,
} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

const LOSS_MANAGER_ROLE = 3n;
const BURNER_ROLE = 5n;

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

const DAY = 24 * 60 * 60;

async function imp(addr: string) {
    await setBalance(addr, to18(10));
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("Tranche claim solvency", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;
    let dave: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let vault: IssuanceVault;
    let mzusd: MZUSD;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;
    let reservoir: ReservoirUSDC;
    let tranche: Tranche;
    let lossManager: LossManager;
    let whale: any;
    let navOracleRef: any;
    let navOracleSigner: any;

    before(async () => {
        [deployer, alice, bob, carol, dave] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
        usdcTotalSupply = await usdc.totalSupply();
        whale = await imp(USDC_WHALE);
        upgrades.silenceWarnings();
        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

        // Deploy AccessManager
        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        accessManager = await AccessManagerFactory.deploy(deployer.address);
        await accessManager.waitForDeployment();

        // Deploy PauseManager
        const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
        pauseManager = (await upgrades.deployProxy(PauseManagerFactory, [accessManager.target], {
            kind: "uups",
            initializer: "initialize",
        })) as unknown as PauseManager;

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // Deploy ReservoirUSDC
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

        // Deploy MZUSD
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

        // Deploy IssuanceVault
        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, carol.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        })) as unknown as IssuanceVault;

        // Deploy Tranche (umbrella mode, unstakeDelay=0)
        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        tranche = (await upgrades.deployProxy(TrancheFactory, [1, 0, "Senior Tranche", "sMZUSD"], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target, false],
        })) as unknown as Tranche;

        // Deploy LossManager
        const trancheAddr = await tranche.getAddress();
        const mzusdAddr = await mzusd.getAddress();
        const vaultAddr = await vault.getAddress();

        const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
        lossManager = (await upgrades.deployProxy(LossManagerFactory, [0], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vaultAddr],
        })) as unknown as LossManager;

        // Deploy Mock NAV Oracle
        const lossManagerAddr = await lossManager.getAddress();
        const MockNavOracleFactory = await ethers.getContractFactory(
            "MockNavOracleAutomationRef",
            deployer
        );
        navOracleRef = await MockNavOracleFactory.deploy(vaultAddr, lossManagerAddr, mzusdAddr);
        await navOracleRef.waitForDeployment();
        navOracleSigner = await imp(navOracleRef.target as string);

        // Roles setup
        const setVaultSel = mzusd.interface.getFunction("setVault").selector;
        const burnSel = mzusd.interface.getFunction("burn").selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [setVaultSel], ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(mzusdAddr, [burnSel], BURNER_ROLE);
        await accessManager.grantRole(BURNER_ROLE, trancheAddr, 0);

        const distributeSel = vault.interface.getFunction("distributeYield").selector;
        const advanceEpochSel = vault.interface.getFunction("advanceEpoch").selector;
        const addTrancheSel = vault.interface.getFunction("registerTranche").selector;
        const setVaultLossManagerSel = vault.interface.getFunction("setLossManager").selector;
        const setVaultNavOracleSel = vault.interface.getFunction("setNavOracle").selector;

        await accessManager.setTargetFunctionRole(
            vaultAddr,
            [distributeSel, addTrancheSel, setVaultLossManagerSel, setVaultNavOracleSel],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(vaultAddr, [advanceEpochSel], LOSS_MANAGER_ROLE);
        await accessManager.grantRole(LOSS_MANAGER_ROLE, lossManagerAddr, 0);

        const applyLossSel = lossManager.interface.getFunction("applyLoss").selector;
        await accessManager.setTargetFunctionRole(lossManagerAddr, [applyLossSel], ADMIN_ROLE);

        // Wire contracts
        await mzusd.setVault(vaultAddr);
        await vault.setLossManager(lossManagerAddr);
        await vault.setNavOracle(navOracleRef.target);

        // Register tranche (100% weight)
        await vault.registerTranche(trancheAddr);

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

    it("claim succeeds after another user requests withdrawal post-finalization", async () => {
        // Alice and Bob deposit
        await mintAndDeposit(alice, to6(100n));
        await mintAndDeposit(bob, to6(200n));

        // Alice requests withdrawal in epoch 1 → target epoch 1 (delay=0)
        const aliceShares = await tranche.balanceOf(alice.address);
        await tranche.connect(alice).requestWithdrawal(aliceShares);
        const epochAtRequest = await vault.currentEpochId();

        // Advance epoch so finalizeEpoch is allowed
        await advanceEpoch();

        // Finalize epoch 1
        await tranche.connect(deployer).finalizeEpoch(epochAtRequest);
        const reserved = await tranche.reservedAssets();
        expect(reserved).to.be.gt(0n);

        // Bob requests withdrawal AFTER Alice's epoch is finalized
        const bobShares = await tranche.balanceOf(bob);
        await tranche.connect(bob).requestWithdrawal(bobShares);

        // Verify tranche has enough MZUSD to cover Alice's claim
        const trancheMZBalance = await mzusd.balanceOf(tranche);
        expect(trancheMZBalance).to.be.gte(reserved);

        // Alice claims successfully
        const aliceBalBefore = await mzusd.balanceOf(alice);
        await tranche.connect(alice).claim(epochAtRequest);
        const aliceBalAfter = await mzusd.balanceOf(alice);

        expect(aliceBalAfter - aliceBalBefore).to.be.gte(reserved);
        expect(await tranche.reservedAssets()).to.equal(0n);
    });

    it("multiple users claim from the same finalized epoch with sufficient MZUSD", async () => {
        // Alice, Bob, and Carol deposit
        await mintAndDeposit(alice, to6(100n));
        await mintAndDeposit(bob, to6(200n));
        await mintAndDeposit(carol, to6(300n));

        // All three request withdrawal in the same epoch
        const aliceShares = await tranche.balanceOf(alice);
        const bobShares = await tranche.balanceOf(bob);
        const carolShares = await tranche.balanceOf(carol);

        await tranche.connect(alice).requestWithdrawal(aliceShares);
        await tranche.connect(bob).requestWithdrawal(bobShares);
        await tranche.connect(carol).requestWithdrawal(carolShares);

        const epochAtRequest = await vault.currentEpochId();

        // Advance and finalize
        await advanceEpoch();
        await tranche.connect(deployer).finalizeEpoch(epochAtRequest);

        const [, isFinalized, totalSharesFinal, totalAssetsFinal] =
            await tranche.getEpochInfo(epochAtRequest);
        expect(isFinalized).to.equal(true);

        // Verify tranche MZUSD balance covers reserved assets
        const trancheMZBalance = await mzusd.balanceOf(tranche);
        const reserved = await tranche.reservedAssets();
        expect(trancheMZBalance).to.be.gte(reserved);

        // All three claim successfully
        const expectedAlice = (aliceShares * totalAssetsFinal) / totalSharesFinal;
        const expectedBob = (bobShares * totalAssetsFinal) / totalSharesFinal;
        const expectedCarol = (carolShares * totalAssetsFinal) / totalSharesFinal;

        const aliceBefore = await mzusd.balanceOf(alice);
        const bobBefore = await mzusd.balanceOf(bob);
        const carolBefore = await mzusd.balanceOf(carol);

        await tranche.connect(alice).claim(epochAtRequest);
        await tranche.connect(bob).claim(epochAtRequest);
        await tranche.connect(carol).claim(epochAtRequest);

        expect(await mzusd.balanceOf(alice)).to.equal(aliceBefore + expectedAlice);
        expect(await mzusd.balanceOf(bob)).to.equal(bobBefore + expectedBob);
        expect(await mzusd.balanceOf(carol)).to.equal(carolBefore + expectedCarol);

        // All reserved assets consumed
        expect(await tranche.reservedAssets()).to.equal(0n);
    });

    it("users with finalized requests can still claim after loss is applied", async () => {
        // Alice and Bob deposit
        await mintAndDeposit(alice, to6(100n));
        await mintAndDeposit(bob, to6(200n));

        // Alice requests withdrawal
        const aliceShares = await tranche.balanceOf(alice);
        await tranche.connect(alice).requestWithdrawal(aliceShares);
        const epochAtRequest = await vault.currentEpochId();

        // Advance epoch and finalize Alice's epoch
        await advanceEpoch();
        await tranche.connect(deployer).finalizeEpoch(epochAtRequest);

        const [, isFinalized, , totalAssetsFinal] = await tranche.getEpochInfo(epochAtRequest);
        expect(isFinalized).to.equal(true);
        const reservedBefore = await tranche.reservedAssets();
        expect(reservedBefore).to.equal(totalAssetsFinal);

        // Apply loss via LossManager (burns MZUSD from the tranche)
        // Loss is 50 USDC — only Bob's remaining TVL is exposed since Alice's share is reserved
        const trancheTotalAssets = await tranche.totalAssets();
        // Apply a loss smaller than remaining (non-reserved) TVL
        const lossUsdc = trancheTotalAssets > to18(50n) ? to6(50n) : to6(1n);

        // applyLoss internally calls vault.advanceEpoch(), so just wait for min epoch duration
        await time.increase(DAY);
        await lossManager.connect(navOracleSigner).applyLoss(lossUsdc);

        // Reserved assets are unchanged — loss hit the non-reserved pool
        expect(await tranche.reservedAssets()).to.equal(reservedBefore);

        // Tranche still holds enough MZUSD to cover Alice's reserved claim
        const trancheMZBalance = await mzusd.balanceOf(tranche.target);
        expect(trancheMZBalance).to.be.gte(reservedBefore);

        // Alice claims successfully
        const aliceBefore = await mzusd.balanceOf(alice);
        await tranche.connect(alice).claim(epochAtRequest);
        const aliceClaimed = (await mzusd.balanceOf(alice)) - aliceBefore;

        expect(aliceClaimed).to.equal(totalAssetsFinal);
        expect(await tranche.reservedAssets()).to.equal(0n);
    });
});
