import {
    bytesToHex,
    CronCapability,
    encodeCallMsg,
    EVMClient,
    getNetwork,
    handler,
    LAST_FINALIZED_BLOCK_NUMBER,
    Runner,
    type Runtime,
} from "@chainlink/cre-sdk";
import {decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex} from "viem";
import {z} from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export const configSchema = z.object({
    schedule: z.string().min(1),
    chainName: z.string().min(1),
    isTestnet: z.boolean(),
    vaults: z.array(
        z.object({
            id: z.string().min(1),
            issuanceVault: addressSchema,
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

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export const onCronTrigger = (runtime: Runtime<Config>): UpkeepReadiness[] => {
    const {chainName, isTestnet, vaults} = runtime.config;
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

    return vaults.flatMap(({id, finalizers}) =>
        finalizers.map(({tranche, address}) => {
            const target = address as Address;

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
                const [upkeepNeeded, performData] = decodeFunctionResult({
                    abi: CHECK_UPKEEP_ABI,
                    functionName: "checkUpkeep",
                    data: bytesToHex(response.data),
                });

                runtime.log(`Finalizer ${id}/${tranche} (${target}): upkeepNeeded=${upkeepNeeded}`);
                return {vaultId: id, tranche, target, upkeepNeeded, performData};
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
