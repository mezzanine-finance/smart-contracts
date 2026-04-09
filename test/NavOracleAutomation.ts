import {expect} from "chai";
import {ethers, upgrades, network} from "hardhat";
import {parseUnits} from "ethers";
import {anyValue} from "@nomicfoundation/hardhat-chai-matchers/withArgs";
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
    MockPackedNavOracle,
    NavOracleAutomation,
    ReservoirUSDC,
    Tranche,
    IssuanceVault,
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
const CHAINLINK_AUTOMATION = 9n;

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
    let chainlinkAutomation: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;
    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: IssuanceVault;
    let tranche: Tranche;
    let lossManager: LossManager;
    let navAutomation: NavOracleAutomation;
    let navFeedOracle: MockPackedNavOracle;
    let totalSupplyFeedOracle: MockPackedNavOracle;
    let whale: any;

    before(async () => {
        [deployer, oracle, bob, chainlinkAutomation] = await ethers.getSigners();

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
        await allowlist.addBatch([deployer.address, oracle.address, bob.address]);

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                pauseManager.target,
                allowlist.target,
                usdcTotalSupply, // _limitUSDC (max allowed)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, oracle.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        })) as unknown as IssuanceVault;

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
        lossManager = (await upgrades.deployProxy(LossManagerFactory, [0], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target],
        })) as unknown as LossManager;

        const NavAutomationFactory = await ethers.getContractFactory(
            "NavOracleAutomation",
            deployer
        );
        navAutomation = (await NavAutomationFactory.deploy(
            lossManager.target,
            DAY
        )) as unknown as NavOracleAutomation;
        await navAutomation.waitForDeployment();

        const PackedOracleFactory = await ethers.getContractFactory(
            "MockPackedNavOracle",
            deployer
        );
        navFeedOracle = (await PackedOracleFactory.deploy(
            18,
            "Mock NAV oracle"
        )) as unknown as MockPackedNavOracle;
        await navFeedOracle.waitForDeployment();
        totalSupplyFeedOracle = (await PackedOracleFactory.deploy(
            18,
            "Mock totalSupply oracle"
        )) as unknown as MockPackedNavOracle;
        await totalSupplyFeedOracle.waitForDeployment();

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const setVaultSelector = mzusd.interface.getFunction("setVault").selector;
        const burnSelector = mzusd.interface.getFunction("burn").selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSelector], ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(mzusd.target, [burnSelector], BURNER_ROLE);
        await mzusd.setVault(vault.target);
        await accessManager.grantRole(BURNER_ROLE, tranche.target as string, 0);
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // Admin-only functions on MZUSD & IssuanceVault
        const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSelector = vault.interface.getFunction("registerTranche").selector;
        const setYieldDistributionSelector =
            vault.interface.getFunction("setTrancheConfig").selector;
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
        const setOraclesSelector = navAutomation.interface.getFunction("setOracles").selector;
        const setStalenessSelector =
            navAutomation.interface.getFunction("setMaxAnswerStaleness").selector;
        await accessManager.setTargetFunctionRole(
            navAutomation.target,
            [submitSelector],
            ORACLE_ROLE
        );
        await accessManager.setTargetFunctionRole(
            navAutomation.target,
            [rejectSelector, setVetoSelector, setOraclesSelector, setStalenessSelector],
            ADMIN_ROLE
        );
        await accessManager.grantRole(ORACLE_ROLE, oracle.address, 0);
        await accessManager.grantRole(ADMIN_ROLE, navAutomation.target, 0);

        const performUpkeepSelector = navAutomation.interface.getFunction("performUpkeep").selector;
        await accessManager.setTargetFunctionRole(
            navAutomation.target,
            [performUpkeepSelector],
            CHAINLINK_AUTOMATION
        );
        await accessManager.grantRole(CHAINLINK_AUTOMATION, chainlinkAutomation, 0);

        await navAutomation
            .connect(deployer)
            .setOracles(navFeedOracle.target, totalSupplyFeedOracle.target);

        // Wire protocol and register tranche in IssuanceVault
        await vault.setLossManager(lossManager.target);
        await vault.setNavOracle(navAutomation.target);

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

    async function pushOracleAnswers(
        navUSDC: bigint,
        totalSupplyMZ: bigint,
        updatedAt?: bigint
    ): Promise<void> {
        const ts = updatedAt ?? BigInt(await time.latest());
        await navFeedOracle.setLatestRoundData(navUSDC, ts);
        await totalSupplyFeedOracle.setLatestRoundData(totalSupplyMZ, ts);
    }

    it("submits NAV snapshot and blocks double submit", async () => {
        await mintAndDepositIntoTranche(oracle, to6(100n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(10n);
        const deltaUSDC = navUSDC - totalSupplyUSDC;
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        const tx = await navAutomation.connect(oracle).submitNav();
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

        await expect(navAutomation.connect(oracle).submitNav()).to.be.revertedWithCustomError(
            navAutomation,
            "PendingNavExists"
        );
    });

    it("checkUpkeep returns false when protocol is globally paused", async () => {
        await mintAndDepositIntoTranche(oracle, to6(10n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(1n);
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        await navAutomation.connect(oracle).submitNav();
        await time.increase(DAY);

        // Upkeep is needed before pause
        const [neededBefore] = await navAutomation.checkUpkeep("0x");
        expect(neededBefore).to.equal(true);

        await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);

        // Upkeep is no longer needed while paused
        const [neededAfter] = await navAutomation.checkUpkeep("0x");
        expect(neededAfter).to.equal(false);
    });

    it("checkUpkeep returns false when vault is paused for PROTOCOL (loss path)", async () => {
        await mintAndDepositIntoTranche(oracle, to6(120n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC - to6(20n);
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        await navAutomation.connect(oracle).submitNav();
        await time.increase(DAY);

        // Pause PROTOCOL only on the vault — applyLoss calls advanceEpoch on vault
        await pauseManager.pauseContract(vault.target, PauseCategory.PROTOCOL);

        const [needed] = await navAutomation.checkUpkeep("0x");
        expect(needed).to.equal(false);
    });

    it("checkUpkeep returns false when lossManager is paused for PROTOCOL", async () => {
        await mintAndDepositIntoTranche(oracle, to6(120n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC - to6(20n);
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        await navAutomation.connect(oracle).submitNav();
        await time.increase(DAY);

        await pauseManager.pauseContract(lossManager.target, PauseCategory.PROTOCOL);

        const [needed] = await navAutomation.checkUpkeep("0x");
        expect(needed).to.equal(false);
    });

    it("performUpkeep reverts with NotReady and returns pending readyAt", async () => {
        await mintAndDepositIntoTranche(oracle, to6(10n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(1n);
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        await navAutomation.connect(oracle).submitNav();
        const readyAt = await navAutomation.pendingReadyAt();

        await expect(navAutomation.connect(chainlinkAutomation).performUpkeep("0x"))
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
        await pushOracleAnswers(navUSDC, totalSupplyMZ);
        const tx = await navAutomation.connect(oracle).submitNav();
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
        await pushOracleAnswers(firstNav, totalSupplyMZ);
        await navAutomation.connect(oracle).submitNav();
        await navAutomation.connect(deployer).rejectPendingNav();

        const secondNav = totalSupplyUSDC + to6(2n);
        await pushOracleAnswers(secondNav, totalSupplyMZ);
        await expect(navAutomation.connect(oracle).submitNav()).to.emit(
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
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        await navAutomation.connect(oracle).submitNav();
        const readyAt = await navAutomation.pendingReadyAt();

        await time.increase(DAY);

        const [upkeepNeeded] = await navAutomation.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        const epochBefore = await vault.currentEpochId();
        await expect(navAutomation.connect(chainlinkAutomation).performUpkeep("0x"))
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
        await pushOracleAnswers(navUSDC, totalSupplyBefore);

        await navAutomation.connect(oracle).submitNav();
        const readyAt = await navAutomation.pendingReadyAt();
        await time.increase(DAY);

        await expect(navAutomation.connect(chainlinkAutomation).performUpkeep("0x"))
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
        await pushOracleAnswers(totalSupplyUSDC, totalSupplyMZ);

        await navAutomation.connect(oracle).submitNav();
        await time.increase(DAY);

        const epochBefore = await vault.currentEpochId();
        await navAutomation.connect(chainlinkAutomation).performUpkeep("0x");
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
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        const epochBefore = await vault.currentEpochId();
        await navAutomation.connect(oracle).submitNav();
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
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        const submitTx = await navAutomation.connect(oracle).submitNav();
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

    it("reverts submitNav when NAV oracle answer is stale", async () => {
        await mintAndDepositIntoTranche(oracle, to6(1n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(1n);
        const staleUpdatedAt = BigInt(await time.latest()) - BigInt(DAY);
        await pushOracleAnswers(navUSDC, totalSupplyMZ, staleUpdatedAt);
        const maxStaleness = await navAutomation.maxAnswerStaleness();

        await expect(navAutomation.connect(oracle).submitNav())
            .to.be.revertedWithCustomError(navAutomation, "StaleOracleAnswer")
            .withArgs(navFeedOracle.target, staleUpdatedAt, anyValue, maxStaleness);
    });

    it("reverts submitNav when total supply oracle answer is stale", async () => {
        await mintAndDepositIntoTranche(oracle, to6(1n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(1n);
        const nowTs = BigInt(await time.latest());
        const staleUpdatedAt = nowTs - BigInt(DAY);
        const maxStaleness = await navAutomation.maxAnswerStaleness();

        await navFeedOracle.setLatestRoundData(navUSDC, nowTs);
        await totalSupplyFeedOracle.setLatestRoundData(totalSupplyMZ, staleUpdatedAt);

        await expect(navAutomation.connect(oracle).submitNav())
            .to.be.revertedWithCustomError(navAutomation, "StaleOracleAnswer")
            .withArgs(totalSupplyFeedOracle.target, staleUpdatedAt, anyValue, maxStaleness);
    });

    it("reverts submitNav when NAV oracle timestamp is invalid", async () => {
        await mintAndDepositIntoTranche(oracle, to6(1n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(1n);
        const futureUpdatedAt = BigInt(await time.latest()) + 60n;

        await pushOracleAnswers(navUSDC, totalSupplyMZ, futureUpdatedAt);

        await expect(navAutomation.connect(oracle).submitNav())
            .to.be.revertedWithCustomError(navAutomation, "InvalidOracleTimestamp")
            .withArgs(navFeedOracle.target, futureUpdatedAt);
    });

    it("reverts submitNav when total supply oracle timestamp is invalid", async () => {
        await mintAndDepositIntoTranche(oracle, to6(1n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(1n);
        const nowTs = BigInt(await time.latest());
        const futureUpdatedAt = nowTs + 60n;

        await navFeedOracle.setLatestRoundData(navUSDC, nowTs);
        await totalSupplyFeedOracle.setLatestRoundData(totalSupplyMZ, futureUpdatedAt);

        await expect(navAutomation.connect(oracle).submitNav())
            .to.be.revertedWithCustomError(navAutomation, "InvalidOracleTimestamp")
            .withArgs(totalSupplyFeedOracle.target, futureUpdatedAt);
    });

    it("ignores checkData and performData payloads", async () => {
        await mintAndDepositIntoTranche(oracle, to6(90n));

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC + to6(4n);
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        await navAutomation.connect(oracle).submitNav();
        await time.increase(DAY);

        const [upkeepNeeded] = await navAutomation.checkUpkeep("0x1234");
        expect(upkeepNeeded).to.equal(true);

        const epochBefore = await vault.currentEpochId();
        await navAutomation.connect(chainlinkAutomation).performUpkeep("0xdeadbeef");
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
        await pushOracleAnswers(navUSDC, totalSupplyMZ);

        await navAutomation.connect(oracle).submitNav();
        await time.increase(DAY);
        await navAutomation.connect(chainlinkAutomation).performUpkeep("0x");

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
        const setOraclesSelector = navAutomation2.interface.getFunction("setOracles").selector;
        const setStalenessSelector =
            navAutomation2.interface.getFunction("setMaxAnswerStaleness").selector;
        await accessManager.setTargetFunctionRole(
            navAutomation2.target,
            [submitSelector],
            ORACLE_ROLE
        );
        await accessManager.setTargetFunctionRole(
            navAutomation2.target,
            [rejectSelector, setVetoSelector, setOraclesSelector, setStalenessSelector],
            ADMIN_ROLE
        );
        await accessManager.grantRole(ADMIN_ROLE, navAutomation2.target, 0);
        const performUpkeepSelector2 =
            navAutomation2.interface.getFunction("performUpkeep").selector;
        await accessManager.setTargetFunctionRole(
            navAutomation2.target,
            [performUpkeepSelector2],
            CHAINLINK_AUTOMATION
        );
        await navAutomation2
            .connect(deployer)
            .setOracles(navFeedOracle.target, totalSupplyFeedOracle.target);

        await vault.setNavOracle(navAutomation2.target);

        await accessManager.revokeRole(ORACLE_ROLE, oracle.address);
        await accessManager.revokeRole(ADMIN_ROLE, navAutomation.target);
        await accessManager.grantRole(ORACLE_ROLE, bob.address, 0);

        await expect(navAutomation.connect(oracle).submitNav()).to.be.reverted;

        const totalSupplyMZ2 = await mzusd.totalSupply();
        const totalSupplyUSDC2 = totalSupplyMZ2 / SCALE;
        const navUSDC2 = totalSupplyUSDC2 + to6(1n);
        await pushOracleAnswers(navUSDC2, totalSupplyMZ2);
        await navAutomation2.connect(bob).submitNav();
        await time.increase(DAY);
        await navAutomation2.connect(chainlinkAutomation).performUpkeep("0x");

        expect(await vault.navOracle()).to.equal(navAutomation2.target);
        expect(await navAutomation2.hasPendingNav()).to.equal(false);
    });

    it("checkUpkeep returns false when epoch has not elapsed", async () => {
        await mintAndDepositIntoTranche(oracle, to6(100n));

        // Queue a 2-day epoch duration (applied on next epoch advance)
        await vault.connect(deployer).setEpochConfig(2 * DAY);

        // Advance epoch to apply the queued duration: submit zero-yield, wait veto, perform
        let totalSupplyMZ = await mzusd.totalSupply();
        let totalSupplyUSDC = totalSupplyMZ / SCALE;
        await pushOracleAnswers(totalSupplyUSDC, totalSupplyMZ);
        await navAutomation.connect(oracle).submitNav();
        await time.increase(DAY);
        await navAutomation.connect(chainlinkAutomation).performUpkeep("0x"); // epoch advances, epochDuration = 2 days

        // Submit a new yield NAV
        totalSupplyMZ = await mzusd.totalSupply();
        totalSupplyUSDC = totalSupplyMZ / SCALE;
        await pushOracleAnswers(totalSupplyUSDC + to6(5n), totalSupplyMZ);
        await navAutomation.connect(oracle).submitNav();

        // 1 day later: veto elapsed, but epoch (2 days) has not
        await time.increase(DAY);
        const [needed] = await navAutomation.checkUpkeep("0x");
        expect(needed).to.equal(false);

        // 1 more day: epoch also elapsed
        await time.increase(DAY);
        const [neededAfter] = await navAutomation.checkUpkeep("0x");
        expect(neededAfter).to.equal(true);
    });

    it("checkUpkeep returns false when no tranches registered (yield)", async () => {
        // Deploy a fresh vault with no tranches
        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        const vaultNoTranches = (await upgrades.deployProxy(
            VaultFactory,
            [0, bob.address, 0, oracle.address],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [mzusd.target, reservoir.target],
            }
        )) as unknown as IssuanceVault;

        const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
        const lm2 = (await upgrades.deployProxy(LossManagerFactory, [0], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vaultNoTranches.target],
        })) as unknown as LossManager;

        const NavAutomationFactory = await ethers.getContractFactory(
            "NavOracleAutomation",
            deployer
        );
        const navAuto2 = (await NavAutomationFactory.deploy(
            lm2.target,
            DAY
        )) as unknown as NavOracleAutomation;

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const submitSelector = navAuto2.interface.getFunction("submitNav").selector;
        const setOraclesSelector = navAuto2.interface.getFunction("setOracles").selector;
        await accessManager.setTargetFunctionRole(navAuto2.target, [submitSelector], ORACLE_ROLE);
        await accessManager.setTargetFunctionRole(
            navAuto2.target,
            [setOraclesSelector],
            ADMIN_ROLE
        );
        await navAuto2
            .connect(deployer)
            .setOracles(navFeedOracle.target, totalSupplyFeedOracle.target);

        // Push yield scenario (navUSDC > totalSupplyUSDC → isYield=true)
        await pushOracleAnswers(to6(100n), to18(50n));
        await navAuto2.connect(oracle).submitNav();

        await time.increase(DAY);

        const [upkeepNeeded] = await navAuto2.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(false);
    });

    it("checkUpkeep returns false when loss exceeds maxLossPerTxUSDC", async () => {
        await mintAndDepositIntoTranche(oracle, to6(100n));

        // Cap loss at 5 USDC
        await lossManager.connect(deployer).setMaxLossPerTxUSDC(to6(5n));

        // Submit a 20 USDC loss (exceeds the 5 USDC cap)
        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / SCALE;
        const navUSDC = totalSupplyUSDC - to6(20n);
        await pushOracleAnswers(navUSDC, totalSupplyMZ);
        await navAutomation.connect(oracle).submitNav();

        await time.increase(DAY);

        const [upkeepNeeded] = await navAutomation.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(false);
    });
});
