import {ethers, network} from "hardhat";
import {parseUnits, formatUnits} from "ethers";
import {getLatestDeployment, loadDeployments} from "./lib/deployments";
import {log, format} from "./lib/logger";

async function main() {
    const rawAmount = process.env.AMOUNT;
    if (!rawAmount) {
        throw new Error("Set AMOUNT env var (USDC units, e.g. AMOUNT=1000)");
    }
    const amountUSDC = parseUnits(rawAmount, 6);

    const deployments = loadDeployments();

    const mzusdDeployment = getLatestDeployment(deployments, network.name, "MZUSD");
    if (!mzusdDeployment) {
        throw new Error("MZUSD deployment not found for this network");
    }

    const [signer] = await ethers.getSigners();
    const signerAddress = await signer.getAddress();

    const mzusd = await ethers.getContractAt("MZUSD", mzusdDeployment.address, signer);
    const usdcAddress = await mzusd.usdc();
    const usdc = await ethers.getContractAt("IERC20", usdcAddress, signer);

    const balance = await usdc.balanceOf(signerAddress);

    log.step("MZUSD deposit");
    log.info(`Network: ${network.name}`);
    log.info(`Signer: ${format.addr(signerAddress)}`);
    log.info(`MZUSD: ${format.addr(mzusdDeployment.address)}`);
    log.info(`USDC: ${format.addr(usdcAddress)}`);
    log.info(`Amount: ${formatUnits(amountUSDC, 6)} USDC`);
    log.info(`Balance: ${formatUnits(balance, 6)} USDC`);

    if (balance < amountUSDC) {
        throw new Error(
            `Insufficient USDC balance: need ${formatUnits(amountUSDC, 6)}, have ${formatUnits(balance, 6)}`
        );
    }

    const allowance = await usdc.allowance(signerAddress, mzusdDeployment.address);
    if (allowance < amountUSDC) {
        log.step("Approving USDC");
        const tx = await usdc.approve(mzusdDeployment.address, amountUSDC);
        await tx.wait();
        log.success(`Approved ${formatUnits(amountUSDC, 6)} USDC to MZUSD`);
    }

    log.step("Depositing");
    const tx = await mzusd.deposit(amountUSDC);
    await tx.wait();
    log.success(`Deposited ${formatUnits(amountUSDC, 6)} USDC into MZUSD`);
}

main().catch((err) => {
    log.error(err?.message ?? err);
    process.exitCode = 1;
});
