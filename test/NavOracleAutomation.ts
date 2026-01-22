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

const VAULT_ROLE = 2n;
const LOSS_MANAGER_ROLE = 3n;
const ORACLE_ROLE = 6n;

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

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(
            VaultFactory,
            [accessManager.target, pauseManager.target, 0, bob.address, 0, oracle.address],
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
                usdcTotalSupply, // _limitUSDC (max allowed)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC, vault.target],
            }
        )) as unknown as MZUSD;

        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        tranche = (await upgrades.deployProxy(
            TrancheFactory,
            [
                mzusd.target, // assetToken (MZUSD as IERC20)
                vault.target, // vaultAddress
                1, // trancheIdentifier
                0, // initialUnstakeDelayEpochs
                "Senior Tranche", // name
                "sMZUSD", // symbol
                accessManager.target, // accessManager
                pauseManager.target, // pauseManager
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [false], // direct withdraw disabled
            }
        )) as unknown as Tranche;

        const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
        lossManager = (await upgrades.deployProxy(
            LossManagerFactory,
            [
                accessManager.target,
                pauseManager.target,
                mzusd.target,
                vault.target,
                [tranche.target],
                [0],
                0, // maxLossPerTxUSDC
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as LossManager;

        const NavAutomationFactory = await ethers.getContractFactory(
            "NavOracleAutomation",
            deployer
        );
        navAutomation = (await NavAutomationFactory.deploy(
            accessManager.target,
            mzusd.target,
            vault.target,
            lossManager.target,
            DAY
        )) as unknown as NavOracleAutomation;
        await navAutomation.waitForDeployment();

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const setLossManagerSelector = mzusd.interface.getFunction("setLossManager").selector;
        await accessManager.setTargetFunctionRole(
            mzusd.target,
            [setLossManagerSelector],
            ADMIN_ROLE
        );
        await mzusd.setLossManager(lossManager.target);
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // Admin-only functions on MZUSD & Vault
        const setMZUSDSelector = vault.interface.getFunction("setMZUSD").selector;
        const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSelector = vault.interface.getFunction("addTranche").selector;
        const advanceEpochSelector = vault.interface.getFunction("advanceEpoch").selector;
        const setVaultLossManagerSelector = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSelector = vault.interface.getFunction("setNavOracle").selector;
        await accessManager.setTargetFunctionRole(
            vault.target,
            [
                setMZUSDSelector,
                distributeYieldSelector,
                addTrancheSelector,
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

        // Vault role allowed to push yield to tranches
        const notifySelector = tranche.interface.getFunction("notifyYield").selector;
        await accessManager.setTargetFunctionRole(tranche.target, [notifySelector], VAULT_ROLE);

        await accessManager.grantRole(
            VAULT_ROLE,
            vault.target,
            0 // executionDelay
        );

        // LossManager permissions
        await accessManager.grantRole(LOSS_MANAGER_ROLE, lossManager.target, 0);

        const applyLossSelector = lossManager.interface.getFunction("applyLoss").selector;
        const setNavOracleLossSelector = lossManager.interface.getFunction("setNavOracle").selector;
        await accessManager.setTargetFunctionRole(
            lossManager.target,
            [applyLossSelector, setNavOracleLossSelector],
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

        // Wire Vault to MZUSD and register tranche in Vault
        await vault.setMZUSD(mzusd.target);
        await vault.setLossManager(lossManager.target);
        await vault.setNavOracle(navAutomation.target);
        await lossManager.setNavOracle(navAutomation.target);
        await vault.addTranche({
            tranche: tranche.target,
            weight: 10_000,
            enabled: true,
        });

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
        expect(await navAutomation.pendingNavUSDC()).to.equal(navUSDC);

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

    it("reject clears pending NAV", async () => {
        await mintAndDepositIntoTranche(oracle, to6(50n));
        const navUSDC = to6(40n);

        const totalSupplyMZ = await mzusd.totalSupply();
        const tx = await navAutomation.connect(oracle).submitNav(navUSDC);
        await expect(tx).to.emit(navAutomation, "NavSubmitted");

        const rejectTx = await navAutomation.connect(deployer).rejectPendingNav();
        await expect(rejectTx)
            .to.emit(navAutomation, "NavRejected")
            .withArgs(navUSDC, totalSupplyMZ);

        expect(await navAutomation.hasPendingNav()).to.equal(false);
    });

    it("applies yield after veto period", async () => {
        await mintAndDepositIntoTranche(oracle, to6(100n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(5n);

        await navAutomation.connect(oracle).submitNav(navUSDC);

        await time.increase(DAY);

        const [upkeepNeeded] = await navAutomation.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        const epochBefore = await vault.currentEpochId();
        await navAutomation.performUpkeep("0x");
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
        await time.increase(DAY);

        await navAutomation.performUpkeep("0x");

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

    it("enforces max veto period", async () => {
        const max = BigInt(5 * DAY);
        await navAutomation.connect(deployer).setVetoPeriod(max);
        expect(await navAutomation.vetoPeriod()).to.equal(max);

        await expect(
            navAutomation.connect(deployer).setVetoPeriod(max + 1n)
        ).to.be.revertedWithCustomError(navAutomation, "InvalidVetoPeriod");
    });
});
