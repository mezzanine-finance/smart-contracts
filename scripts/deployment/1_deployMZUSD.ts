import {ethers, upgrades, network, run} from "hardhat";
import {parseUnits} from "ethers";
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

    console.log("=== Deploy MZUSD (UUPS proxy) ===");
    console.log("Network:", netName);
    console.log("Deployer:", deployer.address);

    const deployments = loadDeployments();

    const usdcAddress = info.usdc;
    const accessManagerRecord = getLatestDeployment(deployments, netName, "AccessManager");
    const pauseManagerRecord = getLatestDeployment(deployments, netName, "PauseManager");
    const vaultRecord = getLatestDeployment(deployments, netName, "Vault");
    const lossManagerRecord = getLatestDeployment(deployments, netName, "LossManager");
    const accessManagerAddress = accessManagerRecord?.address;
    const pauseManagerAddress = pauseManagerRecord?.address;
    const vaultAddress = vaultRecord?.address;

    if (!accessManagerAddress) {
        throw new Error("AccessManager not deployed for this network. Deploy it first.");
    }
    if (!pauseManagerAddress) {
        throw new Error("PauseManager not deployed for this network. Deploy it first.");
    }
    if (!vaultAddress) {
        throw new Error("Vault not deployed for this network. Deploy it first.");
    }

    const redemptionCapHuman = info.mzusdRedemptionCap;
    const redemptionCapUSDC = parseUnits(redemptionCapHuman, 6);

    console.log("USDC:", usdcAddress);
    console.log("AccessManager:", accessManagerAddress);
    console.log("PauseManager:", pauseManagerAddress);
    console.log("Vault:", vaultAddress);
    console.log("LossManager:", lossManagerRecord?.address ?? "not deployed");
    console.log("Redemption cap (USDC):", redemptionCapHuman);

    upgrades.silenceWarnings();

    const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
    const mzusd = await upgrades.deployProxy(
        MZUSDFactory,
        [accessManagerAddress, pauseManagerAddress, redemptionCapUSDC],
        {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [usdcAddress, vaultAddress],
        }
    );
    const tx = mzusd.deploymentTransaction();
    await mzusd.waitForDeployment();

    const proxyAddress = await mzusd.getAddress();
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log("MZUSD proxy deployed at:", proxyAddress);
    console.log("MZUSD implementation:", implAddress);

    recordDeployment(deployments, netName, "MZUSD", {
        address: proxyAddress,
        implementation: implAddress,
        txHash: tx?.hash,
        deployedAt: new Date().toISOString(),
    });

    // Verify implementation (proxy verification is optional)
    // Wire Vault -> MZUSD
    const vault = await ethers.getContractAt("Vault", vaultAddress, deployer);
    const currentMZUSD = await vault.mzusd();
    if (currentMZUSD === ethers.ZeroAddress) {
        const txSetMZUSD = await vault.setMZUSD(proxyAddress);
        await txSetMZUSD.wait();
        console.log("Vault.mzusd =", proxyAddress);
    } else {
        console.log("Vault.mzusd already set:", currentMZUSD);
    }

    const lossManagerAddress = lossManagerRecord?.address;
    if (lossManagerAddress) {
        const currentLossManager = await mzusd.lossManager();
        if (currentLossManager === ethers.ZeroAddress) {
            const txSetLossManager = await mzusd.setLossManager(lossManagerAddress);
            await txSetLossManager.wait();
            console.log("MZUSD.lossManager =", lossManagerAddress);
        } else {
            console.log("MZUSD.lossManager already set:", currentLossManager);
        }
    }

    await verifyContract(implAddress, [usdcAddress, vaultAddress]);

    saveDeployments(deployments);
    console.log("Deployments file updated");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
