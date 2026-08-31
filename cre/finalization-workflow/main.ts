import {
    bytesToHex,
    CronCapability,
    encodeCallMsg,
    EVMClient,
    getNetwork,
    handler,
    LAST_FINALIZED_BLOCK_NUMBER,
    prepareReportRequest,
    Runner,
    TxStatus,
    type Runtime,
} from "@chainlink/cre-sdk";
import {
    decodeFunctionResult,
    encodeAbiParameters,
    encodeFunctionData,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import {z} from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const RECEIVER_EXECUTION_SUCCESS = 0;

export const configSchema = z.object({
    schedule: z.string().min(1),
    chainName: z.string().min(1),
    isTestnet: z.boolean(),
    gasLimit: z.string().regex(/^[1-9][0-9]*$/),
    vaults: z.array(
        z.object({
            id: z.string().min(1),
            issuanceVault: addressSchema,
            receiver: addressSchema.optional(),
            finalizers: z.array(
                z.object({
                    tranche: z.enum(["senior", "junior"]),
                    address: addressSchema,
                })
            ),
        })
    ),
});

export type Config = z.infer<typeof configSchema>;

export interface UpkeepReadiness {
    vaultId: string;
    tranche: "senior" | "junior";
    target: Address;
    upkeepNeeded: boolean;
    performData: Hex;
    writeAttempted?: boolean;
    txStatus?: number;
    error?: string;
}

export const CHECK_UPKEEP_ABI = [
    {
        type: "function",
        name: "checkUpkeep",
        stateMutability: "view",
        inputs: [{name: "checkData", type: "bytes"}],
        outputs: [
            {name: "upkeepNeeded", type: "bool"},
            {name: "performData", type: "bytes"},
        ],
    },
] as const;

export const PERFORM_UPKEEP_ABI = [
    {
        type: "function",
        name: "performUpkeep",
        stateMutability: "nonpayable",
        inputs: [{name: "performData", type: "bytes"}],
        outputs: [],
    },
] as const;

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export const onCronTrigger = (runtime: Runtime<Config>): UpkeepReadiness[] => {
    const {chainName, isTestnet, gasLimit, vaults} = runtime.config;
    const network = getNetwork({
        chainFamily: "evm",
        chainSelectorName: chainName,
        isTestnet,
    });

    if (!network) throw new Error(`Unsupported EVM network: ${chainName}`);

    const evmClient = new EVMClient(network.chainSelector.selector);
    const callData = encodeFunctionData({
        abi: CHECK_UPKEEP_ABI,
        functionName: "checkUpkeep",
        args: ["0x"],
    });

    return vaults.flatMap(({id, receiver, finalizers}) =>
        finalizers.map(({tranche, address}) => {
            const target = address as Address;
            let upkeepNeeded: boolean;
            let performData: Hex;

            try {
                const response = evmClient
                    .callContract(runtime, {
                        call: encodeCallMsg({
                            from: zeroAddress,
                            to: target,
                            data: callData,
                        }),
                        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
                    })
                    .result();
                [upkeepNeeded, performData] = decodeFunctionResult({
                    abi: CHECK_UPKEEP_ABI,
                    functionName: "checkUpkeep",
                    data: bytesToHex(response.data),
                });
            } catch (error) {
                const message = errorMessage(error);
                runtime.log(`Finalizer ${id}/${tranche} (${target}) failed: ${message}`);
                return {
                    vaultId: id,
                    tranche,
                    target,
                    upkeepNeeded: false,
                    performData: "0x" as Hex,
                    error: message,
                };
            }

            runtime.log(`Finalizer ${id}/${tranche} (${target}): upkeepNeeded=${upkeepNeeded}`);
            const readiness = {vaultId: id, tranche, target, upkeepNeeded, performData};
            if (!upkeepNeeded) return readiness;

            let writeAttempted = false;
            try {
                if (!receiver) throw new Error(`Receiver is not configured for ${id}`);
                const performCallData = encodeFunctionData({
                    abi: PERFORM_UPKEEP_ABI,
                    functionName: "performUpkeep",
                    args: [performData],
                });
                const reportPayload = encodeAbiParameters(
                    [{type: "address"}, {type: "bytes"}],
                    [target, performCallData]
                );
                const report = runtime.report(prepareReportRequest(reportPayload)).result();
                writeAttempted = true;
                const reply = evmClient
                    .writeReport(runtime, {
                        receiver,
                        report,
                        gasConfig: {gasLimit},
                    })
                    .result();

                if (reply.txStatus !== TxStatus.SUCCESS) {
                    throw new Error(
                        `writeReport transaction failed with status ${reply.txStatus}: ${reply.errorMessage ?? "no error message"}`
                    );
                }
                if (
                    reply.receiverContractExecutionStatus !== undefined &&
                    Number(reply.receiverContractExecutionStatus) !== RECEIVER_EXECUTION_SUCCESS
                ) {
                    throw new Error(
                        `Receiver execution failed with status ${reply.receiverContractExecutionStatus}`
                    );
                }

                runtime.log(`Finalizer ${id}/${tranche} (${target}): txStatus=${reply.txStatus}`);
                return {...readiness, writeAttempted, txStatus: reply.txStatus};
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

export async function main() {
    const runner = await Runner.newRunner<Config>({configSchema});
    await runner.run(initWorkflow);
}
