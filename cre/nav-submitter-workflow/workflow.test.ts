/// <reference types="bun" />

import {describe, expect} from "bun:test";
import {bytesToHex, getNetwork, type CronPayload} from "@chainlink/cre-sdk";
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
import {initWorkflow, onCronTrigger} from "./workflow";
import stagingConfig from "./config.staging.json";

describe("test NAV submitter workflow", () => {
    const scheduledAt = 1_800_000_000n;
    const receiver1 = "0x1111111111111111111111111111111111111111" as Address;
    const receiver2 = "0x2222222222222222222222222222222222222222" as Address;
    const submitter1 = "0x3333333333333333333333333333333333333333" as Address;
    const submitter2 = "0x4444444444444444444444444444444444444444" as Address;
    const config: Config = {
        schedule: "0 */5 * * * *",
        chainName: "ethereum-testnet-sepolia",
        isTestnet: true,
        gasLimit: "500000",
        vaults: [
            {id: "vault-1", submitter: submitter1, receiver: receiver1},
            {id: "vault-2", submitter: submitter2, receiver: receiver2},
        ],
    };
    const cronPayload = () =>
        ({scheduledExecutionTime: {seconds: scheduledAt, nanos: 0}}) as CronPayload;

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

    const reportPayload = (rawReport: Uint8Array): Hex => {
        const report = bytesToHex(rawReport);
        return `0x${report.slice(2 + REPORT_METADATA_HEADER_LENGTH * 2)}`;
    };

    test("configures two unique testnet submitters with receivers", () => {
        const parsed = configSchema.parse(stagingConfig);
        expect(parsed.isTestnet).toBe(true);
        expect(parsed.vaults).toHaveLength(2);
        expect(new Set(parsed.vaults.map((vault) => vault.id)).size).toBe(2);
        expect(new Set(parsed.vaults.map((vault) => vault.submitter.toLowerCase())).size).toBe(2);
        expect(parsed.vaults.every((vault) => vault.receiver !== undefined)).toBe(true);
        expect(initWorkflow(parsed)).toHaveLength(1);
    });

    test("rejects a production configuration", () => {
        expect(configSchema.safeParse({...config, isTestnet: false}).success).toBe(false);
    });

    test("requires deterministic cron execution time", () => {
        const {runtime} = setup();
        expect(() => onCronTrigger(runtime, {} as CronPayload)).toThrow(
            "Cron scheduled execution time is missing or invalid"
        );
    });

    test("does not write when no test submission is ready", () => {
        const {runtime, evmMock} = setup();
        for (const vault of config.vaults) {
            const submitter = addContractMock(evmMock, {
                address: vault.submitter as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            submitter.checkUpkeep = () => [false, "0x"];
        }

        const results = onCronTrigger(runtime, cronPayload());
        expect(results).toHaveLength(2);
        expect(results.every(({upkeepNeeded}) => !upkeepNeeded)).toBe(true);
        expect(results.every(({writeAttempted}) => writeAttempted === undefined)).toBe(true);
    });

    test("writes performUpkeep reports for every ready submitter", () => {
        const {runtime, evmMock} = setup();
        const writes: {receiver: Address; payload: Hex}[] = [];
        for (const vault of config.vaults) {
            const submitter = addContractMock(evmMock, {
                address: vault.submitter as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            submitter.checkUpkeep = () => [true, "0x1234"];
            const receiver = addContractMock(evmMock, {
                address: vault.receiver as Address,
                abi: [],
            });
            receiver.writeReport = ({report}) => {
                writes.push({
                    receiver: vault.receiver as Address,
                    payload: reportPayload(report.rawReport),
                });
                return {
                    txStatus: "TX_STATUS_SUCCESS",
                    receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS",
                };
            };
        }

        const results = onCronTrigger(runtime, cronPayload());
        expect(results.every(({writeOutcome}) => writeOutcome === "SUCCESS")).toBe(true);
        expect(writes).toHaveLength(2);
        writes.forEach((write, index) => {
            const [target, callData, chainSelector, reportScheduledAt] = decodeAbiParameters(
                [{type: "address"}, {type: "bytes"}, {type: "uint64"}, {type: "uint64"}],
                write.payload
            );
            const call = decodeFunctionData({abi: PERFORM_UPKEEP_ABI, data: callData});
            expect(write.receiver).toBe(config.vaults[index].receiver as Address);
            expect(target).toBe(config.vaults[index].submitter as Address);
            expect(chainSelector).toBe(16015286601757825753n);
            expect(reportScheduledAt).toBe(scheduledAt);
            expect(call.functionName).toBe("performUpkeep");
            expect(call.args).toEqual(["0x1234"]);
        });
    });

    test("continues after one submitter read fails", () => {
        const {runtime, evmMock} = setup();
        config.vaults.forEach((vault, index) => {
            const submitter = addContractMock(evmMock, {
                address: vault.submitter as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            submitter.checkUpkeep = () => {
                if (index === 0) throw new Error("RPC unavailable");
                return [false, "0x"];
            };
        });

        const results = onCronTrigger(runtime, cronPayload());
        expect(results[0].error).toBe("RPC unavailable");
        expect(results[1].error).toBeUndefined();
    });

    test("continues after one receiver write fails", () => {
        const {runtime, evmMock} = setup();
        config.vaults.forEach((vault, index) => {
            const submitter = addContractMock(evmMock, {
                address: vault.submitter as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            submitter.checkUpkeep = () => [true, "0x"];
            const receiver = addContractMock(evmMock, {
                address: vault.receiver as Address,
                abi: [],
            });
            receiver.writeReport = () => {
                if (index === 0) throw new Error("write rejected");
                return {txStatus: "TX_STATUS_SUCCESS"};
            };
        });

        const results = onCronTrigger(runtime, cronPayload());
        expect(results[0]).toMatchObject({writeOutcome: "FAILED", error: "write rejected"});
        expect(results[1]).toMatchObject({writeOutcome: "UNCONFIRMED", txStatus: 2});
    });
});
