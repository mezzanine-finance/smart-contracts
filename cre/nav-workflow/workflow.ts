import {CronCapability, EVMClient, getNetwork, handler, type Runtime} from "@chainlink/cre-sdk";
import {type Address, type Hex} from "viem";
import type {Config} from "./config";
import {readUpkeep} from "./read";
import {writeUpkeepReport} from "./write";

export interface UpkeepReadiness {
    vaultId: string;
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

export const onCronTrigger = (runtime: Runtime<Config>): UpkeepReadiness[] => {
    const {chainName, isTestnet, gasLimit, vaults} = runtime.config;
    const network = getNetwork({chainFamily: "evm", chainSelectorName: chainName, isTestnet});
    if (!network) throw new Error(`Unsupported EVM network: ${chainName}`);
    const evmClient = new EVMClient(network.chainSelector.selector);

    return vaults.map(({id, navOracleAutomation, receiver}) => {
        const target = navOracleAutomation as Address;
        let readiness: UpkeepReadiness;
        try {
            const state = readUpkeep(runtime, evmClient, target);
            runtime.log(`NAV target ${id} (${target}): upkeepNeeded=${state.upkeepNeeded}`);
            readiness = {vaultId: id, target, ...state};
        } catch (error) {
            const message = errorMessage(error);
            runtime.log(`NAV target ${id} (${target}) failed: ${message}`);
            return {vaultId: id, target, upkeepNeeded: false, performData: "0x", error: message};
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
                gasLimit
            );
            runtime.log(
                `NAV target ${id}: receiver=${receiver}, target=${target}, action=performUpkeep(bytes), txStatus=${writeResult.txStatus}, receiverExecutionStatus=${writeResult.receiverExecutionStatus ?? "not returned"}, txHash=${writeResult.txHash ?? "not broadcast"}`
            );
            return {...readiness, writeAttempted, ...writeResult};
        } catch (error) {
            const message = errorMessage(error);
            runtime.log(`NAV target ${id} (${target}) write failed: ${message}`);
            return {...readiness, writeAttempted, error: message};
        }
    });
};

export const initWorkflow = (config: Config) => {
    const cron = new CronCapability();
    return [handler(cron.trigger({schedule: config.schedule}), onCronTrigger)];
};
