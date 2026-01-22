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
    Vault,
    PauseManager,
} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";
const VAULT_ROLE = 2n;

const DAY = 24 * 60 * 60;
const to6 = (value: string | number | bigint) => parseUnits(value.toString(), 6);
const to18 = (value: string | number | bigint) => parseUnits(value.toString(), 18);

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

    let accessManager: any;
    let pauseManager: PauseManager;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;
    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;
    let tranche: Tranche;
    let whale: any;

    let ADMIN_ROLE: bigint;

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
            [
                reservoir.target,
                accessManager.target,
                pauseManager.target,
                0,
                bob.address,
                0,
                alice.address,
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as Vault;

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                pauseManager.target,
                usdcTotalSupply, // _hourlyLimitUSDC (max allowed)
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

        ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // Admin-only functions on MZUSD & Vault
        const setMZUSDSelector = vault.interface.getFunction("setMZUSD").selector;
        const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSelector = vault.interface.getFunction("addTranche").selector;
        const setLossManagerSelector = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSelector = vault.interface.getFunction("setNavOracle").selector;

        await accessManager.setTargetFunctionRole(
            vault.target,
            [
                setMZUSDSelector,
                distributeYieldSelector,
                addTrancheSelector,
                setLossManagerSelector,
                setNavOracleSelector,
            ],
            ADMIN_ROLE
        );

        // Admin-only tranche functions used in tests
        const trancheDelaySelector =
            tranche.interface.getFunction("setUnstakeDelayEpochs").selector;
        await accessManager.setTargetFunctionRole(
            tranche.target,
            [trancheDelaySelector],
            ADMIN_ROLE
        );

        // Vault role allowed to push yield to tranches
        const notifySelector = tranche.interface.getFunction("notifyYield").selector;
        await accessManager.setTargetFunctionRole(tranche.target, [notifySelector], VAULT_ROLE);

        await accessManager.grantRole(
            VAULT_ROLE,
            vault.target,
            0 // executionDelay
        );

        // Wire Vault to MZUSD and register tranche in Vault (after roles are configured)
        await vault.setMZUSD(mzusd.target);
        await vault.setLossManager(deployer.address);
        await vault.setNavOracle(deployer.address);

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
        const shares = await tranche.balanceOf(user.address);
        return {mintedMZ, shares};
    }

    async function advanceEpoch(usdcReported: bigint = to6(1n)) {
        await time.increase(DAY);
        await (await vault.connect(deployer).distributeYield(usdcReported)).wait();
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

    it("checkUpkeep returns false for epoch 0 when nothing is pending", async () => {
        const currentEpoch = await vault.currentEpochId();
        expect(currentEpoch).to.equal(1n);

        const Finalizer = await ethers.getContractFactory("UmbrellaEpochFinalizer", deployer);
        const finalizer = (await Finalizer.deploy(
            tranche.target
        )) as unknown as UmbrellaEpochFinalizer;
        await finalizer.waitForDeployment();

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(false);
        expect(performData).to.equal("0x");
    });

    it("checkUpkeep returns false when there is no work", async () => {
        await mintAndDepositIntoTranche(alice, to6(1n));
        await advanceEpoch();

        const Finalizer = await ethers.getContractFactory("UmbrellaEpochFinalizer", deployer);
        const finalizer = (await Finalizer.deploy(
            tranche.target
        )) as unknown as UmbrellaEpochFinalizer;
        await finalizer.waitForDeployment();

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(false);
        expect(performData).to.equal("0x");
    });

    it("performUpkeep reverts when protocol is paused", async () => {
        await preparePendingEpoch(alice);

        const Finalizer = await ethers.getContractFactory("UmbrellaEpochFinalizer", deployer);
        const finalizer = (await Finalizer.deploy(
            tranche.target
        )) as unknown as UmbrellaEpochFinalizer;
        await finalizer.waitForDeployment();

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);

        await expect(finalizer.performUpkeep(performData))
            .to.be.revertedWithCustomError(tranche, "CategoryPaused")
            .withArgs(PauseCategory.PROTOCOL);
    });

    it("finalizes the previous epoch when work exists", async () => {
        const {shares, candidate} = await preparePendingEpoch(alice);

        const Finalizer = await ethers.getContractFactory("UmbrellaEpochFinalizer", deployer);
        const finalizer = (await Finalizer.deploy(
            tranche.target
        )) as unknown as UmbrellaEpochFinalizer;
        await finalizer.waitForDeployment();

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], performData);
        expect(decoded[0]).to.equal(candidate);

        await finalizer.connect(bob).performUpkeep(performData);

        const [totalShares, , isFinalized] = await tranche.finalizedEpochs(candidate);
        expect(isFinalized).to.equal(true);
        expect(totalShares).to.equal(shares);
        expect(await tranche.umbrellaSharesByEpoch(candidate)).to.equal(0n);
    });

    it("performUpkeep works without any role grants", async () => {
        const {candidate} = await preparePendingEpoch(alice);

        const Finalizer = await ethers.getContractFactory("UmbrellaEpochFinalizer", deployer);
        const finalizer = (await Finalizer.deploy(
            tranche.target
        )) as unknown as UmbrellaEpochFinalizer;
        await finalizer.waitForDeployment();

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        await finalizer.connect(bob).performUpkeep(performData);

        const [, , isFinalized] = await tranche.finalizedEpochs(candidate);
        expect(isFinalized).to.equal(true);
    });

    it("reverts on stale performData", async () => {
        await preparePendingEpoch(alice);

        const Finalizer = await ethers.getContractFactory("UmbrellaEpochFinalizer", deployer);
        const finalizer = (await Finalizer.deploy(
            tranche.target
        )) as unknown as UmbrellaEpochFinalizer;
        await finalizer.waitForDeployment();

        const [upkeepNeeded, performData] = await finalizer.checkUpkeep("0x");
        expect(upkeepNeeded).to.equal(true);

        await advanceEpoch();

        await expect(finalizer.performUpkeep(performData)).to.be.revertedWithCustomError(
            finalizer,
            "StaleEpoch"
        );
    });

    it("anyone can finalize directly", async () => {
        const {candidate} = await preparePendingEpoch(alice);

        await tranche.connect(bob).finalizeEpoch(candidate);

        const [, , isFinalized] = await tranche.finalizedEpochs(candidate);
        expect(isFinalized).to.equal(true);
        expect(await tranche.umbrellaSharesByEpoch(candidate)).to.equal(0n);
    });
});
