import {ethers, network} from "hardhat";

function readArg(name: string): string | undefined {
    const pref = `--${name}=`;
    for (const arg of process.argv) {
        if (arg.startsWith(pref)) return arg.slice(pref.length);
    }

    const idx = process.argv.findIndex((a) => a === `--${name}`);
    if (idx >= 0 && idx + 1 < process.argv.length) {
        return process.argv[idx + 1];
    }

    return undefined;
}

async function main() {
    const mzusd = readArg("mzusd") ?? process.env.mzUSD;
    if (!mzusd || !ethers.isAddress(mzusd)) {
        throw new Error("mzUSD address is required. Pass --mzusd 0x... or set mzUSD env var.");
    }

    const [deployer] = await ethers.getSigners();

    console.log("Network:", network.name);
    console.log("Deployer:", deployer.address);
    console.log("mzUSD:", mzusd);

    console.log("=== Deploy Mock NAV Oracle ===");
    const Factory = await ethers.getContractFactory("MockNavOracle", deployer);
    const mockNavOracle = await Factory.deploy(mzusd);
    await mockNavOracle.waitForDeployment();

    let address = await mockNavOracle.getAddress();
    let txHash = mockNavOracle.deploymentTransaction()?.hash;

    console.log("MockNavOracle deployed at:", address);
    console.log("Deployment tx:", txHash);

    console.log("=== Deploy Mock Total Supply ===");

    const Factory1 = await ethers.getContractFactory("MockTotalSupplyOracle", deployer);
    const mockTotalSupplyOracle = await Factory1.deploy(mzusd);
    await mockTotalSupplyOracle.waitForDeployment();

    address = await mockTotalSupplyOracle.getAddress();
    txHash = mockTotalSupplyOracle.deploymentTransaction()?.hash;

    console.log("MockTotalSupplyOracle deployed at:", address);
    console.log("Deployment tx:", txHash);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
