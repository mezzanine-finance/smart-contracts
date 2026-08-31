import {EVMClient, prepareReportRequest, TxStatus, type Runtime} from "@chainlink/cre-sdk";
import {encodeAbiParameters, encodeFunctionData, type Address, type Hex} from "viem";
import type {Config} from "./config";
import {PERFORM_UPKEEP_ABI} from "./contracts";

const RECEIVER_EXECUTION_SUCCESS = 0;

export const writeUpkeepReport = (
    runtime: Runtime<Config>,
    evmClient: EVMClient,
    receiver: Address,
    target: Address,
    performData: Hex,
    gasLimit: string
): number => {
    const callData = encodeFunctionData({
        abi: PERFORM_UPKEEP_ABI,
        functionName: "performUpkeep",
        args: [performData],
    });
    const payload = encodeAbiParameters([{type: "address"}, {type: "bytes"}], [target, callData]);
    const report = runtime.report(prepareReportRequest(payload)).result();
    const reply = evmClient
        .writeReport(runtime, {receiver, report, gasConfig: {gasLimit}})
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
    return reply.txStatus;
};
