// Deploy, configure and verify per-vault receivers; plan/validate modes do not send transactions.
import fs from "fs";
import path from "path";
import {artifacts, ethers, network} from "hardhat";
import type {AccessManager, AutomationReceiver} from "../../typechain-types";
import {
    getLatestDeployment,
    loadDeployments,
    recordDeployment,
    saveDeployments,
    type DeploymentRecord,
} from "./lib/deployments";
import {buildWorkflowPermissionChanges} from "./lib/creWorkflowPermissions";
import {syncWorkflowReceivers, type CREWorkflowConfig} from "./lib/creWorkflowConfig";
import {hasCurrentRuntimeBytecode, shouldConfigureReceiver} from "./lib/creReceiverDeployment";
import {verifyContract} from "./lib/verify";

interface VaultAutomationConfig {
    id: string;
    targets: string[];
}

interface WorkflowPermissionConfig {
    name: string;
    id: string;
}

interface CREAutomationConfig {
    accessManager: string;
    chainSelector: string;
    chainlinkAutomationRole: number;
    forwarder: string;
    workflowOwner: string;
    workflowPermissions: WorkflowPermissionConfig[];
    vaults: VaultAutomationConfig[];
}

const PERFORM_UPKEEP_SELECTOR = ethers.id("performUpkeep(bytes)").slice(0, 10);
const SEPOLIA_WORKFLOW_CONFIG_PATHS = [
    path.resolve(__dirname, "../../cre/nav-workflow/config.staging.json"),
    path.resolve(__dirname, "../../cre/finalization-workflow/config.staging.json"),
];

function syncWorkflowConfigFiles(receivers: ReadonlyMap<string, string>): void {
    for (const workflowConfigPath of SEPOLIA_WORKFLOW_CONFIG_PATHS) {
        const workflowConfig = JSON.parse(
            fs.readFileSync(workflowConfigPath, "utf8")
        ) as CREWorkflowConfig;
        const result = syncWorkflowReceivers(workflowConfig, receivers);
        if (!result.changed) {
            console.log(`Workflow config already current: ${workflowConfigPath}`);
            continue;
        }
        fs.writeFileSync(workflowConfigPath, `${JSON.stringify(result.config, null, 2)}\n`);
        console.log(`Updated workflow receiver addresses: ${workflowConfigPath}`);
    }
}

function loadConfig(configPath: string): CREAutomationConfig {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as CREAutomationConfig;
    if (!ethers.isAddress(config.accessManager)) throw new Error("Invalid AccessManager address");
    if (!ethers.isAddress(config.forwarder)) throw new Error("Invalid forwarder address");
    if (!ethers.isAddress(config.workflowOwner)) throw new Error("Invalid workflow owner address");
    if (
        !/^[1-9][0-9]*$/.test(config.chainSelector) ||
        BigInt(config.chainSelector) > 2n ** 64n - 1n
    ) {
        throw new Error("Invalid chain selector");
    }
    if (!Number.isSafeInteger(config.chainlinkAutomationRole)) {
        throw new Error("Invalid CHAINLINK_AUTOMATION role ID");
    }
    if (config.workflowPermissions.length === 0) {
        throw new Error("At least one workflow permission is required");
    }

    const workflowIds = new Set<string>();
    for (const permission of config.workflowPermissions) {
        if (!permission.name || !ethers.isHexString(permission.id, 32)) {
            throw new Error(`Invalid workflow permission: ${permission.name || permission.id}`);
        }
        const normalizedId = permission.id.toLowerCase();
        if (workflowIds.has(normalizedId)) {
            throw new Error(`Duplicate workflow ID: ${permission.id}`);
        }
        workflowIds.add(normalizedId);
    }
    if (config.vaults.length === 0) throw new Error("At least one vault is required");

    const ids = new Set<string>();
    for (const vault of config.vaults) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(vault.id) || ids.has(vault.id)) {
            throw new Error(`Invalid or duplicate vault ID: ${vault.id}`);
        }
        ids.add(vault.id);
        if (vault.targets.length === 0) throw new Error(`${vault.id} has no targets`);
        for (const target of vault.targets) {
            if (!ethers.isAddress(target))
                throw new Error(`${vault.id} has invalid target: ${target}`);
        }
    }
    return config;
}

async function validateTargetRoles(
    accessManager: AccessManager,
    config: CREAutomationConfig
): Promise<void> {
    for (const vault of config.vaults) {
        for (const target of vault.targets) {
            if ((await ethers.provider.getCode(target)) === "0x") {
                throw new Error(`${vault.id} target has no bytecode: ${target}`);
            }
            const role = await accessManager.getTargetFunctionRole(target, PERFORM_UPKEEP_SELECTOR);
            if (Number(role) !== config.chainlinkAutomationRole) {
                throw new Error(
                    `${vault.id} target ${target} uses role ${role} for performUpkeep(bytes), expected ${config.chainlinkAutomationRole}`
                );
            }
        }
    }
}

