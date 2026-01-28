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
    if (!info.tranche) {
        throw new Error(`Tranche deploy info not found for network: ${netName}`);
    }

    console.log("=== Deploy Tranche (UUPS proxy) ===");
    console.log("Network:", netName);
    console.log("Deployer:", deployer.address);

    const deployments = loadDeployments();

    const accessManagerRecord = getLatestDeployment(deployments, netName, "AccessManager");
    const pauseManagerRecord = getLatestDeployment(deployments, netName, "PauseManager");
    const mzusdRecord = getLatestDeployment(deployments, netName, "MZUSD");
    const vaultRecord = getLatestDeployment(deployments, netName, "Vault");

    const accessManagerAddress = accessManagerRecord?.address;
    const pauseManagerAddress = pauseManagerRecord?.address;
    const mzusdAddress = mzusdRecord?.address;
    const vaultAddress = vaultRecord?.address;

    if (!accessManagerAddress) {
        throw new Error("AccessManager not deployed for this network. Deploy it first.");
    }
    if (!pauseManagerAddress) {
        throw new Error("PauseManager not deployed for this network. Deploy it first.");
    }
    if (!mzusdAddress) {
        throw new Error("MZUSD not deployed for this network. Deploy it first.");
    }
    if (!vaultAddress) {
        throw new Error("Vault not deployed for this network. Deploy it first.");
    }

    const trancheInfo = info.tranche;
    console.log("AccessManager:", accessManagerAddress);
    console.log("PauseManager:", pauseManagerAddress);
    console.log("MZUSD:", mzusdAddress);
    console.log("Vault:", vaultAddress);
    console.log("Tranche:", trancheInfo.name, trancheInfo.symbol, "#", trancheInfo.id);
    console.log("Direct deposit enabled: ", trancheInfo.directWithdrawalMode);

    upgrades.silenceWarnings();

    const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
    const tranche = await upgrades.deployProxy(
        TrancheFactory,
        [
            mzusdAddress,
            vaultAddress,
            trancheInfo.id,
            trancheInfo.unstakeDelayEpochs,
            trancheInfo.name,
            trancheInfo.symbol,
            accessManagerAddress,
            pauseManagerAddress,
        ],
        {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [trancheInfo.directWithdrawalMode],
            redeployImplementation: "always",
        }
    );
    const tx = tranche.deploymentTransaction();
    await tranche.waitForDeployment();

    const proxyAddress = await tranche.getAddress();
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log("Tranche proxy deployed at:", proxyAddress);
    console.log("Tranche implementation:", implAddress);

    recordDeployment(deployments, netName, "Tranche", {
        address: proxyAddress,
        implementation: implAddress,
        txHash: tx?.hash,
        deployedAt: new Date().toISOString(),
    });

    const vault = await ethers.getContractAt("Vault", vaultAddress, deployer);
    console.log("\nRegistering tranche in Vault...");
    const txAdd = await vault.addTranche({
        tranche: proxyAddress,
        weight: trancheInfo.weight,
        enabled: trancheInfo.enabled,
    });
    await txAdd.wait();
    console.log("Vault.addTranche done");

    await verifyContract(implAddress, []);

    saveDeployments(deployments);
    console.log("Deployments file updated");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
