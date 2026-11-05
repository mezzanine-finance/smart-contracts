import {expect} from "chai";
import {ethers} from "hardhat";
import type {AllowlistStub} from "../typechain-types";

describe("AllowlistStub", () => {
    let allowlist: AllowlistStub;

    before(async () => {
        const factory = await ethers.getContractFactory("AllowlistStub");
        allowlist = (await factory.deploy()) as AllowlistStub;
        await allowlist.waitForDeployment();
    });

    it("accepts every account", async () => {
        const [, account] = await ethers.getSigners();

        expect(await allowlist.verifyAccount(account.address)).to.equal(true);
        expect(await allowlist.verifyAccount(ethers.ZeroAddress)).to.equal(true);
    });
});
