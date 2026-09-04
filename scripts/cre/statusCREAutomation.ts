// Read-only comparison of deployed receiver wiring with local configs and records.
import fs from "fs";
import path from "path";
import {artifacts, ethers, network} from "hardhat";
import {getLatestDeployment, loadDeployments} from "../deployment/lib/deployments";
import {hasCurrentRuntimeBytecode} from "../deployment/lib/creReceiverDeployment";
import {buildWorkflowPermissionChanges} from "../deployment/lib/creWorkflowPermissions";
import {
    resolveWorkflowReceivers,
    type CREWorkflowConfig,
} from "../deployment/lib/creWorkflowConfig";

interface WorkflowPermissionConfig {
    name: string;
    id: string;
}

interface VaultConfig {
    id: string;
    targets: string[];
}

interface CREAutomationConfig {
    accessManager: string;
    chainSelector: string;
    chainlinkAutomationRole: number;
    forwarder: string;
    workflowOwner: string;
    workflowPermissions: WorkflowPermissionConfig[];
    vaults: VaultConfig[];
}

const PERFORM_UPKEEP_SELECTOR = ethers.id("performUpkeep(bytes)").slice(0, 10);

function loadWorkflowReceiverConfigs(): ReadonlyMap<string, string> {
    const configName =
        network.name === "sepolia" ? "config.staging.json" : "config.production.json";
    const workflowConfigs = ["nav-workflow", "finalization-workflow"].map((workflow) => {
        const configPath = path.resolve(__dirname, "../../cre", workflow, configName);
        return JSON.parse(fs.readFileSync(configPath, "utf8")) as CREWorkflowConfig;
    });
    return resolveWorkflowReceivers(workflowConfigs);
}

async function main() {
    const configPath = path.resolve(
        __dirname,
        "../deployment/config",
        `cre-automation.${network.name}.json`
    );
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as CREAutomationConfig;
    const deployments = loadDeployments();
    const accessManager = await ethers.getContractAt("AccessManager", config.accessManager);
    const receiverArtifact = await artifacts.readArtifact("AutomationReceiver");
    const strict = process.env.CRE_STATUS_STRICT === "true";
    let ready = true;
    let workflowReceivers = new Map<string, string>();
    try {
        workflowReceivers = new Map(loadWorkflowReceiverConfigs());
    } catch (error) {
        console.log(
            `Workflow receiver configs: INVALID (${error instanceof Error ? error.message : String(error)})`
        );
        ready = false;
    }

    console.log("\nOn-chain receiver wiring");
    for (const vault of config.vaults) {
        console.log(`\n${vault.id}`);
        const deployment = getLatestDeployment(
            deployments,
            network.name,
            "AutomationReceiver",
            vault.id
        );
        if (!deployment) {
            console.log("  receiver: MISSING");
            ready = false;
            continue;
        }

        const deployedCode = await ethers.provider.getCode(deployment.address);
        if (deployedCode === "0x") {
            console.log(`  receiver: ${deployment.address}`);
            console.log("  runtime bytecode: MISSING");
            ready = false;
            continue;
        }

        const hasCurrentBytecode = hasCurrentRuntimeBytecode(
            deployedCode,
            receiverArtifact.deployedBytecode
        );
        const configuredReceiver = workflowReceivers.get(vault.id);
        const workflowConfigMatches =
            configuredReceiver?.toLowerCase() === deployment.address.toLowerCase();

        console.log(`  receiver: ${deployment.address}`);
        console.log(`  runtime bytecode: ${hasCurrentBytecode ? "OK" : "OUTDATED"}`);
        console.log(
            `  workflow configs: ${workflowConfigMatches ? "OK" : `MISMATCH (${configuredReceiver ?? "missing"})`}`
        );
        ready &&= hasCurrentBytecode;
        ready &&= workflowConfigMatches;

        if (!hasCurrentBytecode) {
            console.log("  chain selector: UNAVAILABLE (outdated receiver)");
            continue;
        }

        const receiver = await ethers.getContractAt("AutomationReceiver", deployment.address);
        const owner = await receiver.owner();
        const forwarder = await receiver.forwarder();
        const workflowOwner = await receiver.workflowOwner();
        const chainSelector = await receiver.chainSelector();
        const [hasRole] = await accessManager.hasRole(
            config.chainlinkAutomationRole,
            deployment.address
        );

        console.log(`  contract owner: ${owner}`);
        console.log(
            `  chain selector: ${chainSelector === BigInt(config.chainSelector) ? "OK" : `MISMATCH (${chainSelector})`}`
        );
        console.log(
            `  forwarder: ${forwarder.toLowerCase() === config.forwarder.toLowerCase() ? "OK" : "MISMATCH"}`
        );
        console.log(
            `  workflow owner: ${workflowOwner.toLowerCase() === config.workflowOwner.toLowerCase() ? "OK" : "MISMATCH"}`
        );
        console.log(`  AccessManager role: ${hasRole ? "OK" : "MISSING"}`);

        ready &&= forwarder.toLowerCase() === config.forwarder.toLowerCase();
        ready &&= workflowOwner.toLowerCase() === config.workflowOwner.toLowerCase();
        ready &&= chainSelector === BigInt(config.chainSelector);
        ready &&= hasRole;

        const activeWorkflowIds = new Set(
            (deployment.workflowIds ?? []).map((id) => id.toLowerCase())
        );
        const desiredWorkflowIds = new Set(
            config.workflowPermissions.map(({id}) => id.toLowerCase())
        );
        const permissionChanges = buildWorkflowPermissionChanges(
            activeWorkflowIds,
            desiredWorkflowIds
        );
        for (const permission of config.workflowPermissions) {
            const allowed = await receiver.allowedWorkflowIds(permission.id);
            console.log(`  workflow ${permission.name}: ${allowed ? "OK" : "MISSING"}`);
            ready &&= allowed;
        }
        for (const change of permissionChanges.filter(({allowed}) => !allowed)) {
            const allowed = await receiver.allowedWorkflowIds(change.id);
            console.log(`  stale workflow ${change.id}: ${allowed ? "ALLOWED" : "REVOKED"}`);
            ready &&= !allowed;
        }
        ready &&= permissionChanges.length === 0;

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
