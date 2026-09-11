// Coordinates cron-triggered checks and independent writes for configured targets.
import {
    CronCapability,
    EVMClient,
    getNetwork,
    handler,
    type CronPayload,
    type Runtime,
} from "@chainlink/cre-sdk";
import {type Address, type Hex} from "viem";
import type {Config} from "./config";
import {readUpkeep} from "./read";
import {writeUpkeepReport} from "./write";

export interface UpkeepReadiness {
    vaultId: string;
    tranche: string;
    target: Address;
    upkeepNeeded: boolean;
    performData: Hex;
    writeAttempted?: boolean;
    txStatus?: number;
    receiverExecutionStatus?: number;
    txHash?: Hex;
    writeOutcome?: "SUCCESS" | "FAILED" | "UNCONFIRMED";
    error?: string;
}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

// Bind replay protection to the scheduled run, not each node's local clock.
const scheduledExecutionTime = (trigger: CronPayload): bigint => {
    const seconds = trigger.scheduledExecutionTime?.seconds;
    if (seconds === undefined || seconds <= 0n || seconds > 0xffffffffffffffffn) {
        throw new Error("Cron scheduled execution time is missing or invalid");
    }
    return seconds;
};

// Catch failures per target so one failed call does not prevent the remaining work.
export const onCronTrigger = (
    runtime: Runtime<Config>,
    trigger: CronPayload
): UpkeepReadiness[] => {
    const {chainName, isTestnet, gasLimit, vaults} = runtime.config;
    const network = getNetwork({chainFamily: "evm", chainSelectorName: chainName, isTestnet});
    if (!network) throw new Error(`Unsupported EVM network: ${chainName}`);
    const evmClient = new EVMClient(network.chainSelector.selector);
    const scheduledAt = scheduledExecutionTime(trigger);

    return vaults.flatMap(({id, receiver, finalizers}) =>
        finalizers.map(({tranche, address}) => {
            const target = address as Address;
            let readiness: UpkeepReadiness;
            try {
                const state = readUpkeep(runtime, evmClient, target);
                runtime.log(
                    `Finalizer ${id}/${tranche} (${target}): upkeepNeeded=${state.upkeepNeeded}`
                );
                readiness = {vaultId: id, tranche, target, ...state};
            } catch (error) {
                const message = errorMessage(error);
                runtime.log(`Finalizer ${id}/${tranche} (${target}) failed: ${message}`);
                return {
                    vaultId: id,
                    tranche,
                    target,
                    upkeepNeeded: false,
                    performData: "0x",
                    error: message,
                };
            }
            if (!readiness.upkeepNeeded) return readiness;

            let writeAttempted = false;
            try {
                if (!receiver) throw new Error(`Receiver is not configured for ${id}`);
                writeAttempted = true;
                const writeResult = writeUpkeepReport(
                    runtime,
                    evmClient,
                    receiver as Address,
                    target,
                    readiness.performData,
                    gasLimit,
                    network.chainSelector.selector,
                    scheduledAt
                );
                const writeOutcome =
                    writeResult.receiverExecutionStatus === undefined ? "UNCONFIRMED" : "SUCCESS";
                runtime.log(
                    `[${writeOutcome}] Finalizer ${id}/${tranche}: receiver=${receiver}, target=${target}, action=performUpkeep(bytes), txStatus=${writeResult.txStatus}, receiverExecutionStatus=${writeResult.receiverExecutionStatus ?? "not returned"}, txHash=${writeResult.txHash ?? "not broadcast"}`
                );
                return {...readiness, writeAttempted, ...writeResult, writeOutcome};
            } catch (error) {
                const message = errorMessage(error);
                runtime.log(
                    `[FAILED] Finalizer ${id}/${tranche} (${target}) write failed: ${message}`
                );
                return {...readiness, writeAttempted, writeOutcome: "FAILED", error: message};
            }
        })
    );
};

export const initWorkflow = (config: Config) => {
    const cron = new CronCapability();
    return [handler(cron.trigger({schedule: config.schedule}), onCronTrigger)];
};
