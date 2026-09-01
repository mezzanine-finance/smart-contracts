import fs from "fs";
import path from "path";
import {ethers, network} from "hardhat";
import type {AccessManager, AutomationReceiver} from "../../typechain-types";
import {
    getLatestDeployment,
    loadDeployments,
    recordDeployment,
    saveDeployments,
} from "./lib/deployments";
import {verifyContract} from "./lib/verify";

interface VaultAutomationConfig {
    id: string;
    targets: string[];
}

interface CREAutomationConfig {
    accessManager: string;
    chainlinkAutomationRole: number;
    vaults: VaultAutomationConfig[];
}

const PERFORM_UPKEEP_SELECTOR = ethers.id("performUpkeep(bytes)").slice(0, 10);

function loadConfig(configPath: string): CREAutomationConfig {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as CREAutomationConfig;
    if (!ethers.isAddress(config.accessManager)) throw new Error("Invalid AccessManager address");
    if (!Number.isSafeInteger(config.chainlinkAutomationRole)) {
        throw new Error("Invalid CHAINLINK_AUTOMATION role ID");
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
    accessManager: AccessManager,
    vault: VaultAutomationConfig,
    roleId: number
): Promise<void> {
    const receiverAddress = await receiver.getAddress();
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
    const configPath = path.resolve(
        process.env.CRE_AUTOMATION_CONFIG ??
            path.join(__dirname, "config", `cre-automation.${network.name}.json`)
    );
    const config = loadConfig(configPath);
    const forwarder = process.env.CRE_FORWARDER_ADDRESS;
    const workflowOwner = process.env.CRE_WORKFLOW_OWNER;
    const [deployer] = await ethers.getSigners();

    console.log("=== CRE Automation Receivers ===");
    console.log("Network:", network.name);
    console.log("Config:", configPath);
    console.log("Deployer / receiver owner:", deployer.address);
    console.log("AccessManager:", config.accessManager);
    console.log("performUpkeep(bytes) selector:", PERFORM_UPKEEP_SELECTOR);
    for (const vault of config.vaults) {
        console.log(`${vault.id}: ${vault.targets.length} target(s)`);
        for (const target of vault.targets) console.log("  -", target);
    }

    if (planOnly) {
        console.log(
            "Plan only: no RPC reads, deployments, permissions, or report writes performed."
        );
        console.log("Required for deployment: CRE_FORWARDER_ADDRESS and CRE_WORKFLOW_OWNER.");
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

    if (!forwarder || !ethers.isAddress(forwarder)) {
        throw new Error("Set CRE_FORWARDER_ADDRESS to the canonical forwarder address");
    }
    if (!workflowOwner || !ethers.isAddress(workflowOwner)) {
        throw new Error("Set CRE_WORKFLOW_OWNER to the CRE workflow owner address");
    }

    const deployments = loadDeployments();
    const factory = await ethers.getContractFactory("AutomationReceiver", deployer);
    for (const vault of config.vaults) {
        const existing = getLatestDeployment(
            deployments,
            network.name,
            "AutomationReceiver",
            vault.id
        );
        let receiver: AutomationReceiver;
        if (existing && (await ethers.provider.getCode(existing.address)) !== "0x") {
            receiver = factory.attach(existing.address) as AutomationReceiver;
            console.log(`${vault.id}: reusing receiver ${existing.address}`);
        } else {
            receiver = await factory.deploy(deployer.address, forwarder, workflowOwner);
            await receiver.waitForDeployment();
            const address = await receiver.getAddress();
            const txHash = receiver.deploymentTransaction()?.hash;
            recordDeployment(
                deployments,
                network.name,
                "AutomationReceiver",
                {address, txHash, deployedAt: new Date().toISOString()},
                vault.id
            );
            saveDeployments(deployments);
            console.log(`${vault.id}: deployed receiver ${address}`);
        }

        await configureReceiver(receiver, accessManager, vault, config.chainlinkAutomationRole);
        console.log(`${vault.id}: call permissions and AccessManager role configured`);

        await verifyContract(await receiver.getAddress(), [
            deployer.address,
            forwarder,
            workflowOwner,
        ]);
    }

    console.log(
        "Workflow IDs are intentionally configured later, after final workflow hashes exist."
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
