import {ethers, network, run} from "hardhat";
import {loadDeployments, saveDeployments, recordDeployment} from "./lib/deployments";

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

    if (netName === "mainnet") {
        throw new Error("MockUSDC must not be deployed on mainnet. Use the real USDC.");
    }

    console.log("=== Deploy MockUSDC ===");
    console.log("Network:", netName);
    console.log("Deployer:", deployer.address);

    const deployments = loadDeployments();

    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC", deployer);
    const mockUSDC = await MockUSDCFactory.deploy();
    const tx = mockUSDC.deploymentTransaction();
    await mockUSDC.waitForDeployment();
    const address = await mockUSDC.getAddress();

    console.log("MockUSDC deployed at:", address);

    recordDeployment(deployments, netName, "MockUSDC", {
        address,
        txHash: tx?.hash,
        deployedAt: new Date().toISOString(),
    });

    // Etherscan verification
    await verifyContract(address);

    saveDeployments(deployments);
    console.log("Deployments file updated");
    console.log("\nUpdate DEPLOY_INFO.sepolia.usdc to:", address);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
