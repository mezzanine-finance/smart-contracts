import fs from "fs";
import path from "path";
import {ethers, network} from "hardhat";
import {getLatestDeployment, loadDeployments} from "../deployment/lib/deployments";

interface WorkflowPermissionConfig {
    name: string;
    id: string;
    allowed: boolean;
}

interface VaultConfig {
    id: string;
    targets: string[];
}

interface CREAutomationConfig {
    accessManager: string;
    chainlinkAutomationRole: number;
    forwarder: string;
    workflowOwner: string;
    workflowPermissions: WorkflowPermissionConfig[];
    vaults: VaultConfig[];
}

const PERFORM_UPKEEP_SELECTOR = ethers.id("performUpkeep(bytes)").slice(0, 10);

async function main() {
    const configPath = path.resolve(
        __dirname,
        "../deployment/config",
        `cre-automation.${network.name}.json`
    );
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as CREAutomationConfig;
    const deployments = loadDeployments();
    const accessManager = await ethers.getContractAt("AccessManager", config.accessManager);
    const strict = process.env.CRE_STATUS_STRICT === "true";
    let ready = true;

    console.log("\nOn-chain receiver wiring");
    for (const vault of config.vaults) {
        console.log(`\n${vault.id}`);
        const deployment = getLatestDeployment(
            deployments,
            network.name,
            "AutomationReceiver",
            vault.id
        );
        if (!deployment || (await ethers.provider.getCode(deployment.address)) === "0x") {
            console.log("  receiver: MISSING");
            ready = false;
            continue;
        }

        const receiver = await ethers.getContractAt("AutomationReceiver", deployment.address);
        const owner = await receiver.owner();
        const forwarder = await receiver.forwarder();
        const workflowOwner = await receiver.workflowOwner();
        const [hasRole] = await accessManager.hasRole(
            config.chainlinkAutomationRole,
            deployment.address
        );

        console.log(`  receiver: ${deployment.address}`);
        console.log(`  contract owner: ${owner}`);
        console.log(
            `  forwarder: ${forwarder.toLowerCase() === config.forwarder.toLowerCase() ? "OK" : "MISMATCH"}`
        );
        console.log(
            `  workflow owner: ${workflowOwner.toLowerCase() === config.workflowOwner.toLowerCase() ? "OK" : "MISMATCH"}`
        );
        console.log(`  AccessManager role: ${hasRole ? "OK" : "MISSING"}`);

        ready &&= forwarder.toLowerCase() === config.forwarder.toLowerCase();
        ready &&= workflowOwner.toLowerCase() === config.workflowOwner.toLowerCase();
        ready &&= hasRole;

        for (const permission of config.workflowPermissions) {
            const actual = await receiver.allowedWorkflowIds(permission.id);
            const matches = actual === permission.allowed;
            console.log(`  workflow ${permission.name}: ${matches ? "OK" : "MISMATCH"}`);
            ready &&= matches;
        }

        for (const target of vault.targets) {
            const allowed = await receiver.allowedCalls(target, PERFORM_UPKEEP_SELECTOR);
            console.log(`  call ${target}: ${allowed ? "OK" : "MISSING"}`);
            ready &&= allowed;
        }
    }

    console.log(`\nReceiver wiring: ${ready ? "READY" : "NOT READY"}`);
    if (strict && !ready) process.exitCode = 1;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
