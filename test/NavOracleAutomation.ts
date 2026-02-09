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
    IERC20,
    LossManager,
    MZUSD,
    NavOracleAutomation,
    ReservoirUSDC,
    Tranche,
    Vault,
    PauseManager,
} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

const DAY = 24 * 60 * 60;
const SCALE = 10n ** 12n;

const LOSS_MANAGER_ROLE = 3n;
const ORACLE_ROLE = 6n;
const BURNER_ROLE = 5n;

const to6 = (value: string | number | bigint) => parseUnits(value.toString(), 6);
const to18 = (value: string | number | bigint) => parseUnits(value.toString(), 18);

async function imp(addr: string) {
    await setBalance(addr, to18(10));
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("NavOracleAutomation", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let oracle: any;
    let bob: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;
    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;
    let tranche: Tranche;
    let lossManager: LossManager;
    let navAutomation: NavOracleAutomation;
    let whale: any;

    before(async () => {
        [deployer, oracle, bob] = await ethers.getSigners();

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

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                pauseManager.target,
                usdcTotalSupply, // _limitUSDC (max allowed)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, oracle.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        })) as unknown as Vault;

        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        tranche = (await upgrades.deployProxy(
            TrancheFactory,
            [
                1, // trancheIdentifier
                0, // initialUnstakeDelayEpochs
                "Senior Tranche", // name
                "sMZUSD", // symbol
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [vault.target, false], // direct withdraw disabled
            }
        )) as unknown as Tranche;

        const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
        lossManager = (await upgrades.deployProxy(
            LossManagerFactory,
            [
                [tranche.target],
                [false],
                0, // maxLossPerTxUSDC
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [vault.target],
            }
        )) as unknown as LossManager;

        const NavAutomationFactory = await ethers.getContractFactory(
            "NavOracleAutomation",
            deployer
        );
        navAutomation = (await NavAutomationFactory.deploy(
            lossManager.target,
            DAY
        )) as unknown as NavOracleAutomation;
        await navAutomation.waitForDeployment();

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const setVaultSelector = mzusd.interface.getFunction("setVault").selector;
        const burnSelector = mzusd.interface.getFunction("burn").selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSelector], ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(mzusd.target, [burnSelector], BURNER_ROLE);
        await mzusd.setVault(vault.target);
        await accessManager.grantRole(BURNER_ROLE, tranche.target as string, 0);
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // Admin-only functions on MZUSD & Vault
        const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSelector = vault.interface.getFunction("addTranche").selector;
        const setYieldDistributionSelector =
            vault.interface.getFunction("setYieldDistribution").selector;
        const advanceEpochSelector = vault.interface.getFunction("advanceEpoch").selector;
        const setVaultLossManagerSelector = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSelector = vault.interface.getFunction("setNavOracle").selector;
        await accessManager.setTargetFunctionRole(
            vault.target,
            [
                distributeYieldSelector,
                addTrancheSelector,
                setYieldDistributionSelector,
                setVaultLossManagerSelector,
                setNavOracleSelector,
            ],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(
            vault.target,
            [advanceEpochSelector],
            LOSS_MANAGER_ROLE
        );

        // LossManager permissions
        await accessManager.grantRole(LOSS_MANAGER_ROLE, lossManager.target, 0);

        const applyLossSelector = lossManager.interface.getFunction("applyLoss").selector;
        await accessManager.setTargetFunctionRole(
            lossManager.target,
            [applyLossSelector],
            ADMIN_ROLE
        );

        // NAV automation roles
        const submitSelector = navAutomation.interface.getFunction("submitNav").selector;
        const rejectSelector = navAutomation.interface.getFunction("rejectPendingNav").selector;
        const setVetoSelector = navAutomation.interface.getFunction("setVetoPeriod").selector;
        await accessManager.setTargetFunctionRole(
            navAutomation.target,
            [submitSelector],
            ORACLE_ROLE
        );
        await accessManager.setTargetFunctionRole(
            navAutomation.target,
            [rejectSelector, setVetoSelector],
            ADMIN_ROLE
        );
        await accessManager.grantRole(ORACLE_ROLE, oracle.address, 0);
        await accessManager.grantRole(ADMIN_ROLE, navAutomation.target, 0);

        // Wire protocol and register tranche in Vault
        await vault.setLossManager(lossManager.target);
        await vault.setNavOracle(navAutomation.target);

        await vault.addTranche(tranche.target);
        await vault.setYieldDistribution(0, [10_000], [true]);

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

    async function mintAndDepositIntoTranche(user: any, usdcAmount6: bigint) {
        const mintedMZ = await mintMZUSDFor(user, usdcAmount6);
        await mzusd.connect(user).approve(tranche.target, mintedMZ);
        await (await tranche.connect(user).deposit(mintedMZ, user.address)).wait();
        return mintedMZ;
    }

    it("submits NAV snapshot and blocks double submit", async () => {
        await mintAndDepositIntoTranche(oracle, to6(100n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(10n);
        const deltaUSDC = navUSDC - totalSupplyUSDC;

        const tx = await navAutomation.connect(oracle).submitNav(navUSDC);
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);
        const submittedAt = BigInt(block!.timestamp);
        const readyAt = submittedAt + BigInt(await navAutomation.vetoPeriod());

        await expect(tx)
            .to.emit(navAutomation, "NavSubmitted")
            .withArgs(navUSDC, totalSupplyMZ, true, deltaUSDC, submittedAt, readyAt);

        expect(await navAutomation.hasPendingNav()).to.equal(true);
        expect(await navAutomation.pendingDeltaUSDC()).to.equal(deltaUSDC);
        expect(await navAutomation.pendingIsYield()).to.equal(true);

        await expect(
            navAutomation.connect(oracle).submitNav(navUSDC)
        ).to.be.revertedWithCustomError(navAutomation, "PendingNavExists");
    });

    it("performUpkeep reverts when protocol is paused", async () => {
        await mintAndDepositIntoTranche(oracle, to6(10n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(1n);

        await navAutomation.connect(oracle).submitNav(navUSDC);
        await time.increase(DAY);

        await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);

        await expect(navAutomation.performUpkeep("0x"))
            .to.be.revertedWithCustomError(vault, "CategoryPaused")
            .withArgs(PauseCategory.PROTOCOL);
    });

    it("performUpkeep reverts with NotReady and returns pending readyAt", async () => {
        await mintAndDepositIntoTranche(oracle, to6(10n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(1n);

        await navAutomation.connect(oracle).submitNav(navUSDC);
        const readyAt = await navAutomation.pendingReadyAt();

        await expect(navAutomation.performUpkeep("0x"))
            .to.be.revertedWithCustomError(navAutomation, "NotReady")
            .withArgs(readyAt);
    });

    it("rejectPendingNav reverts when no pending snapshot exists", async () => {
        await expect(
            navAutomation.connect(deployer).rejectPendingNav()
        ).to.be.revertedWithCustomError(navAutomation, "NoPendingNav");
    });

    it("reject clears pending NAV", async () => {
        await mintAndDepositIntoTranche(oracle, to6(50n));
        const navUSDC = to6(40n);

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const isYield = navUSDC >= totalSupplyUSDC;
        const deltaUSDC = isYield ? navUSDC - totalSupplyUSDC : totalSupplyUSDC - navUSDC;
        const tx = await navAutomation.connect(oracle).submitNav(navUSDC);
        await expect(tx).to.emit(navAutomation, "NavSubmitted");
        const readyAt = await navAutomation.pendingReadyAt();

        const rejectTx = await navAutomation.connect(deployer).rejectPendingNav();
        await expect(rejectTx)
            .to.emit(navAutomation, "NavRejected")
            .withArgs(isYield, deltaUSDC, readyAt);

        expect(await navAutomation.hasPendingNav()).to.equal(false);
    });

    it("allows a new submit after reject clears pending state", async () => {
        await mintAndDepositIntoTranche(oracle, to6(50n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;

        const firstNav = totalSupplyUSDC + to6(1n);
        await navAutomation.connect(oracle).submitNav(firstNav);
        await navAutomation.connect(deployer).rejectPendingNav();

        const secondNav = totalSupplyUSDC + to6(2n);
        await expect(navAutomation.connect(oracle).submitNav(secondNav)).to.emit(
            navAutomation,
            "NavSubmitted"
        );
        expect(await navAutomation.hasPendingNav()).to.equal(true);
        expect(await navAutomation.pendingDeltaUSDC()).to.equal(to6(2n));
        expect(await navAutomation.pendingIsYield()).to.equal(true);
    });

    it("applies yield after veto period", async () => {
        await mintAndDepositIntoTranche(oracle, to6(100n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(5n);
        const deltaUSDC = navUSDC - totalSupplyUSDC;

        await navAutomation.connect(oracle).submitNav(navUSDC);
        const readyAt = await navAutomation.pendingReadyAt();

        await time.increase(DAY);

        const [upkeepNeeded] = await navAutomation.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        const epochBefore = await vault.currentEpochId();
        await expect(navAutomation.performUpkeep("0x"))
            .to.emit(navAutomation, "NavApplied")
            .withArgs(true, deltaUSDC, readyAt);
        const epochAfter = await vault.currentEpochId();

        expect(epochAfter).to.equal(epochBefore + 1n);
        expect(await navAutomation.hasPendingNav()).to.equal(false);
    });

    it("applies loss after veto period", async () => {
        await mintAndDepositIntoTranche(oracle, to6(120n));

        const totalSupplyBefore = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyBefore / SCALE;
        const navUSDC = totalSupplyUSDC - to6(20n);
        const deltaUSDC = totalSupplyUSDC - navUSDC;

        await navAutomation.connect(oracle).submitNav(navUSDC);
        const readyAt = await navAutomation.pendingReadyAt();
        await time.increase(DAY);

        await expect(navAutomation.performUpkeep("0x"))
            .to.emit(navAutomation, "NavApplied")
            .withArgs(false, deltaUSDC, readyAt);

        const totalSupplyAfter = await mzusd.totalSupply();
        expect(totalSupplyAfter).to.equal(totalSupplyBefore - deltaUSDC * SCALE);
        expect(await navAutomation.hasPendingNav()).to.equal(false);
    });

    it("zero-yield path advances epoch and clears pending NAV", async () => {
        await mintAndDepositIntoTranche(oracle, to6(80n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;

        await navAutomation.connect(oracle).submitNav(totalSupplyUSDC);
        await time.increase(DAY);

        const epochBefore = await vault.currentEpochId();
        await navAutomation.performUpkeep("0x");
        const epochAfter = await vault.currentEpochId();
        expect(epochAfter).to.equal(epochBefore + 1n);
        expect(await navAutomation.hasPendingNav()).to.equal(false);
    });

    it("veto period 0 applies immediately", async () => {
        await navAutomation.connect(deployer).setVetoPeriod(0);
        await mintAndDepositIntoTranche(oracle, to6(60n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(3n);

        await time.increase(DAY);

        const epochBefore = await vault.currentEpochId();
        await navAutomation.connect(oracle).submitNav(navUSDC);
        const epochAfter = await vault.currentEpochId();

        expect(epochAfter).to.equal(epochBefore + 1n);
        expect(await navAutomation.hasPendingNav()).to.equal(false);
    });

    it("pins pending readyAt to submit-time veto period snapshot", async () => {
        await navAutomation.connect(deployer).setVetoPeriod(DAY);
        await mintAndDepositIntoTranche(oracle, to6(70n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(2n);

        const submitTx = await navAutomation.connect(oracle).submitNav(navUSDC);
        const receipt = await submitTx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);
        const submittedAt = BigInt(block!.timestamp);
        const expectedReadyAt = submittedAt + BigInt(DAY);

        expect(await navAutomation.pendingReadyAt()).to.equal(expectedReadyAt);

        // Changing vetoPeriod now must not affect already pending NAV.
        await navAutomation.connect(deployer).setVetoPeriod(0);
        expect(await navAutomation.pendingReadyAt()).to.equal(expectedReadyAt);

        const [neededNow] = await navAutomation.checkUpkeep("0x");
        expect(neededNow).to.equal(false);

        await time.increase(DAY);
        const [neededAfter] = await navAutomation.checkUpkeep("0x");
        expect(neededAfter).to.equal(true);
    });

    it("reverts submitNav when computed delta exceeds uint128 storage bound", async () => {
        // Build NAV so computed delta is exactly uint128.max + 1.
        await mintAndDepositIntoTranche(oracle, to6(1n));
        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const tooLargeNav = (1n << 128n) + totalSupplyUSDC;

        await expect(
            navAutomation.connect(oracle).submitNav(tooLargeNav)
        ).to.be.revertedWithCustomError(navAutomation, "ValueTooLarge");
    });

    it("ignores checkData and performData payloads", async () => {
        await mintAndDepositIntoTranche(oracle, to6(90n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(4n);

        await navAutomation.connect(oracle).submitNav(navUSDC);
        await time.increase(DAY);

        const [upkeepNeeded] = await navAutomation.checkUpkeep("0x1234");
        expect(upkeepNeeded).to.equal(true);

        const epochBefore = await vault.currentEpochId();
        await navAutomation.performUpkeep("0xdeadbeef");
        const epochAfter = await vault.currentEpochId();

        expect(epochAfter).to.equal(epochBefore + 1n);
        expect(await navAutomation.hasPendingNav()).to.equal(false);
    });

    it("enforces max veto period", async () => {
        const max = BigInt(5 * DAY);
        await navAutomation.connect(deployer).setVetoPeriod(max);
        expect(await navAutomation.vetoPeriod()).to.equal(max);

        await expect(
            navAutomation.connect(deployer).setVetoPeriod(max + 1n)
        ).to.be.revertedWithCustomError(navAutomation, "InvalidVetoPeriod");
    });

    it("rotates nav oracle end-to-end (old submits, switch, new submits, old revoked)", async () => {
        await mintAndDepositIntoTranche(oracle, to6(100n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(5n);

        await navAutomation.connect(oracle).submitNav(navUSDC);
        await time.increase(DAY);
        await navAutomation.performUpkeep("0x");

        const NavAutomationFactory = await ethers.getContractFactory(
            "NavOracleAutomation",
            deployer
        );
        const navAutomation2 = (await NavAutomationFactory.deploy(
            lossManager.target,
            DAY
        )) as unknown as NavOracleAutomation;
        await navAutomation2.waitForDeployment();

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const submitSelector = navAutomation2.interface.getFunction("submitNav").selector;
        const rejectSelector = navAutomation2.interface.getFunction("rejectPendingNav").selector;
        const setVetoSelector = navAutomation2.interface.getFunction("setVetoPeriod").selector;
        await accessManager.setTargetFunctionRole(
            navAutomation2.target,
            [submitSelector],
            ORACLE_ROLE
        );
        await accessManager.setTargetFunctionRole(
            navAutomation2.target,
            [rejectSelector, setVetoSelector],
            ADMIN_ROLE
        );
        await accessManager.grantRole(ADMIN_ROLE, navAutomation2.target, 0);

        await vault.setNavOracle(navAutomation2.target);

        await accessManager.revokeRole(ORACLE_ROLE, oracle.address);
        await accessManager.revokeRole(ADMIN_ROLE, navAutomation.target);
        await accessManager.grantRole(ORACLE_ROLE, bob.address, 0);

        await expect(navAutomation.connect(oracle).submitNav(navUSDC)).to.be.reverted;

        const totalSupplyMZ2 = await mzusd.totalSupply();
        const totalSupplyUSDC2 = totalSupplyMZ2 / SCALE;
        const navUSDC2 = totalSupplyUSDC2 + to6(1n);
        await navAutomation2.connect(bob).submitNav(navUSDC2);
        await time.increase(DAY);
        await navAutomation2.performUpkeep("0x");

        expect(await vault.navOracle()).to.equal(navAutomation2.target);
        expect(await navAutomation2.hasPendingNav()).to.equal(false);
    });
});
