import {expect} from "chai";
import {ethers, upgrades, network} from "hardhat";
import {takeSnapshot} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

import {PauseManager, PauseManagedMock} from "../typechain-types";

const Category = {
    DEPOSITS: 0,
    WITHDRAWALS: 1,
    TRANSFERS: 2,
    ADMIN: 3,
    PROTOCOL: 4,
} as const;

describe("PauseManager", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let mockA: PauseManagedMock;
    let mockB: PauseManagedMock;

    before(async () => {
        [deployer, alice] = await ethers.getSigners();
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
        const pauseGlobalSelector = pauseManager.interface.getFunction("pauseGlobal").selector;
        const unpauseGlobalSelector = pauseManager.interface.getFunction("unpauseGlobal").selector;
        const pauseContractSelector = pauseManager.interface.getFunction("pauseContract").selector;
        const unpauseContractSelector =
            pauseManager.interface.getFunction("unpauseContract").selector;
        const upgradeSelector = pauseManager.interface.getFunction("upgradeToAndCall").selector;

        await accessManager.setTargetFunctionRole(
            pauseManager.target,
            [
                pauseGlobalSelector,
                unpauseGlobalSelector,
                pauseContractSelector,
                unpauseContractSelector,
                upgradeSelector,
            ],
            ADMIN_ROLE
        );

        const MockFactory = await ethers.getContractFactory("PauseManagedMock", deployer);
        mockA = (await upgrades.deployProxy(MockFactory, [pauseManager.target], {
            kind: "uups",
            initializer: "initialize",
        })) as unknown as PauseManagedMock;

        mockB = (await upgrades.deployProxy(MockFactory, [pauseManager.target], {
            kind: "uups",
            initializer: "initialize",
        })) as unknown as PauseManagedMock;

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    it("Allows actions by default", async () => {
        await mockA.deposit();
        await mockA.withdraw();
        await mockA.transferAction();
        await mockA.adminAction();
        await mockA.protocolAction();

        expect(await mockA.deposits()).to.equal(1n);
        expect(await mockA.withdrawals()).to.equal(1n);
        expect(await mockA.transfers()).to.equal(1n);
        expect(await mockA.adminOps()).to.equal(1n);
        expect(await mockA.protocolOps()).to.equal(1n);
    });

    it("Exposes the pause manager address", async () => {
        expect(await mockA.pauseManager()).to.equal(pauseManager.target);
    });

    it("Blocks a category globally", async () => {
        await pauseManager.pauseGlobal(Category.DEPOSITS);

        await expect(mockA.deposit())
            .to.be.revertedWithCustomError(mockA, "CategoryPaused")
            .withArgs(Category.DEPOSITS);
        await expect(mockB.deposit())
            .to.be.revertedWithCustomError(mockB, "CategoryPaused")
            .withArgs(Category.DEPOSITS);

        expect(await pauseManager.globalPaused(Category.DEPOSITS)).to.equal(true);
        expect(await pauseManager.isPaused(mockA.target, Category.DEPOSITS)).to.equal(true);
    });

    it("Blocks protocol category actions", async () => {
        await pauseManager.pauseGlobal(Category.PROTOCOL);
        await expect(mockA.protocolAction())
            .to.be.revertedWithCustomError(mockA, "CategoryPaused")
            .withArgs(Category.PROTOCOL);
    });

    it("Blocks a category for a single contract", async () => {
        await pauseManager.pauseContract(mockA.target, Category.WITHDRAWALS);

        await expect(mockA.withdraw())
            .to.be.revertedWithCustomError(mockA, "CategoryPaused")
            .withArgs(Category.WITHDRAWALS);
        await expect(mockB.withdraw()).to.not.be.reverted;

        expect(await pauseManager.contractPaused(mockA.target, Category.WITHDRAWALS)).to.equal(
            true
        );
        expect(await pauseManager.isPaused(mockA.target, Category.WITHDRAWALS)).to.equal(true);
    });

    it("Unpauses a category for a single contract", async () => {
        await pauseManager.pauseContract(mockA.target, Category.ADMIN);
        await expect(mockA.adminAction())
            .to.be.revertedWithCustomError(mockA, "CategoryPaused")
            .withArgs(Category.ADMIN);

        await pauseManager.unpauseContract(mockA.target, Category.ADMIN);
        await expect(mockA.adminAction()).to.not.be.reverted;
        expect(await mockA.adminOps()).to.equal(1n);
    });

    it("Unpauses a category", async () => {
        await pauseManager.pauseGlobal(Category.TRANSFERS);
        await expect(mockA.transferAction())
            .to.be.revertedWithCustomError(mockA, "CategoryPaused")
            .withArgs(Category.TRANSFERS);

        await pauseManager.unpauseGlobal(Category.TRANSFERS);
        await expect(mockA.transferAction()).to.not.be.reverted;
        expect(await mockA.transfers()).to.equal(1n);
    });

    it("Reverts on zero address PauseManager initialization", async () => {
        const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
        const rawManager = await PauseManagerFactory.deploy();
        await rawManager.waitForDeployment();
        await expect(rawManager.initialize(ethers.ZeroAddress)).to.be.revertedWithCustomError(
            rawManager,
            "ZeroAddress"
        );
    });

    it("Rejects re-initialization of PauseManager", async () => {
        const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
        const rawManager = await PauseManagerFactory.deploy();
        await rawManager.waitForDeployment();
        await rawManager.initialize(accessManager.target);
        await expect(rawManager.initialize(accessManager.target)).to.be.reverted;
    });

    it("Reverts on zero address PauseManaged initialization", async () => {
        const MockFactory = await ethers.getContractFactory("PauseManagedMock", deployer);
        const rawMock = await MockFactory.deploy();
        await rawMock.waitForDeployment();
        await expect(rawMock.initialize(ethers.ZeroAddress)).to.be.revertedWithCustomError(
            rawMock,
            "ZeroAddress"
        );
    });

    it("Rejects re-initialization of PauseManagedMock", async () => {
        await expect(mockA.initialize(pauseManager.target)).to.be.reverted;
    });

    it("Rejects direct call to PauseManaged initializer outside init flow", async () => {
        await expect(mockA.forcePauseManagerInit(pauseManager.target)).to.be.reverted;
    });

    it("Rejects unauthorized PauseManager upgrade", async () => {
        const PauseManagerV2Factory = await ethers.getContractFactory("PauseManagerV2", deployer);
        const v2Impl = await PauseManagerV2Factory.deploy();
        await v2Impl.waitForDeployment();

        await expect(pauseManager.connect(alice).upgradeToAndCall(await v2Impl.getAddress(), "0x"))
            .to.be.reverted;
    });

    it("Allows upgrading PauseManager via AccessManager", async () => {
        const PauseManagerV2Factory = await ethers.getContractFactory("PauseManagerV2", deployer);
        const v2Impl = await PauseManagerV2Factory.deploy();
        await v2Impl.waitForDeployment();

        await pauseManager.upgradeToAndCall(await v2Impl.getAddress(), "0x");

        const pauseManagerV2 = await ethers.getContractAt(
            "PauseManagerV2",
            pauseManager.target,
            deployer
        );
        expect(await pauseManagerV2.version()).to.equal(2n);
    });

    it("Rejects zero address on contract pause", async () => {
        await expect(
            pauseManager.pauseContract(ethers.ZeroAddress, Category.ADMIN)
        ).to.be.revertedWithCustomError(pauseManager, "ZeroAddress");
        await expect(
            pauseManager.unpauseContract(ethers.ZeroAddress, Category.ADMIN)
        ).to.be.revertedWithCustomError(pauseManager, "ZeroAddress");
    });

    it("Rejects unauthorized pause attempts", async () => {
        await expect(pauseManager.connect(alice).pauseGlobal(Category.ADMIN)).to.be.reverted;
        await expect(pauseManager.connect(alice).unpauseGlobal(Category.ADMIN)).to.be.reverted;
        await expect(pauseManager.connect(alice).pauseContract(mockA.target, Category.ADMIN)).to.be
            .reverted;
        await expect(pauseManager.connect(alice).unpauseContract(mockA.target, Category.ADMIN)).to
            .be.reverted;
    });
});