async function configureReceiver(
    receiver: AutomationReceiver,
    deployment: DeploymentRecord,
    accessManager: AccessManager,
    config: CREAutomationConfig,
    vault: VaultAutomationConfig,
    roleId: number
): Promise<void> {
    const receiverAddress = await receiver.getAddress();
    if ((await receiver.forwarder()) !== config.forwarder) {
        const tx = await receiver.setForwarder(config.forwarder);
        await tx.wait();
    }
    if ((await receiver.workflowOwner()) !== config.workflowOwner) {
        const tx = await receiver.setWorkflowOwner(config.workflowOwner);
        await tx.wait();
    }
    if (!deployment.workflowIds) {
        throw new Error(
            `${vault.id} deployment is missing tracked workflow IDs; initialize workflowIds in reports/deployments.json before reconciliation`
        );
    }
    const activeWorkflowIds = new Set(deployment.workflowIds.map((id) => id.toLowerCase()));
    const desiredWorkflowIds = new Set(config.workflowPermissions.map(({id}) => id.toLowerCase()));
    for (const change of buildWorkflowPermissionChanges(activeWorkflowIds, desiredWorkflowIds)) {
        console.log(`  workflow ${change.id}: ${change.allowed ? "allowing" : "revoking"}`);
        if ((await receiver.allowedWorkflowIds(change.id)) !== change.allowed) {
            const tx = await receiver.setWorkflowPermission(change.id, change.allowed);
            await tx.wait();
        }
    }
    for (const id of desiredWorkflowIds) {
        if (!(await receiver.allowedWorkflowIds(id))) {
            const tx = await receiver.setWorkflowPermission(id, true);
            await tx.wait();
        }
    }
    deployment.workflowIds = [...desiredWorkflowIds];
    for (const target of vault.targets) {
        if (!(await receiver.allowedCalls(target, PERFORM_UPKEEP_SELECTOR))) {
            const tx = await receiver.setCallPermission(target, PERFORM_UPKEEP_SELECTOR, true);
            await tx.wait();
        }
    }

    const [hasRole] = await accessManager.hasRole(roleId, receiverAddress);
    if (!hasRole) {
        const tx = await accessManager.grantRole(roleId, receiverAddress, 0);
        await tx.wait();
    }
}

