import {ethers, network, upgrades} from "hardhat";
import type {Tranche} from "../../typechain-types";
import {
    getLatestDeployment,
    loadDeployments,
    recordDeployment,
    saveDeployments,
} from "./lib/deployments";
import {getArg, hasFlag, isLocalNetwork, requireAddress} from "./lib/helpers";
import {log, format} from "./lib/logger";
import {verifyContract} from "./lib/verify";

type TrancheKey = "mezzanine" | "junior";

interface Target {
    key: TrancheKey;
    deploymentKey: string;
    address: string;
    vault: string;
    directWithdrawEnabled: boolean;
    beforeImpl: string;
    afterImpl?: string;
    upgradeTxHash?: string;
}

function isEnvFlagEnabled(name: string): boolean {
    const raw = process.env[name];
    if (!raw) return false;
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

const UPGRADED_EVENT_TOPIC = ethers.id("Upgraded(address)");
const GET_LOGS_CHUNK_SIZE = 10;
const IMPL_WAIT_TIMEOUT_MS = 120_000;
const IMPL_POLL_INTERVAL_MS = 2_000;

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForImplementationChange(proxy: string, beforeImpl: string): Promise<string> {
    const before = beforeImpl.toLowerCase();
    const deadline = Date.now() + IMPL_WAIT_TIMEOUT_MS;
    let current = beforeImpl;

    while (Date.now() < deadline) {
        current = await upgrades.erc1967.getImplementationAddress(proxy);
        if (current.toLowerCase() !== before) {
            return current;
        }
        await sleep(IMPL_POLL_INTERVAL_MS);
    }

    return current;
}

async function findUpgradeTxHash(
    proxy: string,
    expectedImpl: string,
    fromBlock: number,
    toBlock: number
): Promise<string | undefined> {
    const expectedTopic = ethers.zeroPadValue(expectedImpl, 32).toLowerCase();
    let match: string | undefined;

    for (let start = fromBlock; start <= toBlock; start += GET_LOGS_CHUNK_SIZE + 1) {
        const end = Math.min(toBlock, start + GET_LOGS_CHUNK_SIZE);
        const logs = await ethers.provider.getLogs({
            address: proxy,
            fromBlock: start,
            toBlock: end,
            topics: [UPGRADED_EVENT_TOPIC],
        });

        for (const log of logs) {
            if (log.topics.length < 2) continue;
            if (log.topics[1].toLowerCase() !== expectedTopic) continue;
            match = log.transactionHash;
        }
    }

    return match;
}

function resolveTargetAddress(
    deploymentKey: string,
    explicitAddress: string | undefined,
    deployments: ReturnType<typeof loadDeployments>
): string {
    if (explicitAddress) {
        return requireAddress(explicitAddress, `${deploymentKey} proxy`);
    }

    const existing = getLatestDeployment(deployments, network.name, deploymentKey);
    if (!existing) {
        throw new Error(
            `No deployment record found for ${deploymentKey} on ${network.name}. Pass explicit address via CLI.`
        );
    }

    return requireAddress(existing.address, `${deploymentKey} proxy`);
}

function upgradeOptions(
    vault: string,
    directWithdrawEnabled: boolean
): {
    kind: "uups";
    unsafeAllow: ("constructor" | "state-variable-immutable")[];
    constructorArgs: [string, boolean];
} {
    return {
        kind: "uups",
        unsafeAllow: ["constructor", "state-variable-immutable"],
        constructorArgs: [vault, directWithdrawEnabled],
    };
}

async function loadTarget(
    key: TrancheKey,
    deploymentKey: string,
    explicitAddress: string | undefined,
    deployments: ReturnType<typeof loadDeployments>
): Promise<Target> {
    const address = resolveTargetAddress(deploymentKey, explicitAddress, deployments);
    const tranche = (await ethers.getContractAt("Tranche", address));
    const vault = await tranche.vault();
    const directWithdrawEnabled = await tranche.directWithdrawEnabled();
    const beforeImpl = await upgrades.erc1967.getImplementationAddress(address);

    return {
        key,
        deploymentKey,
        address,
        vault,
        directWithdrawEnabled,
        beforeImpl,
    };
}

async function main() {
    const validateOnly = hasFlag("--validate-only") || isEnvFlagEnabled("UPGRADE_VALIDATE_ONLY");
    const skipVerify = hasFlag("--skip-verify") || isEnvFlagEnabled("UPGRADE_SKIP_VERIFY");

    const deployments = loadDeployments();

    const mezzAddressArg =
        getArg("--mezz") ?? getArg("--mezzanine") ?? process.env.MEZZ_TRANCHE_PROXY;
    const juniorAddressArg =
        getArg("--junior") ?? getArg("--junior-tranche") ?? process.env.JUNIOR_TRANCHE_PROXY;

    const targets: Target[] = [];
    targets.push(await loadTarget("mezzanine", "Tranche.mezzanine", mezzAddressArg, deployments));
    targets.push(await loadTarget("junior", "Tranche.junior", juniorAddressArg, deployments));

    const [deployer] = await ethers.getSigners();
    const deployerAddress = await deployer.getAddress();

    log.step("Tranche upgrade preflight");
    log.info(`Network: ${network.name}`);
    log.info(`Deployer: ${format.addr(deployerAddress)}`);
    for (const target of targets) {
        log.info(
            `${target.deploymentKey}: ${format.addr(target.address)} | impl ${format.addr(target.beforeImpl)}`
        );
    }

    const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
    for (const target of targets) {
        log.step(`Validating ${target.deploymentKey}`);
        await upgrades.validateUpgrade(
            target.address,
            TrancheFactory,
            upgradeOptions(target.vault, target.directWithdrawEnabled)
        );
        log.success(`Validation passed for ${target.deploymentKey}`);
    }

    if (validateOnly) {
        log.success("Validation-only mode complete. No upgrades were executed.");
        return;
    }

    const shouldVerify = !skipVerify && !isLocalNetwork(network.name);
    const verifiedImplementations = new Set<string>();

    for (const target of targets) {
        log.step(`Upgrading ${target.deploymentKey}`);
        const startBlock = await ethers.provider.getBlockNumber();

        const upgraded = await upgrades.upgradeProxy(
            target.address,
            TrancheFactory,
            upgradeOptions(target.vault, target.directWithdrawEnabled)
        );
        await upgraded.waitForDeployment(); // ensures proxy contract object is ready; not sufficient for impl slot update timing

        target.afterImpl = await waitForImplementationChange(target.address, target.beforeImpl);
        const changed = target.afterImpl.toLowerCase() !== target.beforeImpl.toLowerCase();
        const endBlock = await ethers.provider.getBlockNumber();

        if (changed) {
            target.upgradeTxHash = await findUpgradeTxHash(
                target.address,
                target.afterImpl,
                startBlock,
                endBlock
            );
        }

        if (changed) {
            log.success(
                `${target.deploymentKey} upgraded: ${format.addr(target.beforeImpl)} -> ${format.addr(target.afterImpl)}`
            );
            if (target.upgradeTxHash) {
                log.info(`${target.deploymentKey} upgrade tx: ${target.upgradeTxHash}`);
            } else {
                log.warn(
                    `${target.deploymentKey} upgrade transaction hash was not found in scanned block range ${startBlock}-${endBlock}`
                );
            }
        } else {
            log.info(
                `${target.deploymentKey} already on latest implementation (no change): ${target.afterImpl}`
            );
        }

        recordDeployment(deployments, network.name, target.deploymentKey, {
            address: target.address,
            implementation: target.afterImpl,
            txHash: target.upgradeTxHash,
            deployedAt: new Date().toISOString(),
        });

        if (
            changed &&
            shouldVerify &&
            target.afterImpl &&
            !verifiedImplementations.has(target.afterImpl.toLowerCase())
        ) {
            await verifyContract(
                target.afterImpl,
                [target.vault, target.directWithdrawEnabled],
                true
            );
            verifiedImplementations.add(target.afterImpl.toLowerCase());
        }
    }

    saveDeployments(deployments);

    log.step("Upgrade summary");
    for (const target of targets) {
        log.info(
            `${target.deploymentKey}: ${format.addr(target.address)} | impl ${format.addr(target.afterImpl ?? target.beforeImpl)}`
        );
    }
    log.success("Mezzanine and junior tranche upgrade complete");
}

main().catch((error) => {
    log.error(error?.message ?? String(error));
    process.exitCode = 1;
});
