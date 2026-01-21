import {ethers, upgrades, network, run} from "hardhat";
import {
    loadDeployments,
    saveDeployments,
    recordDeployment,
    getLatestDeployment,
} from "./utils/deployments";

async function verifyContract(address: string, constructorArguments: any[] = []) {
    if (network.name === "hardhat") {
        console.log("Skipping verification on hardhat network");
        return;
    }

    try {
        console.log(`Verifying contract at ${address}...`);
        await run("verify:verify", {
            address,
            constructorArguments,
        });
        console.log("Verification successful ✅");
    } catch (error: any) {
        console.log("Verification failed or already verified:", error?.message ?? error);
    }
}

async function main() {
    const [deployer] = await ethers.getSigners();
    const netName = network.name;

    console.log("=== Deploy PauseManager (UUPS proxy) ===");
    console.log("Network:", netName);
    console.log("Deployer:", deployer.address);

    const deployments = loadDeployments();

    const accessManagerRecord = getLatestDeployment(deployments, netName, "AccessManager");
    const accessManagerAddress = accessManagerRecord?.address;

    if (!accessManagerAddress) {
        throw new Error("AccessManager not deployed for this network. Deploy it first.");
    }

    console.log("AccessManager:", accessManagerAddress);

    upgrades.silenceWarnings();

    const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
    const pauseManager = await upgrades.deployProxy(PauseManagerFactory, [accessManagerAddress], {
        kind: "uups",
        initializer: "initialize",
    });

    const tx = pauseManager.deploymentTransaction();
    await pauseManager.waitForDeployment();

    const proxyAddress = await pauseManager.getAddress();
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log("PauseManager proxy deployed at:", proxyAddress);
    console.log("PauseManager implementation:", implAddress);

    recordDeployment(deployments, netName, "PauseManager", {
        address: proxyAddress,
        implementation: implAddress,
        txHash: tx?.hash,
        deployedAt: new Date().toISOString(),
    });

    await verifyContract(implAddress, []);

    saveDeployments(deployments);
    console.log("Deployments file updated");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
