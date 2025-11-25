import { ethers, network, run } from "hardhat";
import {
  loadDeployments,
  saveDeployments,
  recordDeployment,
} from "./utils/deployments";
import { DEPLOY_INFO } from "./deployInfo";

async function verifyContract(
  address: string,
  constructorArguments: any[] = []
) {
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
    console.log(
      "Verification failed or already verified:",
      error?.message ?? error
    );
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const netName = network.name;

  const info = DEPLOY_INFO[netName];
  if (!info) {
    throw new Error(`DeployInfo not found for network: ${netName}`);
  }

  console.log("=== Deploy AccessManager ===");
  console.log("Network:", netName);
  console.log("Deployer:", deployer.address);

  const admin = info.accessManagerAdmin;
  console.log("Admin (AccessManager):", admin);

  const deployments = loadDeployments();

  const AccessManagerFactory = await ethers.getContractFactory(
    "AccessManager",
    deployer
  );
  const accessManager = await AccessManagerFactory.deploy(admin);
  const tx = accessManager.deploymentTransaction();
  await accessManager.waitForDeployment();
  const address = await accessManager.getAddress();

  console.log("AccessManager deployed at:", address);

  recordDeployment(deployments, netName, "AccessManager", {
    address,
    txHash: tx?.hash,
    deployedAt: new Date().toISOString(),
  });

  // Etherscan verification
  await verifyContract(address, [admin]);

  saveDeployments(deployments);
  console.log("Deployments file updated");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
