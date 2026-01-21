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

    console.log("=== Deploy Vault (UUPS proxy) ===");
    console.log("Network:", netName);
    console.log("Deployer:", deployer.address);

    const deployments = loadDeployments();

    const usdcAddress = info.usdc;
    const performanceFeeReceiver = info.performanceFeeReceiver;
    const protocolFeeReceiver = info.protocolFeeReceiver;
    const performanceFeeBps = info.performanceFeeBps;
    const protocolFeeBps = info.protocolFeeBps;

    const accessManagerRecord = getLatestDeployment(deployments, netName, "AccessManager");
    const pauseManagerRecord = getLatestDeployment(deployments, netName, "PauseManager");
    const reservoirRecord = getLatestDeployment(deployments, netName, "ReservoirUSDC");

    const accessManagerAddress = accessManagerRecord?.address;
    const pauseManagerAddress = pauseManagerRecord?.address;
    const reservoirAddress = reservoirRecord?.address;

    if (!accessManagerAddress) {
        throw new Error("AccessManager not deployed for this network. Deploy it first.");
    }
    if (!pauseManagerAddress) {
        throw new Error("PauseManager not deployed for this network. Deploy it first.");
    }
    if (!reservoirAddress) {
        throw new Error("ReservoirUSDC not deployed for this network. Deploy it first.");
    }

    console.log("USDC:", usdcAddress);
    console.log("AccessManager:", accessManagerAddress);
    console.log("PauseManager:", pauseManagerAddress);
    console.log("ReservoirUSDC:", reservoirAddress);
    console.log("Performance fee receiver:", performanceFeeReceiver);
    console.log("Protocol fee receiver:", protocolFeeReceiver);
    console.log("Performance fee bps:", performanceFeeBps);
    console.log("Protocol fee bps:", protocolFeeBps);

    upgrades.silenceWarnings();

    const VaultFactory = await ethers.getContractFactory("Vault", deployer);
    const vault = await upgrades.deployProxy(
        VaultFactory,
        [
            reservoirAddress,
            accessManagerAddress,
            pauseManagerAddress,
            performanceFeeBps,
            performanceFeeReceiver,
            protocolFeeBps,
            protocolFeeReceiver,
        ],
        {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [usdcAddress],
        }
    );
    const tx = vault.deploymentTransaction();
    await vault.waitForDeployment();

    const vaultAddress = await vault.getAddress();
    const vaultImpl = await upgrades.erc1967.getImplementationAddress(vaultAddress);

    console.log("Vault proxy deployed at:", vaultAddress);
    console.log("Vault implementation:", vaultImpl);

    recordDeployment(deployments, netName, "Vault", {
        address: vaultAddress,
        implementation: vaultImpl,
        txHash: tx?.hash,
        deployedAt: new Date().toISOString(),
    });

    // Verify implementation
    await verifyContract(vaultImpl, [usdcAddress]);

    // Summary block for easy copy-paste
    const rpcConfig = network.config as {url?: string | string[]; chainId?: number};
    const rpcUrl =
        typeof rpcConfig.url === "string"
            ? rpcConfig.url
            : Array.isArray(rpcConfig.url)
              ? rpcConfig.url[0]
              : "unknown";
    const explorer =
        hre.config.etherscan?.customChains?.find((c) => c.network === netName)?.urls?.browserURL ??
        "unknown";
    const faucetUrl =
        (rpcUrl && typeof rpcUrl === "string" && rpcUrl.includes("buildbear")) ||
        netName === "buildbear"
            ? "https://faucet.buildbear.io/overall-electro-86c210d9"
            : undefined;

    const summaryLines = [
        `New deployment on ${netName}`,
        "Network settings:",
        `- RPC: ${rpcUrl}`,
        `- Chain ID: ${rpcConfig.chainId ?? "unknown"}`,
        `- Explorer: ${explorer}`,
        ...(faucetUrl ? [`- Faucet: ${faucetUrl} (mint test ETH and USDC here)`] : []),
        `\nSmart contract addresses:`,
        `USDC: ${usdcAddress}`,
        `ReservoirUSDC (proxy): ${reservoirAddress}`,
        `Vault (proxy): ${vaultAddress}`,
        `AccessManager: ${accessManagerAddress}`,
        `PauseManager: ${pauseManagerAddress}`,
        "---",
        `ReservoirUSDC implementation: ${reservoirRecord?.implementation ?? "unknown"}`,
        `Vault implementation: ${vaultImpl}`,
    ];
    console.log("\n" + summaryLines.join("\n") + "\n");

    saveDeployments(deployments);
    console.log("\nDeployments file updated");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
