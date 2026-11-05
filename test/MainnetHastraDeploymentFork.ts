import {expect} from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import {ethers, network} from "hardhat";

const forkTest = process.env.TEST_MAINNET_HASTRA_DEPLOYMENT === "true" ? describe : describe.skip;

forkTest("Mezzanine Hastra mainnet deployment on a fork", function () {
    this.timeout(300000);

    it("reuses shared infrastructure, deploys against wYLDS, seeds dead shares, and reruns idempotently", async () => {
        expect(network.name).to.equal("hardhat");

        const configPath = path.resolve("scripts/deployment/config/mainnet-mezzanine-hastra.json");
        const sourceDeploymentsPath = path.resolve("reports/deployments.json");
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mezzanine-hastra-fork-"));
        const deploymentsPath = path.join(directory, "deployments.json");
        const safeBatchPath = path.join(directory, "safe-setup.json");
        const previous = {
            DEPLOY_CONFIG: process.env.DEPLOY_CONFIG,
            DEPLOYMENTS_PATH: process.env.DEPLOYMENTS_PATH,
            DEPLOYMENT_SCRIPT_IMPORT: process.env.DEPLOYMENT_SCRIPT_IMPORT,
            DEPLOY_SAFE_HANDOFF: process.env.DEPLOY_SAFE_HANDOFF,
            DEPLOY_SAFE_BATCH_PATH: process.env.DEPLOY_SAFE_BATCH_PATH,
        };

        try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
            const sourceDeployments = JSON.parse(fs.readFileSync(sourceDeploymentsPath, "utf8"));
            fs.writeFileSync(
                deploymentsPath,
                JSON.stringify(
                    {
                        hardhat: {
                            [config.infrastructureId]:
                                sourceDeployments.mainnet[config.infrastructureId],
                        },
                    },
                    null,
                    2
                )
            );

            process.env.DEPLOY_CONFIG = configPath;
            process.env.DEPLOYMENTS_PATH = deploymentsPath;
            process.env.DEPLOYMENT_SCRIPT_IMPORT = "true";
            process.env.DEPLOY_SAFE_HANDOFF = "true";
            process.env.DEPLOY_SAFE_BATCH_PATH = safeBatchPath;

            const shared = sourceDeployments.mainnet[config.infrastructureId];
            const accessManagerAddress = shared.AccessManager.at(-1).address;
            const pauseManagerAddress = shared.PauseManager.at(-1).address;
            const allowlistAddress = shared.AllowlistStub.at(-1).address;

            // Production shared infrastructure is governed by the client. The deployer does not
            // receive ADMIN; client-only calls are exported as a Safe Transaction Builder batch.
            const clientAdmin = config.roles.admin;
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [clientAdmin],
            });
            await network.provider.send("hardhat_setBalance", [
                clientAdmin,
                "0x3635C9ADC5DEA00000",
            ]);
            const accessManager = await ethers.getContractAt(
                "AccessManager",
                accessManagerAddress,
                await ethers.getSigner(clientAdmin)
            );
            const adminRole = await accessManager.ADMIN_ROLE();
            const [deployerHadAdmin] = await accessManager.hasRole(adminRole, config.dev.deployer);
            expect(deployerHadAdmin).to.equal(false);

            const wylds = await ethers.getContractAt("IERC20Metadata", config.usdc.address);
            expect(await wylds.symbol()).to.equal("wYLDS");
            expect(await wylds.decimals()).to.equal(6n);

            // The Hastra PRIME staking vault holds wYLDS on mainnet. Use it only as a fork whale.
            const wyldsWhale = "0x19ebb35279A16207Ec4ba82799CC64715065F7F6";
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [wyldsWhale],
            });
            await network.provider.send("hardhat_setBalance", [wyldsWhale, "0x3635C9ADC5DEA00000"]);
            await (
                await wylds
                    .connect(await ethers.getSigner(wyldsWhale))
                    .transfer(clientAdmin, ethers.parseUnits("2", 6))
            ).wait();

            const {main} = await import("../scripts/deployment/deploy");
            const {getLatestDeployment, loadDeployments} =
                await import("../scripts/deployment/lib/deployments");

            await main();

            const safeBatch = JSON.parse(fs.readFileSync(safeBatchPath, "utf8"));
            expect(safeBatch.chainId).to.equal("31337");
            expect(safeBatch.meta.createdFromSafeAddress).to.equal(clientAdmin);
            expect(safeBatch.transactions.length).to.be.greaterThan(0);

            let records = loadDeployments();
            const pendingMzusd = getLatestDeployment(
                records,
                "hardhat",
                "MZUSD",
                config.deploymentId
            )!.address;
            expect(await (await ethers.getContractAt("MZUSD", pendingMzusd)).vault()).to.equal(
                ethers.ZeroAddress
            );

            const clientSigner = await ethers.getSigner(clientAdmin);
            for (const transaction of safeBatch.transactions) {
                await (
                    await clientSigner.sendTransaction({
                        to: transaction.to,
                        data: transaction.data,
                        value: transaction.value,
                    })
                ).wait();
            }

            delete process.env.DEPLOY_SAFE_HANDOFF;
            await main();

            records = loadDeployments();
            const sharedAddress = (key: string) =>
                getLatestDeployment(records, "hardhat", key, config.infrastructureId)!.address;
            const vaultAddress = (key: string) =>
                getLatestDeployment(records, "hardhat", key, config.deploymentId)!.address;

            expect(sharedAddress("AccessManager")).to.equal(accessManagerAddress);
            expect(sharedAddress("PauseManager")).to.equal(pauseManagerAddress);
            expect(sharedAddress("AllowlistStub")).to.equal(allowlistAddress);

            const mzusd = await ethers.getContractAt("MZUSD", vaultAddress("MZUSD"));
            const reservoir = await ethers.getContractAt(
                "ReservoirUSDC",
                vaultAddress("ReservoirUSDC")
            );
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

            expect(await mzusd.usdc()).to.equal(config.usdc.address);
            expect(await reservoir.usdc()).to.equal(config.usdc.address);
            expect(await vault.performanceFeeBps()).to.equal(1000n);
            expect(await vault.protocolFeeBps()).to.equal(250n);
            expect(await vault.idleBufferUSDC()).to.equal(ethers.parseUnits("1", 6));
            expect(await vault.hysteresisBps()).to.equal(5n);
            expect(await vault.epochDuration()).to.equal(604800n);
            expect(await vault.baseRewardBps()).to.equal(8000n);
            expect(await mzusd.withdrawalFeeBps()).to.equal(1n);

            expect(await senior.name()).to.equal("Senior Hastra");
            expect(await senior.symbol()).to.equal("msHastra");
            expect(await junior.name()).to.equal("Junior Hastra");
            expect(await junior.symbol()).to.equal("mjHastra");
            expect(await navOracle.vetoPeriod()).to.equal(86400n);
            expect(await navOracle.maxAnswerStaleness()).to.equal(86400n);
            expect(await navOracle.navOracle()).to.equal(ethers.ZeroAddress);
            expect(await navOracle.totalSupplyOracle()).to.equal(ethers.ZeroAddress);

            const dead = "0x000000000000000000000000000000000000dEaD";
            expect(await senior.totalAssets()).to.equal(ethers.parseUnits("1", 18));
            expect(await junior.totalAssets()).to.equal(ethers.parseUnits("1", 18));
            expect(await senior.balanceOf(dead)).to.equal(await senior.totalSupply());
            expect(await junior.balanceOf(dead)).to.equal(await junior.totalSupply());
            expect(await wylds.balanceOf(await vault.getAddress())).to.equal(
                ethers.parseUnits("1", 6)
            );
            expect(await wylds.balanceOf(await reservoir.getAddress())).to.equal(
                ethers.parseUnits("1", 6)
            );

            const [deployerHasAdmin] = await accessManager.hasRole(adminRole, config.dev.deployer);
            expect(deployerHasAdmin).to.equal(false);

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
