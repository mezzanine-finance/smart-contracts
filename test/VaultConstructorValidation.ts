import {expect} from "chai";
import {ethers, upgrades} from "hardhat";

import {PauseManager, ReservoirUSDC, IssuanceVault} from "../typechain-types";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

describe("IssuanceVault constructor and initializer validation", () => {
    let deployer: any;
    let bob: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let reservoir: ReservoirUSDC;

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
    });

    async function deployMockMZUSD(
        usdcAddr: string,
        vaultAddr: string,
        decimals: number,
        authority: string = accessManager.target as string,
        pauseManagerAddress: string = pauseManager.target as string
    ) {
        const MockFactory = await ethers.getContractFactory("MockMZUSD", deployer);
        const mock = await MockFactory.deploy(
            usdcAddr,
            vaultAddr,
            decimals,
            authority,
            pauseManagerAddress
        );
        await mock.waitForDeployment();
        return mock;
    }

    async function deployVaultWithConstructor(mzusdAddr: string, reservoirAddr: string) {
        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        return (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, bob.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusdAddr, reservoirAddr],
        })) as unknown as IssuanceVault;
    }

    it("reverts when MZUSD address is zero", async () => {
        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        await expect(
            deployVaultWithConstructor(ethers.ZeroAddress, reservoir.target as string)
        ).to.be.revertedWithCustomError(VaultFactory, "ZeroAddress");
    });

    it("reverts when Reservoir address is zero", async () => {
        const mock = await deployMockMZUSD(MAINNET_USDC, bob.address, 18);
        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        await expect(
            deployVaultWithConstructor(mock.target as string, ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(VaultFactory, "ZeroAddress");
    });

    it("reverts when MZUSD decimals are not 18", async () => {
        const mock = await deployMockMZUSD(MAINNET_USDC, bob.address, 6);

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        await expect(deployVaultWithConstructor(mock.target as string, reservoir.target as string))
            .to.be.revertedWithCustomError(VaultFactory, "InvalidMZUSDDecimals")
            .withArgs(6);
    });

    it("reverts when MZUSD usdc is zero", async () => {
        const mock = await deployMockMZUSD(ethers.ZeroAddress, bob.address, 18);

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        await expect(deployVaultWithConstructor(mock.target as string, reservoir.target as string))
            .to.be.revertedWithCustomError(VaultFactory, "InvalidMZUSDUSDC")
            .withArgs(ethers.ZeroAddress);
    });

    it("reverts when Reservoir USDC mismatches MZUSD USDC", async () => {
        const mock = await deployMockMZUSD(bob.address, bob.address, 18);

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        await expect(deployVaultWithConstructor(mock.target as string, reservoir.target as string))
            .to.be.revertedWithCustomError(VaultFactory, "InvalidReservoirUSDC")
            .withArgs(MAINNET_USDC);
    });

    it("deploys successfully with valid constructor arguments", async () => {
        const mock = await deployMockMZUSD(MAINNET_USDC, bob.address, 18);
        const vault = await deployVaultWithConstructor(
            mock.target as string,
            reservoir.target as string
        );

        expect(await vault.mzusd()).to.equal(mock.target);
        expect(await vault.usdc()).to.equal(MAINNET_USDC);
        expect(await vault.reservoir()).to.equal(reservoir.target);
    });

    it("reverts when MZUSD access manager is zero", async () => {
        const mock = await deployMockMZUSD(
            MAINNET_USDC,
            bob.address,
            18,
            ethers.ZeroAddress,
            pauseManager.target as string
        );

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        await expect(deployVaultWithConstructor(mock.target as string, reservoir.target as string))
            .to.be.revertedWithCustomError(VaultFactory, "InvalidMZUSDAccessManager")
            .withArgs(ethers.ZeroAddress);
    });

    it("reverts when MZUSD pause manager is zero", async () => {
        const mock = await deployMockMZUSD(
            MAINNET_USDC,
            bob.address,
            18,
            accessManager.target as string,
            ethers.ZeroAddress
        );

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        await expect(deployVaultWithConstructor(mock.target as string, reservoir.target as string))
            .to.be.revertedWithCustomError(VaultFactory, "InvalidMZUSDPauseManager")
            .withArgs(ethers.ZeroAddress);
    });

    it("reverts when Reservoir access manager mismatches MZUSD access manager", async () => {
        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        const altAccessManager = await AccessManagerFactory.deploy(deployer.address);
        await altAccessManager.waitForDeployment();

        const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
        const altPauseManager = (await upgrades.deployProxy(
            PauseManagerFactory,
            [altAccessManager.target],
            {
                kind: "uups",
                initializer: "initialize",
            }
        )) as unknown as PauseManager;

        const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
        const altReservoir = (await upgrades.deployProxy(
            ReservoirFactory,
            [altAccessManager.target, altPauseManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as ReservoirUSDC;

        const mock = await deployMockMZUSD(MAINNET_USDC, bob.address, 18);
        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        await expect(
            deployVaultWithConstructor(mock.target as string, altReservoir.target as string)
        )
            .to.be.revertedWithCustomError(VaultFactory, "InvalidReservoirAccessManager")
            .withArgs(altAccessManager.target);
    });

    it("reverts when Reservoir pause manager mismatches MZUSD pause manager", async () => {
        const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
        const altPauseManager = (await upgrades.deployProxy(
            PauseManagerFactory,
            [accessManager.target],
            {
                kind: "uups",
                initializer: "initialize",
            }
        )) as unknown as PauseManager;

        const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
        const altReservoir = (await upgrades.deployProxy(
            ReservoirFactory,
            [accessManager.target, altPauseManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as ReservoirUSDC;

        const mock = await deployMockMZUSD(MAINNET_USDC, bob.address, 18);
        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        await expect(
            deployVaultWithConstructor(mock.target as string, altReservoir.target as string)
        )
            .to.be.revertedWithCustomError(VaultFactory, "InvalidReservoirPauseManager")
            .withArgs(altPauseManager.target);
    });
});
