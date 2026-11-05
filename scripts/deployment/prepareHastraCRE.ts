// Prepare Hastra CRE without requiring shared AccessManager administration.
import fs from "fs";
import path from "path";
import {spawnSync} from "child_process";
import {ethers, network} from "hardhat";
import {
    getLatestDeployment,
    loadDeployments,
    recordDeployment,
    saveDeployments,
} from "./lib/deployments";
import {hasCurrentRuntimeBytecode} from "./lib/creReceiverDeployment";
import {verifyContract} from "./lib/verify";
import {artifacts} from "hardhat";

async function main() {
    if (network.name !== "mainnet") throw new Error("Hastra preparation requires mainnet");
    const root = path.resolve(__dirname, "../..");
    const config = JSON.parse(
        fs.readFileSync(
            path.join(root, "scripts/deployment/config/mainnet-mezzanine-hastra.json"),
            "utf8"
        )
    );
    const identity = JSON.parse(
        fs.readFileSync(
            path.join(root, "scripts/deployment/config/cre-automation.mainnet.json"),
            "utf8"
        )
    );
    const deployments = loadDeployments();
    const latest = (key: string) => {
        const record = getLatestDeployment(deployments, "mainnet", key, config.deploymentId);
        if (!record) throw new Error(`Missing deployment ${key}`);
        return record.address;
    };
    const targets = [
        latest("NavOracleAutomation"),
        latest("UmbrellaEpochFinalizer.senior"),
        latest("UmbrellaEpochFinalizer.junior"),
    ];
    const selector = ethers.id("performUpkeep(bytes)").slice(0, 10);
    const [deployer] = await ethers.getSigners();
    if (deployer.address.toLowerCase() !== config.dev.deployer.toLowerCase())
        throw new Error("Unexpected deployer");
    const am = await ethers.getContractAt("AccessManager", identity.accessManager);
    if (!(await am.hasRole(0, config.roles.admin))[0])
        throw new Error("Client Safe lacks ADMIN_ROLE");
    for (const address of [identity.forwarder, ...targets]) {
        if ((await ethers.provider.getCode(address)) === "0x")
            throw new Error(`No bytecode at ${address}`);
    }
    // Client batch must already include the target selector mappings.
    const batchPath = path.join(root, "reports/safe-mainnet-mezzanine-hastra-setup.json");
    const batch = JSON.parse(fs.readFileSync(batchPath, "utf8"));
    if (
        batch.chainId !== "1" ||
        batch.meta.createdFromSafeAddress.toLowerCase() !== config.roles.admin.toLowerCase()
    )
        throw new Error("Unexpected Safe batch");
    for (const target of targets) {
        const expected = am.interface.encodeFunctionData("setTargetFunctionRole", [
            target,
            [selector],
            10,
        ]);
        if (
            !batch.transactions.some(
                (tx: {to: string; data: string}) =>
                    tx.to.toLowerCase() === identity.accessManager.toLowerCase() &&
                    tx.data === expected
            )
        ) {
            throw new Error(`Safe batch lacks automation selector mapping for ${target}`);
        }
    }
    const factory = await ethers.getContractFactory("AutomationReceiver", deployer);
    let record = getLatestDeployment(
        deployments,
        "mainnet",
        "AutomationReceiver",
        config.deploymentId
    );
    if (record) {
        const artifact = await artifacts.readArtifact("AutomationReceiver");
        if (
            !hasCurrentRuntimeBytecode(
                await ethers.provider.getCode(record.address),
                artifact.deployedBytecode
            )
        )
            throw new Error("Recorded receiver code mismatch");
    } else {
        console.log(
            "Deploying Hastra receiver; deployer balance:",
            ethers.formatEther(await ethers.provider.getBalance(deployer.address))
        );
        const deployed = await factory.deploy(
            deployer.address,
            identity.forwarder,
            identity.workflowOwner,
            identity.chainSelector
        );
        await deployed.waitForDeployment();
        const receipt = await deployed.deploymentTransaction()!.wait();
        record = recordDeployment(
            deployments,
            "mainnet",
            "AutomationReceiver",
            {
                address: await deployed.getAddress(),
                txHash: receipt!.hash,
                deployedAt: new Date().toISOString(),
                workflowIds: [],
            },
            config.deploymentId
        );
        saveDeployments(deployments);
        console.log("Receiver deployed:", record.address, "tx:", receipt!.hash);
    }
    const receiver = await ethers.getContractAt("AutomationReceiver", record.address, deployer);
    if ((await receiver.owner()).toLowerCase() !== deployer.address.toLowerCase())
        throw new Error("Receiver owner is not deployer; finish through client Safe");
    if (
        (await receiver.forwarder()).toLowerCase() !== identity.forwarder.toLowerCase() ||
        (await receiver.workflowOwner()).toLowerCase() !== identity.workflowOwner.toLowerCase() ||
        (await receiver.chainSelector()) !== BigInt(identity.chainSelector)
    )
        throw new Error("Receiver identity mismatch");
    const permissions = [];
    for (const [folder, name] of [
        ["nav-workflow", "nav-hastra"],
        ["finalization-workflow", "finalization-hastra"],
    ]) {
        const configPath = path.join(root, "cre", folder, "config.hastra.json");
        const workflowConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
        workflowConfig.vaults[0].receiver = record.address;
        fs.writeFileSync(configPath, JSON.stringify(workflowConfig, null, 4) + "\n");
        const result = spawnSync(
            process.env.CRE_CLI ?? "cre",
            [
                "-e",
                ".env",
                "workflow",
                "hash",
                `./${folder}`,
                "--target",
                "hastra-settings",
                "--non-interactive",
                "--verbose",
            ],
            {cwd: path.join(root, "cre"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}
        );
        if (result.status !== 0) throw new Error(`CRE hash failed for ${folder}`);
        const output = result.stdout + result.stderr;
        const hash = /Workflow hash:\s*([0-9a-fA-F]{64})/.exec(output)?.[1];
        const owner = /derivedWorkflowOwners[^\n]*?([0-9a-fA-F]{40})/.exec(output)?.[1];
        if (!hash || !owner || `0x${owner}`.toLowerCase() !== identity.workflowOwner.toLowerCase())
            throw new Error(`Cannot confirm workflow identity for ${folder}`);
        permissions.push({name, id: `0x${hash}`});
        console.log(name, `0x${hash}`);
    }
    for (const {id} of permissions) {
        if (!(await receiver.allowedWorkflowIds(id)))
            await (await receiver.setWorkflowPermission(id, true)).wait();
    }
    for (const target of targets) {
        if (!(await receiver.allowedCalls(target, selector)))
            await (await receiver.setCallPermission(target, selector, true)).wait();
    }
    record.workflowIds = permissions.map(({id}) => id);
    saveDeployments(deployments);
    const grantData = am.interface.encodeFunctionData("grantRole", [10, record.address, 0]);
    if (
        !batch.transactions.some(
            (tx: {to: string; data: string}) =>
                tx.to.toLowerCase() === identity.accessManager.toLowerCase() &&
                tx.data === grantData
        )
    ) {
        batch.transactions.push({
            to: identity.accessManager,
            value: "0",
            data: grantData,
            contractMethod: null,
            contractInputsValues: null,
        });
        batch.createdAt = Date.now();
        batch.meta.checksum = "";
        fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2) + "\n");
    }
    fs.writeFileSync(
        path.join(root, "scripts/deployment/config/cre-automation.hastra.json"),
        JSON.stringify(
            {
                ...identity,
                workflowPermissions: permissions,
                vaults: [{id: config.deploymentId, targets}],
            },
            null,
            4
        ) + "\n"
    );
    await verifyContract(record.address, [
        deployer.address,
        identity.forwarder,
        identity.workflowOwner,
        identity.chainSelector,
    ]);
    console.log("Receiver configured; Safe batch transactions:", batch.transactions.length);
    console.log("Client role grant and DON workflow activation remain pending.");
}
main().catch((error) => {
    // Child CLI output may contain sensitive environment diagnostics; print only its message.
    console.error(error instanceof Error ? error.message.split("\n")[0] : "CRE preparation failed");
    process.exitCode = 1;
});
