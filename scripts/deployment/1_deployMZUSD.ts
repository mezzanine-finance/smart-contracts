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
    const accessManagerAddress = accessManagerRecord?.address;

    if (!accessManagerAddress) {
        throw new Error("AccessManager not deployed for this network. Deploy it first.");
    }

    const hourlyCapHuman = info.mzusdHourlyCap;
    const hourlyCapUSDC = parseUnits(hourlyCapHuman, 6);

    console.log("USDC:", usdcAddress);
    console.log("AccessManager:", accessManagerAddress);
    console.log("Hourly cap (USDC):", hourlyCapHuman);

    upgrades.silenceWarnings();

    const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
    const mzusd = await upgrades.deployProxy(
        MZUSDFactory,
        [accessManagerAddress, usdcAddress, hourlyCapUSDC],
        {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor"],
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

    console.log("\nConfiguring AccessManager roles for MZUSD (PUBLIC_ROLE)...");
    const accessManager = await ethers.getContractAt(
        "AccessManager",
        accessManagerAddress,
        deployer
    );
    const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();

    const depositSelector = MZUSDFactory.interface.getFunction("deposit")!.selector;
    const requestWithdrawalSelector =
        MZUSDFactory.interface.getFunction("requestWithdrawal")!.selector;

    const txSetPublicRole = await accessManager.setTargetFunctionRole(
        proxyAddress,
        [depositSelector, requestWithdrawalSelector],
        PUBLIC_ROLE
    );
    await txSetPublicRole.wait();
    console.log("setTargetFunctionRole for deposit/requestWithdrawal -> PUBLIC_ROLE done");

    // Verify implementation (proxy verification is optional)
    await verifyContract(implAddress);

    saveDeployments(deployments);
    console.log("Deployments file updated");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
