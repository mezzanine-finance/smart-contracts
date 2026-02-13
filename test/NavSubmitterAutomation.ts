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
    MockNavSubmitterAutomation,
    MZUSD,
    NavOracleAutomation,
    ReservoirUSDC,
    Tranche,
    Vault,
    PauseManager,
} from "../typechain-types";
import {grantPausePermissions} from "./helpers/pause";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

const DAY = 24 * 60 * 60;
const ORACLE_ROLE = 6n;
const LOSS_MANAGER_ROLE = 3n;
const BURNER_ROLE = 5n;

const to6 = (value: string | number | bigint) => parseUnits(value.toString(), 6);
const to18 = (value: string | number | bigint) => parseUnits(value.toString(), 18);

async function imp(addr: string) {
    await setBalance(addr, to18(10));
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("NavSubmitterAutomation", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
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
    let submitter: MockNavSubmitterAutomation;
    let whale: any;

    before(async () => {
        [deployer, bob] = await ethers.getSigners();

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
            [accessManager.target, pauseManager.target, usdcTotalSupply],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, bob.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        })) as unknown as Vault;

        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        tranche = (await upgrades.deployProxy(TrancheFactory, [1, 0, "Senior Tranche", "sMZUSD"], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target, false],
        })) as unknown as Tranche;

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
            0
        )) as unknown as NavOracleAutomation;
        await navAutomation.waitForDeployment();

        const SubmitterFactory = await ethers.getContractFactory(
            "MockNavSubmitterAutomation",
            deployer
        );
        submitter = (await SubmitterFactory.deploy(
            vault.target
        )) as unknown as MockNavSubmitterAutomation;
        await submitter.waitForDeployment();

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();

        const setVaultSelector = mzusd.interface.getFunction("setVault").selector;
        const burnSelector = mzusd.interface.getFunction("burn").selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSelector], ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(mzusd.target, [burnSelector], BURNER_ROLE);
        await mzusd.setVault(vault.target);
        await accessManager.grantRole(BURNER_ROLE, tranche.target as string, 0);
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSelector = vault.interface.getFunction("registerTranche").selector;
        const advanceEpochSelector = vault.interface.getFunction("advanceEpoch").selector;
        const setVaultLossManagerSelector = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSelector = vault.interface.getFunction("setNavOracle").selector;
        await accessManager.setTargetFunctionRole(
            vault.target,
            [
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

        await accessManager.grantRole(LOSS_MANAGER_ROLE, lossManager.target as string, 0);

        const applyLossSelector = lossManager.interface.getFunction("applyLoss").selector;
        await accessManager.setTargetFunctionRole(
            lossManager.target,
            [applyLossSelector],
            ADMIN_ROLE
        );

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
        await accessManager.grantRole(ORACLE_ROLE, submitter.target as string, 0);
        await accessManager.grantRole(ADMIN_ROLE, navAutomation.target as string, 0);

        await vault.setLossManager(lossManager.target);
        await vault.setNavOracle(navAutomation.target);

        await vault.registerTranche(tranche);
        await vault.setTrancheConfig(
            [{tranche: tranche, riskPremiumBps: 3000, enabled: true}],
            [false],
            7000
        );

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function mintAndDepositIntoTranche(user: any, usdcAmount6: bigint) {
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusd.target, usdcAmount6);
        await (await mzusd.connect(user).deposit(usdcAmount6)).wait();

        const mintedMZ = await mzusd.balanceOf(user.address);
        await mzusd.connect(user).approve(tranche.target, mintedMZ);
        await (await tranche.connect(user).deposit(mintedMZ, user.address)).wait();
    }

    it("submits nav via Chainlink-style upkeep", async () => {
        await mintAndDepositIntoTranche(deployer, to6(100n));
        await time.increase(DAY);

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / 10n ** 12n;
        const premiumBps = await submitter.PREMIUM_BPS();
        const bps = await submitter.BPS();
        const expectedDelta = (totalSupplyUSDC * premiumBps + (bps - 1n)) / bps;

        const [needed] = await submitter.checkUpkeep("0x");
        expect(needed).to.equal(true);

        const epochBefore = await vault.currentEpochId();
        await expect(submitter.performUpkeep("0x"))
            .to.emit(submitter, "NavSubmittedByAutomation")
            .withArgs(
                totalSupplyUSDC,
                totalSupplyUSDC + expectedDelta,
                expectedDelta,
                navAutomation.target
            );

        const epochAfter = await vault.currentEpochId();
        expect(epochAfter).to.equal(epochBefore + 1n);
        expect(await navAutomation.hasPendingNav()).to.equal(false);

        const [neededAfter] = await submitter.checkUpkeep("0x");
        expect(neededAfter).to.equal(false);
    });

    it("returns no work before epoch is ready", async () => {
        await mintAndDepositIntoTranche(deployer, to6(100n));

        const [needed] = await submitter.checkUpkeep("0x");
        expect(needed).to.equal(false);

        await expect(submitter.performUpkeep("0x")).to.be.revertedWithCustomError(
            submitter,
            "NoWork"
        );
    });

    it("returns no work when MZUSD totalSupply is zero", async () => {
        const totalSupply = await mzusd.totalSupply();
        expect(totalSupply).to.equal(0n);

        await time.increase(DAY);

        const [needed] = await submitter.checkUpkeep("0x");
        expect(needed).to.equal(false);

        await expect(submitter.performUpkeep("0x")).to.be.revertedWithCustomError(
            submitter,
            "NoWork"
        );
    });

    it("does not submit when NavOracle has pending NAV", async () => {
        await navAutomation.connect(deployer).setVetoPeriod(DAY);
        await mintAndDepositIntoTranche(deployer, to6(100n));
        await time.increase(DAY);

        await submitter.performUpkeep("0x");
        expect(await navAutomation.hasPendingNav()).to.equal(true);

        const [needed] = await submitter.checkUpkeep("0x");
        expect(needed).to.equal(false);

        await expect(submitter.performUpkeep("0x")).to.be.revertedWithCustomError(
            submitter,
            "NoWork"
        );
    });

    it("previewNextNav matches checkUpkeep readiness and nav math", async () => {
        await mintAndDepositIntoTranche(deployer, to6(100n));
        await time.increase(DAY);

        const totalSupplyMZ = await mzusd.totalSupply();
        const totalSupplyUSDC = totalSupplyMZ / 10n ** 12n;
        const premiumBps = await submitter.PREMIUM_BPS();
        const bps = await submitter.BPS();
        const expectedDelta = (totalSupplyUSDC * premiumBps + (bps - 1n)) / bps;
        const expectedNav = totalSupplyUSDC + expectedDelta;

        const [canSubmit, navUSDC] = await submitter.previewNextNav();
        expect(canSubmit).to.equal(true);
        expect(navUSDC).to.equal(expectedNav);

        const [needed, performData] = await submitter.checkUpkeep("0x");
        expect(needed).to.equal(true);

        const decodedNav = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], performData)[0];
        expect(decodedNav).to.equal(expectedNav);
    });
});
