/// <reference types="bun" />

import {describe, expect} from "bun:test";
import {bytesToHex, getNetwork, hexToBase64, type CronPayload} from "@chainlink/cre-sdk";
import {
    addContractMock,
    EvmMock,
    newTestRuntime,
    REPORT_METADATA_HEADER_LENGTH,
    test,
} from "@chainlink/cre-sdk/test";
import {decodeAbiParameters, decodeFunctionData, type Address, type Hex} from "viem";
import {configSchema, type Config} from "./config";
import {CHECK_UPKEEP_ABI, PERFORM_UPKEEP_ABI} from "./contracts";
import {initWorkflow, onCronTrigger, WorkflowExecutionError} from "./workflow";
import productionConfig from "./config.production.json";
import stagingConfig from "./config.staging.json";

describe("NAV workflow", () => {
    const failedTxHash: Hex = `0x${"ab".repeat(32)}`;
    const scheduledAt = 1_800_000_000n;
    const cronPayload = () =>
        ({scheduledExecutionTime: {seconds: scheduledAt, nanos: 0}}) as CronPayload;
    const config = configSchema.parse(stagingConfig);
    const receivers = [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
    ] as const;
    const configWithReceivers: Config = {
        ...config,
        vaults: config.vaults.map((vault, index) => ({
            ...vault,
            receiver: receivers[index],
        })),
    };
    const configWithoutReceivers: Config = {
        ...config,
        vaults: config.vaults.map(({receiver: _receiver, ...vault}) => vault),
    };

    const setup = (runtimeConfig: Config = config) => {
        const network = getNetwork({
            chainFamily: "evm",
            chainSelectorName: runtimeConfig.chainName,
            isTestnet: runtimeConfig.isTestnet,
        });
        if (!network) throw new Error("Sepolia network is unavailable in the SDK");

        return {
            runtime: newTestRuntime<Config>(null, undefined, runtimeConfig),
            evmMock: EvmMock.testInstance(network.chainSelector.selector),
        };
    };

    const failedResults = (runtime: ReturnType<typeof setup>["runtime"]) => {
        try {
            onCronTrigger(runtime, cronPayload());
        } catch (error) {
            expect(error).toBeInstanceOf(WorkflowExecutionError);
            if (!(error instanceof WorkflowExecutionError)) throw error;
            expect(error.message).toContain("workflow failed for");
            for (const result of error.results.filter((result) => result.error !== undefined)) {
                expect(error.message).toContain(result.target);
                if (result.txHash) {
                    expect(error.message).toContain(result.txHash);
                    const failureLog = runtime
                        .getLogs()
                        .find((log) => log.includes("[FAILED]") && log.includes(result.target));
                    expect(failureLog).toContain(`txHash=${result.txHash}`);
                    expect(failureLog).toContain(`txStatus=${result.txStatus}`);
                    if (result.receiverExecutionStatus !== undefined)
                        expect(failureLog).toContain(
                            `receiverExecutionStatus=${result.receiverExecutionStatus}`
                        );
                }
            }
            return error.results;
        }
        throw new Error("Expected the workflow to fail after processing all targets");
    };

    const reportPayload = (rawReport: Uint8Array): Hex => {
        const report = bytesToHex(rawReport);
        return `0x${report.slice(2 + REPORT_METADATA_HEADER_LENGTH * 2)}`;
    };

    test("registers its cron schedule", () => {
        const config: Config = stagingConfig;
        const handlers = initWorkflow(config);

        expect(handlers).toHaveLength(1);
        expect(config.schedule).toBe("0 */5 * * * *");
        expect(config.gasLimit).toBe("500000");
    });

    test("requires deterministic cron execution time", () => {
        const {runtime} = setup(configWithReceivers);

        expect(() => onCronTrigger(runtime, {} as CronPayload)).toThrow(
            "Cron scheduled execution time is missing or invalid"
        );
    });

    test("configures valid and unique Sepolia vaults", () => {
        const parsedConfig = configSchema.parse(stagingConfig);
        const vaultIds = parsedConfig.vaults.map(({id}) => id);

        expect(parsedConfig.chainName).toBe("ethereum-testnet-sepolia");
        expect(parsedConfig.isTestnet).toBe(true);
        expect(new Set(vaultIds).size).toBe(vaultIds.length);
        parsedConfig.vaults.forEach(({issuanceVault, navOracleAutomation, receiver}) => {
            expect(issuanceVault).not.toBe("0x0000000000000000000000000000000000000000");
            expect(navOracleAutomation).not.toBe("0x0000000000000000000000000000000000000000");
            expect(receiver).toBeDefined();
            expect(receiver).not.toBe("0x0000000000000000000000000000000000000000");
        });
    });

    test("configures valid mainnet targets", () => {
        expect(productionConfig.chainName).toBe("ethereum-mainnet");
        expect(productionConfig.isTestnet).toBe(false);
        expect(productionConfig.vaults.length).toBeGreaterThan(0);
        expect(configSchema.parse(productionConfig)).toEqual(productionConfig);
    });

    test("reports readiness and preserves performData for every target", () => {
        const {runtime, evmMock} = setup(configWithReceivers);
        const [vault1, vault2] = configWithReceivers.vaults;
        const target1 = addContractMock(evmMock, {
            address: vault1.navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });
        const target2 = addContractMock(evmMock, {
            address: vault2.navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });

        target1.checkUpkeep = () => [false, "0x"];
        target2.checkUpkeep = () => [true, "0x1234"];
        const receiver = addContractMock(evmMock, {
            address: vault2.receiver as Address,
            abi: [],
        });
        receiver.writeReport = () => ({txStatus: "TX_STATUS_SUCCESS"});

        expect(onCronTrigger(runtime, cronPayload())).toEqual([
            {
                vaultId: "vault-1",
                target: vault1.navOracleAutomation as Address,
                upkeepNeeded: false,
                performData: "0x",
            },
            {
                vaultId: "vault-2",
                target: vault2.navOracleAutomation as Address,
                upkeepNeeded: true,
                performData: "0x1234",
                writeAttempted: true,
                txStatus: 2,
                writeOutcome: "UNCONFIRMED",
            },
        ]);
    });

    test("writes one receiver report per ready vault with performUpkeep calldata", () => {
        const {runtime, evmMock} = setup(configWithReceivers);
        const writes: {receiver: Address; payload: Hex; gasLimit: bigint}[] = [];

        configWithReceivers.vaults.forEach((vault) => {
            const target = addContractMock(evmMock, {
                address: vault.navOracleAutomation as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            target.checkUpkeep = () => [true, "0x1234"];

            const receiver = addContractMock(evmMock, {
                address: vault.receiver as Address,
                abi: [],
            });
            receiver.writeReport = ({report, gasConfig}) => {
                writes.push({
                    receiver: vault.receiver as Address,
                    payload: reportPayload(report.rawReport),
                    gasLimit: gasConfig.gasLimit,
                });
                return {
                    txStatus: "TX_STATUS_SUCCESS",
                    receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS",
                    txHash: "EjQ=",
                };
            };
        });

        const results = onCronTrigger(runtime, cronPayload());

        expect(writes).toHaveLength(2);
        expect(results.every((result) => result.txStatus === 2)).toBe(true);
        expect(
            results.every(
                (result) =>
                    result.receiverExecutionStatus === 0 &&
                    result.txHash === "0x1234" &&
                    result.writeOutcome === "SUCCESS"
            )
        ).toBe(true);
        writes.forEach((write, index) => {
            const [target, callData, chainSelector, reportScheduledAt] = decodeAbiParameters(
                [{type: "address"}, {type: "bytes"}, {type: "uint64"}, {type: "uint64"}],
                write.payload
            );
            const decodedCall = decodeFunctionData({
                abi: PERFORM_UPKEEP_ABI,
                data: callData,
            });

            expect(write.receiver).toBe(receivers[index]);
            expect(write.gasLimit).toBe(500000n);
            expect(target).toBe(configWithReceivers.vaults[index].navOracleAutomation as Address);
            expect(chainSelector).toBe(16015286601757825753n);
            expect(reportScheduledAt).toBe(scheduledAt);
            expect(decodedCall.functionName).toBe("performUpkeep");
            expect(decodedCall.args).toEqual(["0x1234"]);
        });
    });

    test("does not create a report when upkeep is not needed", () => {
        const {runtime, evmMock} = setup(configWithReceivers);
        let writes = 0;

        configWithReceivers.vaults.forEach((vault) => {
            const target = addContractMock(evmMock, {
                address: vault.navOracleAutomation as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            target.checkUpkeep = () => [false, "0x"];
            const receiver = addContractMock(evmMock, {
                address: vault.receiver as Address,
                abi: [],
            });
            receiver.writeReport = () => {
                writes += 1;
                return {txStatus: "TX_STATUS_SUCCESS"};
            };
        });

        const results = onCronTrigger(runtime, cronPayload());

        expect(writes).toBe(0);
        expect(results.every((result) => result.writeAttempted === undefined)).toBe(true);
    });

    test("continues writing other vaults when one receiver write fails", () => {
        const {runtime, evmMock} = setup(configWithReceivers);

        configWithReceivers.vaults.forEach((vault, index) => {
            const target = addContractMock(evmMock, {
                address: vault.navOracleAutomation as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            target.checkUpkeep = () => [true, "0x"];
            const receiver = addContractMock(evmMock, {
                address: vault.receiver as Address,
                abi: [],
            });
            receiver.writeReport = () => {
                if (index === 0) throw new Error("write rejected");
                return {txStatus: "TX_STATUS_SUCCESS"};
            };
        });

        const results = failedResults(runtime);

        expect(results[0]).toMatchObject({
            writeAttempted: true,
            writeOutcome: "FAILED",
            error: "write rejected",
        });
        expect(results[1]).toMatchObject({
            writeAttempted: true,
            txStatus: 2,
            writeOutcome: "UNCONFIRMED",
        });
    });

    test("treats a reverted writeReport transaction as a failed write", () => {
        const {runtime, evmMock} = setup(configWithReceivers);
        const [vault] = configWithReceivers.vaults;
        const target = addContractMock(evmMock, {
            address: vault.navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });
        target.checkUpkeep = () => [true, "0x"];
        const receiver = addContractMock(evmMock, {
            address: vault.receiver as Address,
            abi: [],
        });
        receiver.writeReport = () => ({
            txStatus: "TX_STATUS_REVERTED",
            errorMessage: "forwarder transaction reverted",
            txHash: hexToBase64(failedTxHash),
        });
        const secondTarget = addContractMock(evmMock, {
            address: configWithReceivers.vaults[1].navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });
        secondTarget.checkUpkeep = () => [false, "0x"];

        const [result] = failedResults(runtime);

        expect(result).toMatchObject({
            writeAttempted: true,
            writeOutcome: "FAILED",
            error: "writeReport transaction failed with status 1: forwarder transaction reverted",
            txStatus: 1,
            txHash: failedTxHash,
        });
    });

    test("treats a reverted receiver execution as a failed write", () => {
        const {runtime, evmMock} = setup(configWithReceivers);
        const [vault1, vault2] = configWithReceivers.vaults;
        const target1 = addContractMock(evmMock, {
            address: vault1.navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });
        target1.checkUpkeep = () => [true, "0x"];
        const receiver = addContractMock(evmMock, {
            address: vault1.receiver as Address,
            abi: [],
        });
        receiver.writeReport = () => ({
            txStatus: "TX_STATUS_SUCCESS",
            receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED",
            errorMessage: "target reverted",
            txHash: hexToBase64(failedTxHash),
        });
        const target2 = addContractMock(evmMock, {
            address: vault2.navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });
        target2.checkUpkeep = () => [false, "0x"];

        const [result] = failedResults(runtime);

        expect(result).toMatchObject({
            writeAttempted: true,
            writeOutcome: "FAILED",
            error: "Receiver execution failed with status 1: target reverted",
            txStatus: 2,
            receiverExecutionStatus: 1,
            txHash: failedTxHash,
        });
    });

    test("reports a ready target when its receiver is not configured", () => {
        const {runtime, evmMock} = setup(configWithoutReceivers);
        const [vault1, vault2] = configWithoutReceivers.vaults;
        const target1 = addContractMock(evmMock, {
            address: vault1.navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });
        target1.checkUpkeep = () => [true, "0x1234"];
        const target2 = addContractMock(evmMock, {
            address: vault2.navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });
        target2.checkUpkeep = () => [false, "0x"];

        const [result] = failedResults(runtime);

        expect(result).toMatchObject({
            vaultId: "vault-1",
            upkeepNeeded: true,
            performData: "0x1234",
            writeAttempted: false,
            writeOutcome: "FAILED",
            error: "Receiver is not configured for vault-1",
        });
    });

    test("continues when one target fails", () => {
        const {runtime, evmMock} = setup();
        const [vault1, vault2] = config.vaults;
        const target1 = addContractMock(evmMock, {
            address: vault1.navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });
        const target2 = addContractMock(evmMock, {
            address: vault2.navOracleAutomation as Address,
            abi: CHECK_UPKEEP_ABI,
        });

        target1.checkUpkeep = () => {
            throw new Error("RPC unavailable");
        };
        target2.checkUpkeep = () => [true, "0x"];

        const results = failedResults(runtime);

        expect(results[0]).toMatchObject({
            vaultId: "vault-1",
            upkeepNeeded: false,
            error: "RPC unavailable",
        });
        expect(results[1]).toMatchObject({
            vaultId: "vault-2",
            upkeepNeeded: true,
        });
    });
});
