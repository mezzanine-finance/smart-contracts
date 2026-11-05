import {expect} from "chai";
import fs from "fs";
import {ethers, network} from "hardhat";

const forkTest = process.env.TEST_MAINNET_HASTRA_CRE === "true" ? describe : describe.skip;
forkTest("Hastra CRE client handoff on mainnet fork", function () {
    this.timeout(300000);
    it("executes the complete client batch and enables the configured receiver without deployer roles", async () => {
        expect(network.name).to.equal("hardhat");
        const config = JSON.parse(
            fs.readFileSync("scripts/deployment/config/mainnet-mezzanine-hastra.json", "utf8")
        );
        const cre = JSON.parse(
            fs.readFileSync("scripts/deployment/config/cre-automation.hastra.json", "utf8")
        );
        const records = JSON.parse(fs.readFileSync("reports/deployments.json", "utf8")).mainnet[
            config.deploymentId
        ];
        const address = (key: string) => records[key].at(-1).address;
        const batch = JSON.parse(
            fs.readFileSync("reports/safe-mainnet-mezzanine-hastra-setup.json", "utf8")
        );
        const safe = config.roles.admin;
        await network.provider.request({method: "hardhat_impersonateAccount", params: [safe]});
        await network.provider.send("hardhat_setBalance", [safe, "0x3635C9ADC5DEA00000"]);
        const signer = await ethers.getSigner(safe);
        const am = await ethers.getContractAt("AccessManager", cre.accessManager);
        const receiver = await ethers.getContractAt(
            "AutomationReceiver",
            address("AutomationReceiver")
        );
        expect((await am.hasRole(0, config.dev.deployer))[0]).to.equal(false);
        expect((await am.hasRole(10, await receiver.getAddress()))[0]).to.equal(false);
        for (const tx of batch.transactions) {
            await (
                await signer.sendTransaction({
                    to: tx.to,
                    data: tx.data,
                    value: BigInt(tx.value),
                    gasLimit: 3000000,
                })
            ).wait();
        }
        const selector = ethers.id("performUpkeep(bytes)").slice(0, 10);
        for (const target of cre.vaults[0].targets) {
            expect(await receiver.allowedCalls(target, selector)).to.equal(true);
            expect(await am.getTargetFunctionRole(target, selector)).to.equal(10n);
            expect((await am.canCall(await receiver.getAddress(), target, selector))[0]).to.equal(
                true
            );
        }
        for (const permission of cre.workflowPermissions)
            expect(await receiver.allowedWorkflowIds(permission.id)).to.equal(true);
        expect(await receiver.workflowOwner()).to.equal(ethers.getAddress(cre.workflowOwner));
        expect(await receiver.forwarder()).to.equal(ethers.getAddress(cre.forwarder));
        expect(await receiver.chainSelector()).to.equal(BigInt(cre.chainSelector));
        const mz = await ethers.getContractAt("MZUSD", address("MZUSD"));
        expect(await mz.vault()).to.equal(address("IssuanceVault"));
        for (const key of ["senior", "junior"]) {
            const tranche = await ethers.getContractAt("Tranche", address(`Tranche.${key}`));
            expect(await tranche.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(
                ethers.parseUnits("1", await tranche.decimals())
            );
        }
        for (let role = 0; role <= 10; role++)
            expect((await am.hasRole(role, config.dev.deployer))[0]).to.equal(false);
    });
});
