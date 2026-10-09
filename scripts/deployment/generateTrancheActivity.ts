import {ethers, network} from "hardhat";
import {ContractTransactionResponse, formatUnits, parseUnits} from "ethers";
import {IERC20, IssuanceVault, MZUSD, NavOracleAutomation, Tranche} from "../../typechain-types";
import {getLatestDeployment, loadDeployments} from "./lib/deployments";

type Phase = "status" | "activity" | "advance";

interface VaultStack {
    namespace: "vault-1" | "vault-2";
    mzusd: MZUSD;
    vault: IssuanceVault;
    navOracle: NavOracleAutomation;
    senior: Tranche;
    junior: Tranche;
    seniorDirect: boolean;
}

const SENIOR_DEPOSIT = parseUnits("100", 18);
const JUNIOR_DEPOSIT = parseUnits("20", 18);
const USDC_PER_VAULT = parseUnits("120", 6);

function readPhase(): Phase {
    const phase = (process.env.PHASE ?? "status") as Phase;
    if (!(["status", "activity", "advance"] as const).includes(phase)) {
        throw new Error(`Unsupported PHASE=${phase}; use status, activity, or advance`);
    }
    return phase;
}

function deploymentAddress(
    deployments: ReturnType<typeof loadDeployments>,
    namespace: string,
    key: string
): string {
    const deployment = getLatestDeployment(deployments, network.name, key, namespace);
    if (!deployment) throw new Error(`${namespace}.${key} deployment not found on ${network.name}`);
    return deployment.address;
}

async function waitFor(
    label: string,
    txPromise: Promise<ContractTransactionResponse>
): Promise<void> {
    const tx = await txPromise;
    console.log(`${label}: ${tx.hash}`);
    await tx.wait();
}

async function loadStacks(): Promise<{
    stacks: VaultStack[];
    usdc: IERC20;
}> {
    const deployments = loadDeployments();
    const [signer] = await ethers.getSigners();
    const sharedUsdc = deploymentAddress(deployments, "shared", "MockUSDC");
    const usdc = await ethers.getContractAt("IERC20", sharedUsdc, signer);

    const stacks: VaultStack[] = [];
    for (const [namespace, seniorDirect] of [
        ["vault-1", false],
        ["vault-2", true],
    ] as const) {
        stacks.push({
            namespace,
            mzusd: await ethers.getContractAt(
                "MZUSD",
                deploymentAddress(deployments, namespace, "MZUSD"),
                signer
            ),
            vault: await ethers.getContractAt(
                "IssuanceVault",
                deploymentAddress(deployments, namespace, "IssuanceVault"),
                signer
            ),
            navOracle: await ethers.getContractAt(
                "NavOracleAutomation",
                deploymentAddress(deployments, namespace, "NavOracleAutomation"),
                signer
            ),
            senior: await ethers.getContractAt(
                "Tranche",
                deploymentAddress(deployments, namespace, "Tranche.senior"),
                signer
            ),
            junior: await ethers.getContractAt(
                "Tranche",
                deploymentAddress(deployments, namespace, "Tranche.junior"),
                signer
            ),
            seniorDirect,
        });
    }

    return {stacks, usdc};
}

async function printStatus(
    stacks: VaultStack[],
    usdc: IERC20,
    signerAddress: string
): Promise<void> {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("Latest block not found");

    console.log("\n=== Tranche activity status ===");
    console.log(`Network: ${network.name}`);
    console.log(`Signer: ${signerAddress}`);
    console.log(`Timestamp: ${block.timestamp}`);
    console.log(`MockUSDC balance: ${formatUnits(await usdc.balanceOf(signerAddress), 6)}`);

    for (const stack of stacks) {
        const [epochId, epochStart, epochDuration] = await stack.vault.getEpochConfig();
        const canAdvance = BigInt(block.timestamp) >= epochStart + epochDuration;
        console.log(`\n${stack.namespace}`);
        console.log(`  MZUSD: ${await stack.mzusd.getAddress()}`);
        console.log(`  Vault: ${await stack.vault.getAddress()}`);
        console.log(`  epoch: ${epochId}, can advance: ${canAdvance}`);
        console.log(
            `  MZUSD balance: ${formatUnits(await stack.mzusd.balanceOf(signerAddress), 18)}`
        );
        console.log(
            `  senior shares: ${formatUnits(await stack.senior.balanceOf(signerAddress), await stack.senior.decimals())}`
        );
        console.log(
            `  junior shares: ${formatUnits(await stack.junior.balanceOf(signerAddress), await stack.junior.decimals())}`
        );
        console.log(
            `  senior maxDeposit: ${formatUnits(await stack.senior.maxDeposit(signerAddress), 18)} MZUSD`
        );
        console.log(
            `  junior maxDeposit: ${formatUnits(await stack.junior.maxDeposit(signerAddress), 18)} MZUSD`
        );
    }
}

