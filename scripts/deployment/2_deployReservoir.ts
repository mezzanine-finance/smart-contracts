import {ethers, upgrades, network, run} from "hardhat";
import {
    loadDeployments,
    saveDeployments,
    recordDeployment,
    getLatestDeployment,
} from "./utils/deployments";
import {DEPLOY_INFO} from "./deployInfo";

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

    const info = DEPLOY_INFO[netName];
    if (!info) {
        throw new Error(`DeployInfo not found for network: ${netName}`);
    }

    console.log("=== Deploy ReservoirUSDC (UUPS proxy) ===");
    console.log("Network:", netName);
    console.log("Deployer:", deployer.address);

    const deployments = loadDeployments();

    const usdcAddress = info.usdc;
    const accessManagerRecord = getLatestDeployment(deployments, netName, "AccessManager");
    const pauseManagerRecord = getLatestDeployment(deployments, netName, "PauseManager");
    const accessManagerAddress = accessManagerRecord?.address;
    const pauseManagerAddress = pauseManagerRecord?.address;

    if (!accessManagerAddress) {
        throw new Error("AccessManager not deployed for this network. Deploy it first.");
    }
    if (!pauseManagerAddress) {
        throw new Error("PauseManager not deployed for this network. Deploy it first.");
    }

    console.log("USDC:", usdcAddress);
    console.log("AccessManager:", accessManagerAddress);
    console.log("PauseManager:", pauseManagerAddress);

    upgrades.silenceWarnings();

    const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
    const reservoir = await upgrades.deployProxy(
        ReservoirFactory,
        [accessManagerAddress, pauseManagerAddress],
        {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [usdcAddress],
        }
    );

    const tx = reservoir.deploymentTransaction();
    await reservoir.waitForDeployment();

    const proxyAddress = await reservoir.getAddress();
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log("ReservoirUSDC proxy deployed at:", proxyAddress);
    console.log("ReservoirUSDC implementation:", implAddress);

    recordDeployment(deployments, netName, "ReservoirUSDC", {
        address: proxyAddress,
        implementation: implAddress,
        txHash: tx?.hash,
        deployedAt: new Date().toISOString(),
    });

    // Verify implementation
    await verifyContract(implAddress, [usdcAddress]);

    saveDeployments(deployments);
    console.log("Deployments file updated");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
