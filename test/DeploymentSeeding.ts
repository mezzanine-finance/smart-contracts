import {expect} from "chai";
import {ethers} from "hardhat";
import {getLatestDeployment, loadDeployments} from "../scripts/deployment/lib/deployments";

// Opt-in integration check: use a disposable DEPLOYMENTS_PATH and a local seed config.
// Never run against a live network or the repository's deployment records.
const seedTest = process.env.TEST_DEPLOYMENT_SEEDING === "true" ? describe : describe.skip;
seedTest("deployment initial seeding", function () {
    this.timeout(120000);
    it("funds a new vault once and sends no transactions on an unchanged rerun", async () => {
        const {network} = await import("hardhat");
        expect(network.name).to.equal("hardhat");
        expect(process.env.DEPLOYMENTS_PATH).to.match(/^\/tmp\//);
        expect(loadDeployments()).to.deep.equal({});
        process.env.DEPLOYMENT_SCRIPT_IMPORT = "true";
        const {main} = await import("../scripts/deployment/deploy");
        await main();
        const records = loadDeployments();
        const address = getLatestDeployment(records, "hardhat", "MZUSD", "seed-check")!.address;
        const token = await ethers.getContractAt("MZUSD", address);
        expect(await token.totalSupply()).to.equal(ethers.parseEther("1000"));
        const [signer] = await ethers.getSigners();
        const nonce = await signer.getNonce();
        await main();
        expect(await signer.getNonce()).to.equal(nonce);
        expect(await token.totalSupply()).to.equal(ethers.parseEther("1000"));
        expect(loadDeployments()).to.deep.equal(records);
    });
});
