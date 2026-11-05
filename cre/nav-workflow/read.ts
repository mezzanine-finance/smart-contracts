// Reads upkeep readiness and calldata from the latest on-chain state.
import {
    bytesToHex,
    encodeCallMsg,
    EVMClient,
    LATEST_BLOCK_NUMBER,
    type Runtime,
} from "@chainlink/cre-sdk";
import {decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex} from "viem";
import type {Config} from "./config";
import {CHECK_UPKEEP_ABI} from "./contracts";

export interface UpkeepState {
    upkeepNeeded: boolean;
    performData: Hex;
}

export const readUpkeep = (
    runtime: Runtime<Config>,
    evmClient: EVMClient,
    target: Address
): UpkeepState => {
    const response = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: target,
                data: encodeFunctionData({
                    abi: CHECK_UPKEEP_ABI,
                    functionName: "checkUpkeep",
                    args: ["0x"],
                }),
            }),
            // Observe completed upkeep immediately instead of waiting for finality.
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result();
    const [upkeepNeeded, performData] = decodeFunctionResult({
        abi: CHECK_UPKEEP_ABI,
        functionName: "checkUpkeep",
        data: bytesToHex(response.data),
    });
    return {upkeepNeeded, performData};
};
