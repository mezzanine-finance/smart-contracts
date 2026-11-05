import fs from "fs";
import {ethers, network} from "hardhat";
import {getLatestDeployment, loadDeployments} from "./lib/deployments";

async function main() {
    if (network.name !== "mainnet") throw new Error("Hastra receiver handoff requires mainnet");
    const config = JSON.parse(
        fs.readFileSync("scripts/deployment/config/mainnet-mezzanine-hastra.json", "utf8")
    );
    const cre = JSON.parse(
        fs.readFileSync("scripts/deployment/config/cre-automation.hastra.json", "utf8")
    );
    const record = getLatestDeployment(
        loadDeployments(),
        network.name,
        "AutomationReceiver",
        config.deploymentId
    );
    if (!record) throw new Error("Missing Hastra receiver deployment");
    const [deployer] = await ethers.getSigners();
    const receiver = await ethers.getContractAt("AutomationReceiver", record.address, deployer);
    const accessManager = await ethers.getContractAt("AccessManager", cre.accessManager);
    if (!(await accessManager.hasRole(0, config.roles.admin))[0])
        throw new Error("Client Safe lacks ADMIN_ROLE");
    if (!(await accessManager.hasRole(10, record.address))[0])
        throw new Error("Receiver automation role is missing");
    const selector = ethers.id("performUpkeep(bytes)").slice(0, 10);
    for (const target of cre.vaults[0].targets) {
        if (!(await receiver.allowedCalls(target, selector)))
            throw new Error(`Missing receiver permission: ${target}`);
        if ((await accessManager.getTargetFunctionRole(target, selector)) !== 10n)
            throw new Error(`Incorrect target role: ${target}`);
    }
    for (const {id} of cre.workflowPermissions) {
        if (!(await receiver.allowedWorkflowIds(id)))
            throw new Error(`Missing workflow permission: ${id}`);
    }
    const owner = await receiver.owner();
    if (owner.toLowerCase() === config.roles.admin.toLowerCase()) {
        console.log("Receiver already owned by client:", owner);
        return;
    }
    if (
        owner !== deployer.address ||
        deployer.address.toLowerCase() !== config.dev.deployer.toLowerCase()
    )
        throw new Error("Unexpected receiver owner or signer");
    await receiver.transferOwnership.staticCall(config.roles.admin);
    const tx = await receiver.transferOwnership(config.roles.admin);
    console.log("Ownership transfer sent:", tx.hash);
    const receipt = await tx.wait();
    if (
        receipt?.status !== 1 ||
        (await receiver.owner()).toLowerCase() !== config.roles.admin.toLowerCase()
    )
        throw new Error("Ownership transfer verification failed");
    console.log("Receiver owner:", await receiver.owner());
    fs.writeFileSync(
        "reports/hastra-cre-handoff.json",
        JSON.stringify(
            {
                network: "mainnet",
                deploymentId: config.deploymentId,
                receiver: record.address,
                owner: config.roles.admin,
                ownershipTransferTx: tx.hash,
                ownershipTransferBlock: receipt.blockNumber,
                clientSetupTx: "0x6a9a29ac2128ef8003b988a2dff70610b34711c2d2c5ff1b33576674b54bf27f",
                workflows: cre.workflowPermissions,
                verifiedAt: new Date().toISOString(),
            },
            null,
            2
        ) + "\n"
    );
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
