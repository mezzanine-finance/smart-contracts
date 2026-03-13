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
    MZUSD,
    ReservoirUSDC,
    Tranche,
    UmbrellaEpochFinalizer,
    IssuanceVault,
    PauseManager,
} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";
const DAY = 24 * 60 * 60;
const to6 = (value: string | number | bigint) => parseUnits(value.toString(), 6);
const to18 = (value: string | number | bigint) => parseUnits(value.toString(), 18);
const FINALIZER_ROLE = 8n;
const CHAINLINK_AUTOMATION = 9n;

async function imp(addr: string) {
    // Give the whale some ETH for gas
    await setBalance(addr, to18(10));
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("UmbrellaEpochFinalizer", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
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
    let whale: any;
    let lossManagerRef: any;
    let navOracleRef: any;
    let navOracleSigner: any;

    let ADMIN_ROLE: bigint;

    before(async () => {
        [deployer, alice, bob, chainlinkAutomation] = await ethers.getSigners();

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
            {kind: "uups", initializer: "initialize"}
        );
        await allowlist.addBatch([alice.address, bob.address]);

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
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, alice.address], {
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

        ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // Admin-only functions on MZUSD & IssuanceVault
        const setVaultSelector = mzusd.interface.getFunction("setVault").selector;
        const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSelector = vault.interface.getFunction("registerTranche").selector;
        const setYieldDistributionSelector =
            vault.interface.getFunction("setTrancheConfig").selector;
        const setLossManagerSelector = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSelector = vault.interface.getFunction("setNavOracle").selector;

        await accessManager.setTargetFunctionRole(
            vault.target,
            [
                distributeYieldSelector,
                addTrancheSelector,
                setYieldDistributionSelector,
                setLossManagerSelector,
                setNavOracleSelector,
            ],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSelector], ADMIN_ROLE);

        const finalizeEpochSel = tranche.interface.getFunction("finalizeEpoch").selector;
        await accessManager.setTargetFunctionRole(tranche, [finalizeEpochSel], FINALIZER_ROLE);
        await accessManager.grantRole(CHAINLINK_AUTOMATION, chainlinkAutomation, 0);

        // Admin-only tranche functions used in tests
        const trancheDelaySelector =
            tranche.interface.getFunction("setUnstakeDelayEpochs").selector;
        await accessManager.setTargetFunctionRole(
            tranche.target,
            [trancheDelaySelector],
            ADMIN_ROLE
        );

        // Wire IssuanceVault and register tranche (after roles are configured)
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
        const shares = await tranche.balanceOf(user.address);
        return {mintedMZ, shares};
    }

    async function advanceEpoch(usdcReported: bigint = to6(1n)) {
        await time.increase(DAY);
        await (await vault.connect(navOracleSigner).distributeYield(usdcReported)).wait();
    }

    async function preparePendingEpoch(user: any) {
        await tranche.connect(deployer).setUnstakeDelayEpochs(1n);
        const {shares} = await mintAndDepositIntoTranche(user, to6(100n));
        await (await tranche.connect(user).requestWithdrawal(shares)).wait();

        // currentEpochId starts at 1, so advance twice to make current-1 == targetEpoch
        await advanceEpoch();
        await advanceEpoch();

        const currentEpoch = await vault.currentEpochId();
        const candidate = currentEpoch - 1n;
        return {shares, candidate};
    }

    async function deployFinalizer(startEpoch = 1n): Promise<UmbrellaEpochFinalizer> {
        const Finalizer = await ethers.getContractFactory("UmbrellaEpochFinalizer", deployer);
        const finalizer = (await Finalizer.deploy(
            accessManager,
            tranche,
            startEpoch
        )) as unknown as UmbrellaEpochFinalizer;
        await finalizer.waitForDeployment();
        await accessManager.grantRole(FINALIZER_ROLE, finalizer, 0);

        const performUpkeepSel = finalizer.interface.getFunction("performUpkeep").selector;
        await accessManager.setTargetFunctionRole(
            finalizer,
            [performUpkeepSel],
            CHAINLINK_AUTOMATION
        );
        return finalizer;
    }

    it("constructor rejects zero tranche address", async () => {
        const Finalizer = await ethers.getContractFactory("UmbrellaEpochFinalizer", deployer);
        await expect(
            Finalizer.deploy(accessManager, ethers.ZeroAddress, 1n)
        ).to.be.revertedWithCustomError(Finalizer, "ZeroAddress");
    });

    it("constructor rejects startEpoch below MIN_EPOCH_ID", async () => {
        const Finalizer = await ethers.getContractFactory("UmbrellaEpochFinalizer", deployer);
        await expect(
            Finalizer.deploy(accessManager, tranche.target, 0n)
        ).to.be.revertedWithCustomError(Finalizer, "InvalidEpoch");
    });

    it("checkUpkeep returns false for epoch 0 when nothing is pending", async () => {
        const currentEpoch = await vault.currentEpochId();
        expect(currentEpoch).to.equal(1n);

        const finalizer = await deployFinalizer();

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(false);
        expect(performData).to.equal("0x");
    });

    it("checkUpkeep requests upkeep to advance cursor when window has no work", async () => {
        await mintAndDepositIntoTranche(alice, to6(1n));
        await advanceEpoch();

        const finalizer = await deployFinalizer();

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);
        expect(performData).to.equal("0x");

        await finalizer.connect(chainlinkAutomation).performUpkeep("0x");
        expect(await finalizer.nextEpochId()).to.equal(await vault.currentEpochId());

        const [upkeepNeededAfter, performDataAfter] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeededAfter).to.equal(false);
        expect(performDataAfter).to.equal("0x");
    });

    it("performUpkeep reverts when protocol is paused", async () => {
        const {candidate} = await preparePendingEpoch(alice);

        const finalizer = await deployFinalizer(candidate);

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);

        await expect(finalizer.connect(chainlinkAutomation).performUpkeep(performData))
            .to.be.revertedWithCustomError(tranche, "CategoryPaused")
            .withArgs(PauseCategory.PROTOCOL);
    });

    it("finalizes an eligible epoch when work exists", async () => {
        const {shares, candidate} = await preparePendingEpoch(alice);

        const finalizer = await deployFinalizer(candidate);

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);
        expect(performData).to.equal("0x");

        await finalizer.connect(chainlinkAutomation).performUpkeep(performData);

        const [totalShares] = await tranche.finalizedEpochs(candidate);
        expect(totalShares).to.equal(shares);
        expect(await tranche.umbrellaSharesByEpoch(candidate)).to.equal(0n);
    });

    it("performUpkeep works without any role grants", async () => {
        const {candidate} = await preparePendingEpoch(alice);

        const finalizer = await deployFinalizer(candidate);

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        await finalizer.connect(chainlinkAutomation).performUpkeep(performData);

        const [totalShares] = await tranche.finalizedEpochs(candidate);
        expect(totalShares).to.be.gt(0n);
    });

    it("performUpkeep reverts with InvalidState before first epoch advance", async () => {
        const finalizer = await deployFinalizer();
        await expect(
            finalizer.connect(chainlinkAutomation).performUpkeep("0x")
        ).to.be.revertedWithCustomError(finalizer, "InvalidState");
    });

    it("performUpkeep reverts with NoWork when cursor already caught up", async () => {
        await mintAndDepositIntoTranche(alice, to6(1n));
        await advanceEpoch();
        const currentEpoch = await vault.currentEpochId();
        const finalizer = await deployFinalizer(currentEpoch);

        await expect(
            finalizer.connect(chainlinkAutomation).performUpkeep("0x")
        ).to.be.revertedWithCustomError(finalizer, "NoWork");
    });

    it("ignores passed performData and uses on-chain cursor state", async () => {
        const {candidate} = await preparePendingEpoch(alice);

        const finalizer = await deployFinalizer(candidate);

        const [upkeepNeeded] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        const manipulatedData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [10_000n]);

        await finalizer.connect(chainlinkAutomation).performUpkeep(manipulatedData);

        // Work was finalized for current cursor epoch, not by manipulated calldata.
        const [totalShares] = await tranche.finalizedEpochs(candidate);
        expect(totalShares).to.be.gt(0n);
    });

    it("catches up missed epochs and finalizes the oldest pending first", async () => {
        await tranche.connect(deployer).setUnstakeDelayEpochs(1n);

        const {shares: shares1} = await mintAndDepositIntoTranche(alice, to6(100n));
        await (await tranche.connect(alice).requestWithdrawal(shares1)).wait();

        // epoch 1 -> 2
        await advanceEpoch();
        // epoch 2 -> 3 (epoch 2 becomes finalizable, intentionally skipped)
        await advanceEpoch();

        const {shares: shares2} = await mintAndDepositIntoTranche(bob, to6(50n));
        await (await tranche.connect(bob).requestWithdrawal(shares2)).wait();

        // epoch 3 -> 4
        await advanceEpoch();
        // epoch 4 -> 5 (epoch 4 becomes finalizable)
        await advanceEpoch();

        const finalizer = await deployFinalizer(2n);

        const [needed1, data1] = await finalizer.checkUpkeep("0x");
        expect(needed1).to.equal(true);
        expect(data1).to.equal("0x");

        await finalizer.connect(chainlinkAutomation).performUpkeep(data1);
        const [totalShares2] = await tranche.finalizedEpochs(2n);
        expect(totalShares2).to.equal(shares1);

        // Cursor now points to epoch 3 (no work), so one upkeep advances it to epoch 4.
        const [needed2, data2] = await finalizer.checkUpkeep("0x");
        expect(needed2).to.equal(true);
        expect(data2).to.equal("0x");
        await finalizer.connect(chainlinkAutomation).performUpkeep(data2);

        const [needed3, data3] = await finalizer.checkUpkeep("0x");
        expect(needed3).to.equal(true);
        expect(data3).to.equal("0x");
        await finalizer.connect(chainlinkAutomation).performUpkeep(data3);
        const [totalShares4] = await tranche.finalizedEpochs(4n);
        expect(totalShares4).to.equal(shares2);

        const [needed4, data4] = await finalizer.checkUpkeep("0x");
        expect(needed4).to.equal(false);
        expect(data4).to.equal("0x");
    });

    it("Finalization directly revert", async () => {
        const {candidate} = await preparePendingEpoch(alice);

        await expect(tranche.connect(bob).finalizeEpoch(candidate)).to.be.reverted;
    });

    it("allows setting deployment start cursor to skip older epochs", async () => {
        const {candidate} = await preparePendingEpoch(alice);
        const currentEpoch = await vault.currentEpochId();
        const finalizer = await deployFinalizer(currentEpoch);

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(false);
        expect(performData).to.equal("0x");

        // Older epoch remains untouched if start cursor is set after it.
        const [totalShares] = await tranche.finalizedEpochs(candidate);
        expect(totalShares).to.equal(0n);
    });
});