async function main() {
    const planOnly = process.env.CRE_RECEIVERS_PLAN === "true";
    const validateOnly = process.env.CRE_RECEIVERS_VALIDATE === "true";
    const prepareOnly = process.env.CRE_RECEIVERS_PREPARE === "true";
    const configPath = path.resolve(
        process.env.CRE_AUTOMATION_CONFIG ??
            path.join(__dirname, "config", `cre-automation.${network.name}.json`)
    );
    const config = loadConfig(configPath);
    const forwarder = process.env.CRE_FORWARDER_ADDRESS ?? config.forwarder;
    const workflowOwner = process.env.CRE_WORKFLOW_OWNER ?? config.workflowOwner;
    if (!ethers.isAddress(forwarder)) throw new Error("Invalid resolved forwarder address");
    if (!ethers.isAddress(workflowOwner))
        throw new Error("Invalid resolved workflow owner address");
    const resolvedConfig = {...config, forwarder, workflowOwner};
    const [deployer] = await ethers.getSigners();

    console.log("=== CRE Automation Receivers ===");
    console.log("Network:", network.name);
    console.log("Config:", configPath);
    console.log("Deployer / receiver owner:", deployer.address);
    console.log("AccessManager:", config.accessManager);
    console.log("Chain selector:", config.chainSelector);
    console.log("Forwarder:", forwarder);
    console.log("Workflow owner:", workflowOwner);
    console.log("performUpkeep(bytes) selector:", PERFORM_UPKEEP_SELECTOR);
    console.log("Mode:", prepareOnly ? "prepare receivers without permissions" : "configure");
    for (const permission of config.workflowPermissions) {
        console.log(`workflow ${permission.name}: ${permission.id}`);
    }
    for (const vault of config.vaults) {
        console.log(`${vault.id}: ${vault.targets.length} target(s)`);
        for (const target of vault.targets) console.log("  -", target);
    }

    if (planOnly) {
        console.log(
            "Plan only: no RPC reads, deployments, permissions, or report writes performed."
        );
        console.log(
            "CRE_FORWARDER_ADDRESS and CRE_WORKFLOW_OWNER may override the configured values."
        );
        return;
    }

    if ((await ethers.provider.getCode(config.accessManager)) === "0x") {
        throw new Error(`AccessManager has no bytecode: ${config.accessManager}`);
    }
    const accessManager = await ethers.getContractAt("AccessManager", config.accessManager);
    await validateTargetRoles(accessManager, config);
    console.log("On-chain target bytecode and performUpkeep(bytes) roles are valid.");

    if (validateOnly) {
        console.log("Validation only: no deployments, permissions, or report writes performed.");
        return;
    }

    const deployments = loadDeployments();
    const factory = await ethers.getContractFactory("AutomationReceiver", deployer);
    const receiverArtifact = await artifacts.readArtifact("AutomationReceiver");
    const selectedReceivers = new Map<string, string>();
    let preparedReceiverCount = 0;
    for (const vault of config.vaults) {
        const existing = getLatestDeployment(
            deployments,
            network.name,
            "AutomationReceiver",
            vault.id
        );
        const existingCode = existing ? await ethers.provider.getCode(existing.address) : "0x";
        const hasCurrentCode =
            existing !== undefined &&
            hasCurrentRuntimeBytecode(existingCode, receiverArtifact.deployedBytecode);
        const hasExpectedChainSelector =
            existing !== undefined &&
            hasCurrentCode &&
            (await (factory.attach(existing.address) as AutomationReceiver).chainSelector()) ===
                BigInt(config.chainSelector);
        const canReuseExisting =
            existing !== undefined && hasCurrentCode && hasExpectedChainSelector;
        let receiver: AutomationReceiver;
        let deployment: DeploymentRecord;
        let newlyDeployed = false;
        if (existing && canReuseExisting) {
            receiver = factory.attach(existing.address) as AutomationReceiver;
            deployment = existing;
            console.log(`${vault.id}: reusing receiver ${existing.address}`);
        } else {
            newlyDeployed = true;
            if (existing && existingCode !== "0x") {
                console.log(
                    `${vault.id}: receiver ${existing.address} has outdated bytecode or chain selector; deploying a replacement`
                );
            }
            receiver = await factory.deploy(
                deployer.address,
                forwarder,
                workflowOwner,
                config.chainSelector
            );
            await receiver.waitForDeployment();
            const address = await receiver.getAddress();
            const txHash = receiver.deploymentTransaction()?.hash;
            deployment = recordDeployment(
                deployments,
                network.name,
                "AutomationReceiver",
                {
                    address,
                    txHash,
                    deployedAt: new Date().toISOString(),
                    ...(existing && existingCode !== "0x" ? {replaces: existing.address} : {}),
                },
                vault.id
            );
            deployment.workflowIds = [];
            saveDeployments(deployments);
            console.log(`${vault.id}: deployed receiver ${address}`);
        }

        const shouldConfigure = shouldConfigureReceiver(prepareOnly, newlyDeployed);
        if (shouldConfigure) {
            await configureReceiver(
                receiver,
                deployment,
                accessManager,
                resolvedConfig,
                vault,
                config.chainlinkAutomationRole
            );
        } else {
            if (newlyDeployed) {
                preparedReceiverCount += 1;
                console.log(
                    `${vault.id}: receiver prepared without workflow permissions or AccessManager role`
                );
            } else {
                console.log(`${vault.id}: existing receiver left unchanged during preparation`);
            }
        }
        if (shouldConfigure && deployment.replaces) {
            const [oldReceiverHasRole] = await accessManager.hasRole(
                config.chainlinkAutomationRole,
                deployment.replaces
            );
            if (oldReceiverHasRole) {
                const tx = await accessManager.revokeRole(
                    config.chainlinkAutomationRole,
                    deployment.replaces
                );
                await tx.wait();
                console.log(`${vault.id}: revoked AccessManager role from ${deployment.replaces}`);
            }
        }
        saveDeployments(deployments);
        selectedReceivers.set(vault.id, await receiver.getAddress());
        if (shouldConfigure) {
            console.log(
                `${vault.id}: workflow identity, call permissions, and AccessManager role configured`
            );
        }

        await verifyContract(await receiver.getAddress(), [
            deployer.address,
            forwarder,
            workflowOwner,
            config.chainSelector,
        ]);
    }

    if (network.name === "sepolia") syncWorkflowConfigFiles(selectedReceivers);

    if (prepareOnly || preparedReceiverCount > 0) {
        console.log(
            "Receiver preparation complete. No permissions were granted to newly deployed receivers."
        );
        console.log("Recompute workflow IDs before the final configuration pass.");
    } else {
        console.log("Configured workflow permissions now match the deployment config.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