async function generateActivity(
    stacks: VaultStack[],
    usdc: IERC20,
    signerAddress: string
): Promise<void> {
    const requiredUSDC = USDC_PER_VAULT * BigInt(stacks.length);
    const usdcBalance = await usdc.balanceOf(signerAddress);
    if (usdcBalance < requiredUSDC) {
        throw new Error(
            `Insufficient MockUSDC: need ${formatUnits(requiredUSDC, 6)}, have ${formatUnits(usdcBalance, 6)}`
        );
    }

    for (const stack of stacks) {
        console.log(`\n=== ${stack.namespace}: deposits and withdrawals ===`);
        const mzusdAddress = await stack.mzusd.getAddress();

        if ((await usdc.allowance(signerAddress, mzusdAddress)) < USDC_PER_VAULT) {
            await waitFor(
                `${stack.namespace} approve MockUSDC`,
                usdc.approve(mzusdAddress, USDC_PER_VAULT)
            );
        }
        await waitFor(
            `${stack.namespace} deposit MockUSDC into MZUSD`,
            stack.mzusd.deposit(USDC_PER_VAULT)
        );

        for (const [name, tranche, assets] of [
            ["senior", stack.senior, SENIOR_DEPOSIT],
            ["junior", stack.junior, JUNIOR_DEPOSIT],
        ] as const) {
            const trancheAddress = await tranche.getAddress();
            const maxDeposit = await tranche.maxDeposit(signerAddress);
            if (maxDeposit < assets) {
                throw new Error(
                    `${stack.namespace}.${name} maxDeposit ${formatUnits(maxDeposit, 18)} is below ${formatUnits(assets, 18)}`
                );
            }
            if ((await stack.mzusd.allowance(signerAddress, trancheAddress)) < assets) {
                await waitFor(
                    `${stack.namespace}.${name} approve MZUSD`,
                    stack.mzusd.approve(trancheAddress, assets)
                );
            }
            await waitFor(
                `${stack.namespace}.${name} deposit`,
                tranche.deposit(assets, signerAddress)
            );
        }

        const seniorShares = await stack.senior.balanceOf(signerAddress);
        const juniorShares = await stack.junior.balanceOf(signerAddress);
        const seniorRequest = seniorShares / 2n;
        const juniorRequest = juniorShares / 2n;

        if (seniorRequest === 0n || juniorRequest === 0n) {
            throw new Error(`${stack.namespace}: zero withdrawal request calculated`);
        }

        const mzusdBeforeSenior = await stack.mzusd.balanceOf(signerAddress);
        await waitFor(
            `${stack.namespace}.senior request 50% withdrawal`,
            stack.senior.requestWithdrawal(seniorRequest)
        );

        if (stack.seniorDirect) {
            const mzusdAfterSenior = await stack.mzusd.balanceOf(signerAddress);
            const receivedMZUSD = mzusdAfterSenior - mzusdBeforeSenior;
            const redeemableMZUSD = (receivedMZUSD / 10n ** 12n) * 10n ** 12n;
            if (redeemableMZUSD > 0n) {
                await waitFor(
                    `${stack.namespace}.senior redeem returned MZUSD to MockUSDC`,
                    stack.mzusd.requestWithdrawal(redeemableMZUSD)
                );
            }
        }

        await waitFor(
            `${stack.namespace}.junior request 50% withdrawal`,
            stack.junior.requestWithdrawal(juniorRequest)
        );
    }
}

async function advanceEpochs(stacks: VaultStack[]): Promise<void> {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("Latest block not found");

    for (const stack of stacks) {
        const [epochId, epochStart, epochDuration] = await stack.vault.getEpochConfig();
        if (BigInt(block.timestamp) < epochStart + epochDuration) {
            throw new Error(`${stack.namespace}: epoch ${epochId} is not ready to advance`);
        }
        await stack.navOracle.submitNav.staticCall();
        await waitFor(
            `${stack.namespace} submit mock NAV and advance epoch ${epochId}`,
            stack.navOracle.submitNav()
        );
    }
}

async function main(): Promise<void> {
    const phase = readPhase();
    const [signer] = await ethers.getSigners();
    const signerAddress = await signer.getAddress();
    const {stacks, usdc} = await loadStacks();

    if (phase === "status") {
        await printStatus(stacks, usdc, signerAddress);
        return;
    }
    if (phase === "activity") {
        await generateActivity(stacks, usdc, signerAddress);
        await printStatus(stacks, usdc, signerAddress);
        return;
    }

    await advanceEpochs(stacks);
    await printStatus(stacks, usdc, signerAddress);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
