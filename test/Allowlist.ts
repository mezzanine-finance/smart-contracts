import {expect} from "chai";
import {ethers, upgrades} from "hardhat";
import {takeSnapshot} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";
import {Allowlist, MockSanctionsList} from "../typechain-types";

describe("Allowlist", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;
    let unauthorized: any;

    let accessManager: any;
    let sanctionsList: MockSanctionsList;
    let allowlist: Allowlist;

    before(async () => {
        [deployer, alice, bob, carol, unauthorized] = await ethers.getSigners();
        upgrades.silenceWarnings();

        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        accessManager = await AccessManagerFactory.deploy(deployer.address);
        await accessManager.waitForDeployment();

        const SanctionsListFactory = await ethers.getContractFactory("MockSanctionsList", deployer);
        sanctionsList = (await SanctionsListFactory.deploy()) as unknown as MockSanctionsList;

        const AllowlistFactory = await ethers.getContractFactory("Allowlist", deployer);
        allowlist = (await upgrades.deployProxy(
            AllowlistFactory,
            [accessManager.target, sanctionsList.target],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as Allowlist;

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    describe("initialize", () => {
        it("reverts when sanctionsList is zero address", async () => {
            const AllowlistFactory = await ethers.getContractFactory("Allowlist", deployer);
            await expect(
                upgrades.deployProxy(AllowlistFactory, [accessManager.target, ethers.ZeroAddress], {
                    kind: "uups",
                    initializer: "initialize",
                    unsafeAllow: ["constructor"],
                })
            ).to.be.revertedWithCustomError(allowlist, "ZeroAddress");
        });
    });

    describe("add", () => {
        it("adds an account to the allowlist", async () => {
            await expect(allowlist.add(alice.address))
                .to.emit(allowlist, "AddedToAllowlist")
                .withArgs(alice.address);
            expect(await allowlist.isAllowlisted(alice.address)).to.equal(true);
        });

        it("reverts when account is already allowlisted", async () => {
            await allowlist.add(alice.address);
            await expect(allowlist.add(alice.address))
                .to.be.revertedWithCustomError(allowlist, "AlreadyAllowlisted")
                .withArgs(alice.address);
        });

        it("reverts when account is zero address", async () => {
            await expect(allowlist.add(ethers.ZeroAddress)).to.be.revertedWithCustomError(
                allowlist,
                "ZeroAddress"
            );
        });

        it("reverts when caller is not authorized", async () => {
            await expect(allowlist.connect(unauthorized).add(alice.address)).to.be.reverted;
        });
    });

    describe("remove", () => {
        it("removes an account from the allowlist", async () => {
            await allowlist.add(alice.address);
            await expect(allowlist.remove(alice.address))
                .to.emit(allowlist, "RemovedFromAllowlist")
                .withArgs(alice.address);
            expect(await allowlist.isAllowlisted(alice.address)).to.equal(false);
        });

        it("reverts when account is not allowlisted", async () => {
            await expect(allowlist.remove(alice.address))
                .to.be.revertedWithCustomError(allowlist, "NotAllowlisted")
                .withArgs(alice.address);
        });

        it("reverts when caller is not authorized", async () => {
            await allowlist.add(alice.address);
            await expect(allowlist.connect(unauthorized).remove(alice.address)).to.be.reverted;
        });
    });

    describe("addBatch", () => {
        it("adds multiple accounts to the allowlist", async () => {
            const tx = allowlist.addBatch([alice.address, bob.address, carol.address]);
            await expect(tx).to.emit(allowlist, "AddedToAllowlist").withArgs(alice.address);
            await expect(tx).to.emit(allowlist, "AddedToAllowlist").withArgs(bob.address);
            await expect(tx).to.emit(allowlist, "AddedToAllowlist").withArgs(carol.address);
            expect(await allowlist.isAllowlisted(alice.address)).to.equal(true);
            expect(await allowlist.isAllowlisted(bob.address)).to.equal(true);
            expect(await allowlist.isAllowlisted(carol.address)).to.equal(true);
        });

        it("reverts when any account is already allowlisted", async () => {
            await allowlist.add(bob.address);
            await expect(allowlist.addBatch([alice.address, bob.address]))
                .to.be.revertedWithCustomError(allowlist, "AlreadyAllowlisted")
                .withArgs(bob.address);
        });

        it("reverts when any account is zero address", async () => {
            await expect(
                allowlist.addBatch([alice.address, ethers.ZeroAddress])
            ).to.be.revertedWithCustomError(allowlist, "ZeroAddress");
        });

        it("reverts when caller is not authorized", async () => {
            await expect(allowlist.connect(unauthorized).addBatch([alice.address, bob.address])).to
                .be.reverted;
        });
    });

    describe("removeBatch", () => {
        it("removes multiple accounts from the allowlist", async () => {
            await allowlist.addBatch([alice.address, bob.address, carol.address]);
            const tx = await allowlist.removeBatch([alice.address, carol.address]);
            await expect(tx).to.emit(allowlist, "RemovedFromAllowlist").withArgs(alice.address);
            await expect(tx).to.emit(allowlist, "RemovedFromAllowlist").withArgs(carol.address);
            expect(await allowlist.isAllowlisted(alice.address)).to.equal(false);
            expect(await allowlist.isAllowlisted(bob.address)).to.equal(true);
            expect(await allowlist.isAllowlisted(carol.address)).to.equal(false);
        });

        it("reverts when any account is not allowlisted", async () => {
            await allowlist.add(alice.address);
            await expect(allowlist.removeBatch([alice.address, bob.address]))
                .to.be.revertedWithCustomError(allowlist, "NotAllowlisted")
                .withArgs(bob.address);
        });

        it("reverts when caller is not authorized", async () => {
            await allowlist.addBatch([alice.address, bob.address]);
            await expect(allowlist.connect(unauthorized).removeBatch([alice.address, bob.address]))
                .to.be.reverted;
        });
    });

    describe("verifyAccount", () => {
        it("returns true when account is allowlisted and not sanctioned", async () => {
            await allowlist.add(alice.address);
            expect(await allowlist.verifyAccount(alice.address)).to.equal(true);
        });

        it("returns false when account is not allowlisted", async () => {
            expect(await allowlist.verifyAccount(alice.address)).to.equal(false);
        });

        it("returns false when account is allowlisted but sanctioned", async () => {
            await allowlist.add(alice.address);
            await sanctionsList.add(alice.address);
            expect(await allowlist.verifyAccount(alice.address)).to.equal(false);
        });
    });
});
