import hre, {network} from "hardhat";
import {getLatestDeployment, loadDeployments} from "./utils/deployments";
import {DEPLOY_INFO} from "./deployInfo";

function formatAddress(label: string, address?: string) {
    return `${label}: ${address ?? "unknown"}`;
}

function main() {
    const netName = network.name;

    const info = DEPLOY_INFO[netName];
    if (!info) {
        throw new Error(`DeployInfo not found for network: ${netName}`);
    }

    const deployments = loadDeployments();

    const accessManagerRecord = getLatestDeployment(deployments, netName, "AccessManager");
    const mzusdRecord = getLatestDeployment(deployments, netName, "MZUSD");
    const reservoirRecord = getLatestDeployment(deployments, netName, "ReservoirUSDC");
    const vaultRecord = getLatestDeployment(deployments, netName, "Vault");
    const trancheRecord = getLatestDeployment(deployments, netName, "Tranche");

    const rpcConfig = network.config as {url?: string | string[]; chainId?: number};
    const rpcUrl =
        typeof rpcConfig.url === "string"
            ? rpcConfig.url
            : Array.isArray(rpcConfig.url)
              ? rpcConfig.url[0]
              : "unknown";
    const explorer =
        hre.config.etherscan?.customChains?.find((c) => c.network === netName)?.urls?.browserURL ??
        "";

    const summaryLines = [
        `Deployment summary for ${netName}`,
        "Network settings:",
        `- RPC: ${rpcUrl}`,
        `- Chain ID: ${rpcConfig.chainId ?? "unknown"}`,
        `- Explorer: ${explorer || "unknown"}`,
        `\nSmart contract addresses:`,
        formatAddress("AccessManager", accessManagerRecord?.address),
        formatAddress("MZUSD (proxy)", mzusdRecord?.address),
        formatAddress("ReservoirUSDC (proxy)", reservoirRecord?.address),
        formatAddress("Vault (proxy)", vaultRecord?.address),
        formatAddress("Tranche (proxy)", trancheRecord?.address),
        "---",
        formatAddress("MZUSD implementation", mzusdRecord?.implementation),
        formatAddress("ReservoirUSDC implementation", reservoirRecord?.implementation),
        formatAddress("Vault implementation", vaultRecord?.implementation),
        formatAddress("Tranche implementation", trancheRecord?.implementation),
    ];

    console.log("\n" + summaryLines.join("\n") + "\n");
    console.log("Done ✅");
}

try {
    main();
} catch (err) {
    console.error(err);
    process.exitCode = 1;
}
