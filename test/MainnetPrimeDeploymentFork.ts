import {expect} from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import {ethers, network} from "hardhat";

const forkTest = process.env.TEST_MAINNET_PRIME_DEPLOYMENT === "true" ? describe : describe.skip;

forkTest("Mezzanine PRIME mainnet deployment on a fork", function () {
    this.timeout(300000);

    it("deploys, seeds only dead shares, preserves empty feeds and reruns idempotently", async () => {
        expect(network.name).to.equal("hardhat");

        const configPath = path.resolve("scripts/deployment/config/mainnet-mezzanine-prime.json");
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mezzanine-prime-fork-"));
        const deploymentsPath = path.join(directory, "deployments.json");
        const previous = {
            DEPLOY_CONFIG: process.env.DEPLOY_CONFIG,
            DEPLOYMENTS_PATH: process.env.DEPLOYMENTS_PATH,
            DEPLOYMENT_SCRIPT_IMPORT: process.env.DEPLOYMENT_SCRIPT_IMPORT,
        };

        try {
            process.env.DEPLOY_CONFIG = configPath;
            process.env.DEPLOYMENTS_PATH = deploymentsPath;
            process.env.DEPLOYMENT_SCRIPT_IMPORT = "true";

            const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
            const usdc = await ethers.getContractAt("IERC20", config.usdc.address);
            expect(await ethers.provider.getCode(config.usdc.address)).not.to.equal("0x");

            // Fund only the fork: impersonate a liquid mainnet holder and transfer the exact seed.
            const whale = "0x55fe002aeff02f77364de339a1292923a15844b8";
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [whale],
            });
            await network.provider.send("hardhat_setBalance", [whale, "0x3635C9ADC5DEA00000"]);
            await (
                await usdc
                    .connect(await ethers.getSigner(whale))
                    .transfer(config.dev.deployer, ethers.parseUnits("2", 6))
            ).wait();

            const {main} = await import("../scripts/deployment/deploy");
            const {getLatestDeployment, loadDeployments} =
                await import("../scripts/deployment/lib/deployments");

            await main();

            const records = loadDeployments();
            const sharedAddress = (key: string) =>
                getLatestDeployment(records, "hardhat", key, config.infrastructureId)!.address;
            const vaultAddress = (key: string) =>
                getLatestDeployment(records, "hardhat", key, config.deploymentId)!.address;

            const accessManager = await ethers.getContractAt(
                "AccessManager",
                sharedAddress("AccessManager")
            );
            const mzusd = await ethers.getContractAt("MZUSD", vaultAddress("MZUSD"));
            const vault = await ethers.getContractAt(
                "IssuanceVault",
                vaultAddress("IssuanceVault")
            );
            const senior = await ethers.getContractAt("Tranche", vaultAddress("Tranche.senior"));
            const junior = await ethers.getContractAt("Tranche", vaultAddress("Tranche.junior"));
            const navOracle = await ethers.getContractAt(
                "NavOracleAutomation",
                vaultAddress("NavOracleAutomation")
            );

            expect(await vault.performanceFeeBps()).to.equal(1000n);
            expect(await vault.protocolFeeBps()).to.equal(250n);
            expect(await vault.idleBufferUSDC()).to.equal(ethers.parseUnits("1", 6));
            expect(await vault.hysteresisBps()).to.equal(500n);
            expect(await vault.epochDuration()).to.equal(604800n);
            expect(await vault.baseRewardBps()).to.equal(8000n);
            expect(await mzusd.withdrawalFeeBps()).to.equal(1n);

            expect(await senior.name()).to.equal("Senior PRIME");
            expect(await senior.symbol()).to.equal("msPRIME");
            expect(await senior.trancheId()).to.equal(1n);
            expect(await senior.unstakeDelayEpochs()).to.equal(1n);
            expect(await senior.unstakeYieldReductionBps()).to.equal(5000n);
            expect(await junior.name()).to.equal("Junior PRIME");
            expect(await junior.symbol()).to.equal("mjPRIME");
            expect(await junior.trancheId()).to.equal(2n);
            expect(await junior.unstakeDelayEpochs()).to.equal(2n);
            expect(await junior.unstakeYieldReductionBps()).to.equal(5000n);

            const [yieldTranches, riskPremiumBps] = await vault.getTranches(0, 2);
            expect(yieldTranches.map((address) => address.toLowerCase())).to.deep.equal([
                (await junior.getAddress()).toLowerCase(),
                (await senior.getAddress()).toLowerCase(),
            ]);
            expect(riskPremiumBps).to.deep.equal([2000n, 0n]);

            expect(await navOracle.navOracle()).to.equal(ethers.ZeroAddress);
            expect(await navOracle.totalSupplyOracle()).to.equal(ethers.ZeroAddress);
            expect(await navOracle.vetoPeriod()).to.equal(86400n);

            const dead = "0x000000000000000000000000000000000000dEaD";
            expect(await senior.balanceOf(dead)).to.equal(await senior.totalSupply());
            expect(await junior.balanceOf(dead)).to.equal(await junior.totalSupply());
            expect(await senior.totalAssets()).to.equal(ethers.parseUnits("1", 18));
            expect(await junior.totalAssets()).to.equal(ethers.parseUnits("1", 18));
            expect(await mzusd.balanceOf(await senior.getAddress())).to.equal(
                ethers.parseUnits("1", 18)
            );
            expect(await mzusd.balanceOf(await junior.getAddress())).to.equal(
                ethers.parseUnits("1", 18)
            );
            expect(await usdc.balanceOf(await vault.getAddress())).to.equal(
                ethers.parseUnits("1", 6)
            );
            expect(await usdc.balanceOf(vaultAddress("ReservoirUSDC"))).to.equal(
                ethers.parseUnits("1", 6)
            );
            expect(await mzusd.balanceOf(config.dev.deployer)).to.equal(0n);

            for (const key of ["UmbrellaEpochFinalizer.senior", "UmbrellaEpochFinalizer.junior"]) {
                expect(await ethers.provider.getCode(vaultAddress(key))).not.to.equal("0x");
            }

            const adminRoleId = await accessManager.ADMIN_ROLE();
            const [clientAdminRole] = await accessManager.hasRole(adminRoleId, config.roles.admin);
            const [oracleRole] = await accessManager.hasRole(6, config.navOracle.oracles[0]);
            const [keeperRole] = await accessManager.hasRole(7, config.roles.keepers[0]);
            const setOraclesSelector = navOracle.interface.getFunction("setOracles").selector;
            expect(
                await accessManager.getTargetFunctionRole(
                    await navOracle.getAddress(),
                    setOraclesSelector
                )
            ).to.equal(adminRoleId);
            expect(clientAdminRole).to.equal(true);
            expect(oracleRole).to.equal(true);
            expect(keeperRole).to.equal(true);

            const [defaultDeployer] = await ethers.getSigners();
            const nonceBefore = await defaultDeployer.getNonce();
            const devNonceBefore = await ethers.provider.getTransactionCount(config.dev.deployer);
            await main();
            expect(await defaultDeployer.getNonce()).to.equal(nonceBefore);
            expect(await ethers.provider.getTransactionCount(config.dev.deployer)).to.equal(
                devNonceBefore
            );
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });
});
