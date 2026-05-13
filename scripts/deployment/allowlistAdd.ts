import {ethers, network} from "hardhat";
import {getArg} from "./lib/helpers";
import {loadConfig} from "./lib/config";
import {getLatestDeployment, loadDeployments} from "./lib/deployments";
import {log, format} from "./lib/logger";

async function main() {
    const account = process.env.ACCOUNT;
    if (!account || !ethers.isAddress(account)) {
        throw new Error("Usage: --account <address>");
    }

    const deployments = loadDeployments();

    const allowlistDeployment = getLatestDeployment(deployments, network.name, "Allowlist");
    if (!allowlistDeployment) {
        throw new Error("Allowlist deployment not found for this network");
    }

    const [signer] = await ethers.getSigners();
    const signerAddress = await signer.getAddress();

    log.step("Allowlist add");
    log.info(`Network: ${network.name}`);
    log.info(`Signer: ${format.addr(signerAddress)}`);
    log.info(`Allowlist: ${format.addr(allowlistDeployment.address)}`);
    log.info(`Account: ${format.addr(account)}`);

    const allowlist = await ethers.getContractAt("Allowlist", allowlistDeployment.address, signer);

    if (await allowlist.isAllowlisted(account)) {
        log.info("Account is already allowlisted");
        return;
    }

    const tx = await allowlist.add(account);
    await tx.wait();
    log.success(`Added ${format.addr(account)} to allowlist`);
}

main().catch((err) => {
    log.error(err?.message ?? err);
    process.exitCode = 1;
});
