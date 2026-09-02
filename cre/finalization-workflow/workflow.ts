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
    tranche: "senior" | "junior";
    target: Address;
    upkeepNeeded: boolean;
    performData: Hex;
    writeAttempted?: boolean;
    txStatus?: number;
    receiverExecutionStatus?: number;
    txHash?: Hex;
    error?: string;
}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const scheduledExecutionTime = (trigger: CronPayload): bigint => {
    const seconds = trigger.scheduledExecutionTime?.seconds;
    if (seconds === undefined || seconds <= 0n || seconds > 0xffffffffffffffffn) {
        throw new Error("Cron scheduled execution time is missing or invalid");
    }
    return seconds;
};

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
                runtime.log(
                    `Finalizer ${id}/${tranche}: receiver=${receiver}, target=${target}, action=performUpkeep(bytes), txStatus=${writeResult.txStatus}, receiverExecutionStatus=${writeResult.receiverExecutionStatus ?? "not returned"}, txHash=${writeResult.txHash ?? "not broadcast"}`
                );
                return {...readiness, writeAttempted, ...writeResult};
            } catch (error) {
                const message = errorMessage(error);
                runtime.log(`Finalizer ${id}/${tranche} (${target}) write failed: ${message}`);
                return {...readiness, writeAttempted, error: message};
            }
        })
    );
};

export const initWorkflow = (config: Config) => {
    const cron = new CronCapability();
    return [handler(cron.trigger({schedule: config.schedule}), onCronTrigger)];
};
