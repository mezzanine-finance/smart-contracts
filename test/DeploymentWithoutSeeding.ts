import {expect} from "chai";
import fs from "fs";
import path from "path";
import {ethers, network} from "hardhat";

// Run separately so deployment modules use only this test's disposable records.
const deploymentTest =
    process.env.TEST_DEPLOYMENT_WITHOUT_SEEDING === "true" ? describe : describe.skip;

deploymentTest("deployment without seeding", function () {
    this.timeout(120000);

    it("saves a million-USDC buffer with empty balances and supports an unchanged rerun", async () => {
        expect(network.name).to.equal("hardhat");
        const directory = fs.mkdtempSync("/tmp/mezzanine-no-seed-");
        const previous = {
            DEPLOY_CONFIG: process.env.DEPLOY_CONFIG,
            DEPLOYMENTS_PATH: process.env.DEPLOYMENTS_PATH,
            DEPLOYMENT_SCRIPT_IMPORT: process.env.DEPLOYMENT_SCRIPT_IMPORT,
        };
        try {
            const config = JSON.parse(
                fs.readFileSync(path.resolve("scripts/deployment/config/hardhat.json"), "utf8")
            );
            delete config.seed;
            config.usdc.mock.initialMints = [];
            process.env.DEPLOY_CONFIG = path.join(directory, "config.json");
            process.env.DEPLOYMENTS_PATH = path.join(directory, "deployments.json");
            process.env.DEPLOYMENT_SCRIPT_IMPORT = "true";
            fs.writeFileSync(process.env.DEPLOY_CONFIG, JSON.stringify(config));
            const {main} = await import("../scripts/deployment/deploy");
            const {getLatestDeployment, loadDeployments} =
                await import("../scripts/deployment/lib/deployments");
            await main();
            const records = loadDeployments();
            const address = (key: string) => getLatestDeployment(records, "hardhat", key)!.address;
            const vault = await ethers.getContractAt("IssuanceVault", address("IssuanceVault"));
            const usdc = await ethers.getContractAt("MockUSDC", address("MockUSDC"));
            const mzusd = await ethers.getContractAt("MZUSD", address("MZUSD"));
            expect(await vault.idleBufferUSDC()).to.equal(ethers.parseUnits("1000000", 6));
            expect(await vault.hysteresisBps()).to.equal(500n);
            expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0n);
            expect(await usdc.balanceOf(address("ReservoirUSDC"))).to.equal(0n);
            expect(await mzusd.totalSupply()).to.equal(0n);
            // Exercise setBuffer too: the initial million-USDC / 5% config is already the default.
            config.vault.hysteresisBps = 400;
            fs.writeFileSync(process.env.DEPLOY_CONFIG, JSON.stringify(config));
            await main();
            expect(await vault.idleBufferUSDC()).to.equal(ethers.parseUnits("1000000", 6));
            expect(await vault.hysteresisBps()).to.equal(400n);
            expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0n);
            expect(await usdc.balanceOf(address("ReservoirUSDC"))).to.equal(0n);
            expect(await vault.queryFilter(vault.filters.BufferRebalanceSkipped())).to.have.length(
                1
            );
            const [signer] = await ethers.getSigners();
            const nonce = await signer.getNonce();
            await main();
            expect(await signer.getNonce()).to.equal(nonce);
            expect(loadDeployments()).to.deep.equal(records);
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });
});
