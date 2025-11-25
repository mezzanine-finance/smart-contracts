import { ethers, upgrades, network, run } from "hardhat";
import {
  loadDeployments,
  saveDeployments,
  recordDeployment,
  getLatestDeployment,
} from "./utils/deployments";
import { DEPLOY_INFO } from "./deployInfo";

const VAULT_WITHDRAW_ROLE = 1n;

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

  console.log("=== Deploy Vault (UUPS proxy) ===");
  console.log("Network:", netName);
  console.log("Deployer:", deployer.address);

  const deployments = loadDeployments();

  const usdcAddress = info.usdc;

  const accessManagerRecord = getLatestDeployment(
    deployments,
    netName,
    "AccessManager"
  );
  const mzusdRecord = getLatestDeployment(deployments, netName, "MZUSD");
  const reservoirRecord = getLatestDeployment(
    deployments,
    netName,
    "ReservoirUSDC"
  );

  const accessManagerAddress = accessManagerRecord?.address;
  const mzusdAddress = mzusdRecord?.address;
  const reservoirAddress = reservoirRecord?.address;

  if (!accessManagerAddress) {
    throw new Error(
      "AccessManager not deployed for this network. Deploy it first."
    );
  }
  if (!mzusdAddress) {
    throw new Error("MZUSD not deployed for this network. Deploy it first.");
  }
  if (!reservoirAddress) {
    throw new Error(
      "ReservoirUSDC not deployed for this network. Deploy it first."
    );
  }

  console.log("USDC:", usdcAddress);
  console.log("AccessManager:", accessManagerAddress);
  console.log("MZUSD:", mzusdAddress);
  console.log("ReservoirUSDC:", reservoirAddress);

  upgrades.silenceWarnings();

  const VaultFactory = await ethers.getContractFactory("Vault", deployer);
  const vault = await upgrades.deployProxy(
    VaultFactory,
    [usdcAddress, mzusdAddress, reservoirAddress, accessManagerAddress],
    {
      kind: "uups",
      initializer: "initialize",
      unsafeAllow: ["constructor"],
    }
  );
  const tx = vault.deploymentTransaction();
  await vault.waitForDeployment();

  const vaultAddress = await vault.getAddress();
  const vaultImpl =
    await upgrades.erc1967.getImplementationAddress(vaultAddress);

  console.log("Vault proxy deployed at:", vaultAddress);
  console.log("Vault implementation:", vaultImpl);

  recordDeployment(deployments, netName, "Vault", {
    address: vaultAddress,
    implementation: vaultImpl,
    txHash: tx?.hash,
    deployedAt: new Date().toISOString(),
  });

  // Wiring MZUSD <-> Vault
  console.log("\nWiring MZUSD.setVault(vault)...");
  const mzusd = await ethers.getContractAt("MZUSD", mzusdAddress, deployer);
  const txSetVault = await mzusd.setVault(vaultAddress);
  await txSetVault.wait();
  console.log("MZUSD.vault =", vaultAddress);

  // AccessManager rights: Vault.withdraw -> VAULT_WITHDRAW_ROLE -> MZUSD
  console.log("\nConfiguring AccessManager roles...");
  const accessManager = await ethers.getContractAt(
    "AccessManager",
    accessManagerAddress,
    deployer
  );

  const withdrawSelector =
    VaultFactory.interface.getFunction("withdraw")!.selector;

  const txTargetRole = await accessManager.setTargetFunctionRole(
    vaultAddress,
    [withdrawSelector],
    VAULT_WITHDRAW_ROLE
  );
  await txTargetRole.wait();
  console.log("setTargetFunctionRole for Vault.withdraw done");

  const txGrantRole = await accessManager.grantRole(
    VAULT_WITHDRAW_ROLE,
    mzusdAddress,
    0 // executionDelay
  );
  await txGrantRole.wait();
  console.log("grantRole(VAULT_WITHDRAW_ROLE, MZUSD) done");

  // Verify implementation
  await verifyContract(vaultImpl);

  saveDeployments(deployments);
  console.log("\nDeployments file updated");
  console.log("Done ✅");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
