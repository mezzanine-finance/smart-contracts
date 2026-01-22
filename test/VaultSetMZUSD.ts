import {expect} from "chai";
import {ethers, upgrades} from "hardhat";
import {takeSnapshot} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

import {PauseManager, ReservoirUSDC, Vault} from "../typechain-types";
import {grantPausePermissions} from "./helpers/pause";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

describe("Vault setMZUSD validation", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let bob: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let reservoir: ReservoirUSDC;
    let vault: Vault;

    before(async () => {
        [deployer, bob] = await ethers.getSigners();
        upgrades.silenceWarnings();

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
            [accessManager.target, pauseManager.target, 0, bob.address, 0, bob.address],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC, reservoir.target],
            }
        )) as unknown as Vault;

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const setMZUSDSelector = vault.interface.getFunction("setMZUSD").selector;
        await accessManager.setTargetFunctionRole(vault.target, [setMZUSDSelector], ADMIN_ROLE);
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function deployMockMZUSD(usdcAddr: string, vaultAddr: string, decimals: number) {
        const MockFactory = await ethers.getContractFactory("MockMZUSD", deployer);
        const mock = await MockFactory.deploy(usdcAddr, vaultAddr, decimals);
        await mock.waitForDeployment();
        return mock;
    }

    it("reverts when MZUSD decimals are not 18", async () => {
        const mock = await deployMockMZUSD(MAINNET_USDC, vault.target, 6);

        await expect(vault.connect(deployer).setMZUSD(mock.target))
            .to.be.revertedWithCustomError(vault, "InvalidMZUSDDecimals")
            .withArgs(6);
    });

    it("reverts when MZUSD usdc mismatches", async () => {
        const mock = await deployMockMZUSD(bob.address, vault.target, 18);

        await expect(vault.connect(deployer).setMZUSD(mock.target))
            .to.be.revertedWithCustomError(vault, "InvalidMZUSDUSDC")
            .withArgs(bob.address);
    });

    it("reverts when MZUSD vault mismatches", async () => {
        const mock = await deployMockMZUSD(MAINNET_USDC, bob.address, 18);

        await expect(vault.connect(deployer).setMZUSD(mock.target))
            .to.be.revertedWithCustomError(vault, "InvalidMZUSDVault")
            .withArgs(bob.address);
    });
});
