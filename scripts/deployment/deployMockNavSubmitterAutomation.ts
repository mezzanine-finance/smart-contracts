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
    const vault = readArg("vault") ?? process.env.VAULT;
    if (!vault || !ethers.isAddress(vault)) {
        throw new Error("Vault address is required. Pass --vault 0x... or set VAULT env var.");
    }

    const [deployer] = await ethers.getSigners();

    console.log("=== Deploy MockNavSubmitterAutomation ===");
    console.log("Network:", network.name);
    console.log("Deployer:", deployer.address);
    console.log("Vault:", vault);

    const Factory = await ethers.getContractFactory("MockNavSubmitterAutomation", deployer);
    const contract = await Factory.deploy(vault);
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    const txHash = contract.deploymentTransaction()?.hash;

    console.log("MockNavSubmitterAutomation deployed at:", address);
    console.log("Deployment tx:", txHash);
    console.log(
        "Next: grant ORACLE_ROLE on NavOracleAutomation.submitNav(uint256) to this address in AccessManager"
    );
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
