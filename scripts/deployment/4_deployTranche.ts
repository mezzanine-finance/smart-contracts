import {ethers, upgrades, network, run} from "hardhat";
import {
    loadDeployments,
    saveDeployments,
    recordDeployment,
    getLatestDeployment,
} from "./utils/deployments";
import {DEPLOY_INFO} from "./deployInfo";

const VAULT_ROLE = 2n;

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
    const mzusdRecord = getLatestDeployment(deployments, netName, "MZUSD");
    const vaultRecord = getLatestDeployment(deployments, netName, "Vault");

    const accessManagerAddress = accessManagerRecord?.address;
    const mzusdAddress = mzusdRecord?.address;
    const vaultAddress = vaultRecord?.address;

    if (!accessManagerAddress) {
        throw new Error("AccessManager not deployed for this network. Deploy it first.");
    }
    if (!mzusdAddress) {
        throw new Error("MZUSD not deployed for this network. Deploy it first.");
    }
    if (!vaultAddress) {
        throw new Error("Vault not deployed for this network. Deploy it first.");
    }

    const trancheInfo = info.tranche;
    console.log("AccessManager:", accessManagerAddress);
    console.log("MZUSD:", mzusdAddress);
    console.log("Vault:", vaultAddress);
    console.log("Tranche:", trancheInfo.name, trancheInfo.symbol, "#", trancheInfo.id);

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
            trancheInfo.polJuniorMode,
            trancheInfo.polPayout,
        ],
        {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor"],
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

    console.log("\nConfiguring AccessManager roles...");
    const accessManager = await ethers.getContractAt(
        "AccessManager",
        accessManagerAddress,
        deployer
    );
    const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
    const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();

    const vault = await ethers.getContractAt("Vault", vaultAddress, deployer);

    const addTrancheSelector = vault.interface.getFunction("addTranche").selector;
    const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;

    const txVaultRoles = await accessManager.setTargetFunctionRole(
        vaultAddress,
        [addTrancheSelector, distributeYieldSelector],
        ADMIN_ROLE
    );
    await txVaultRoles.wait();
    console.log("setTargetFunctionRole for Vault.addTranche/distributeYield done");

    const depositSelector = TrancheFactory.interface.getFunction("deposit")!.selector;
    const requestWithdrawalSelector =
        TrancheFactory.interface.getFunction("requestWithdrawal")!.selector;
    const cancelUnstakeSelector = TrancheFactory.interface.getFunction("cancelUnstake")!.selector;
    const claimSelector = TrancheFactory.interface.getFunction("claim")!.selector;
    const withdrawSelector = TrancheFactory.interface.getFunction("withdraw")!.selector;
    const redeemSelector = TrancheFactory.interface.getFunction("redeem")!.selector;

    const txPublicRoles = await accessManager.setTargetFunctionRole(
        proxyAddress,
        [
            depositSelector,
            requestWithdrawalSelector,
            cancelUnstakeSelector,
            claimSelector,
            withdrawSelector,
            redeemSelector,
        ],
        PUBLIC_ROLE
    );
    await txPublicRoles.wait();
    console.log("setTargetFunctionRole for Tranche user functions -> PUBLIC_ROLE done");

    const mzusd = await ethers.getContractAt("MZUSD", mzusdAddress, deployer);
    const mintSelector = mzusd.interface.getFunction("mint").selector;
    const txMintRole = await accessManager.setTargetFunctionRole(
        mzusdAddress,
        [mintSelector],
        VAULT_ROLE
    );
    await txMintRole.wait();
    console.log("setTargetFunctionRole for MZUSD.mint -> VAULT_ROLE done");

    const notifySelector = TrancheFactory.interface.getFunction("notifyYield")!.selector;
    const txNotifyRole = await accessManager.setTargetFunctionRole(
        proxyAddress,
        [notifySelector],
        VAULT_ROLE
    );
    await txNotifyRole.wait();
    console.log("setTargetFunctionRole for Tranche.notifyYield -> VAULT_ROLE done");

    const txGrantRole = await accessManager.grantRole(
        VAULT_ROLE,
        vaultAddress,
        0 // executionDelay
    );
    await txGrantRole.wait();
    console.log("grantRole(VAULT_ROLE, Vault) done");

    console.log("\nRegistering tranche in Vault...");
    const txAdd = await vault.addTranche({
        tranche: proxyAddress,
        weightBps: trancheInfo.weightBps,
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
