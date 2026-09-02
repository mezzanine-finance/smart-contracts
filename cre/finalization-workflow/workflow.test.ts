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
import productionConfig from "./config.production.json";
import stagingConfig from "./config.staging.json";

describe("Finalization workflow", () => {
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

    const reportPayload = (rawReport: Uint8Array): Hex => {
        const report = bytesToHex(rawReport);
        return `0x${report.slice(2 + REPORT_METADATA_HEADER_LENGTH * 2)}`;
    };

    test("registers its cron schedule", () => {
        const config: Config = stagingConfig as Config;
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

    test("configures all delayed-withdrawal finalizers", () => {
        expect(stagingConfig.chainName).toBe("ethereum-testnet-sepolia");
        expect(stagingConfig.isTestnet).toBe(true);
        expect(stagingConfig.vaults).toEqual([
            {
                id: "vault-1",
                issuanceVault: "0xbE0F5B09932a29ac244D8ac776Ce1917313882F1",
                receiver: "0xEE9C7AeB533D514a588c70DB754FA5f2D112E8b9",
                finalizers: [
                    {
                        tranche: "senior",
                        address: "0xE5ead599d1c550CD1d860FaD781239c144CEa682",
                    },
                    {
                        tranche: "junior",
                        address: "0xc6ae58178335be8AB541bfdC2B30188Ac4b5BB8D",
                    },
                ],
            },
            {
                id: "vault-2",
                issuanceVault: "0xfE36122E7c9a55BcDb78Bc9CbFc4b2c1740FC259",
                receiver: "0x561B79a1a69B1813C8d3eF56DAc2ef3b87E1A282",
                finalizers: [
                    {
                        tranche: "junior",
                        address: "0x8C6874ee655C019Cf346fB22e9cc4812d4CB87d9",
                    },
                ],
            },
        ]);
    });

    test("does not configure targets in production yet", () => {
        expect(productionConfig.chainName).toBe("ethereum-mainnet");
        expect(productionConfig.isTestnet).toBe(false);
        expect(productionConfig.vaults).toEqual([]);
    });

    test("reports readiness for every finalizer", () => {
        const {runtime, evmMock} = setup(configWithReceivers);
        const finalizers = configWithReceivers.vaults.flatMap(({id, receiver, finalizers}) =>
            finalizers.map((finalizer) => ({vaultId: id, receiver, ...finalizer}))
        );

        finalizers.forEach((finalizer, index) => {
            const target = addContractMock(evmMock, {
                address: finalizer.address as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            target.checkUpkeep = () => [index === 1, index === 1 ? "0xabcd" : "0x"];
        });
        const receiver = addContractMock(evmMock, {
            address: finalizers[1].receiver as Address,
            abi: [],
        });
        receiver.writeReport = () => ({txStatus: "TX_STATUS_SUCCESS"});

        expect(onCronTrigger(runtime, cronPayload())).toEqual([
            {
                vaultId: "vault-1",
                tranche: "senior",
                target: finalizers[0].address as Address,
                upkeepNeeded: false,
                performData: "0x",
            },
            {
                vaultId: "vault-1",
                tranche: "junior",
                target: finalizers[1].address as Address,
                upkeepNeeded: true,
                performData: "0xabcd",
                writeAttempted: true,
                txStatus: 2,
            },
            {
                vaultId: "vault-2",
                tranche: "junior",
                target: finalizers[2].address as Address,
                upkeepNeeded: false,
                performData: "0x",
            },
        ]);
    });

    test("writes one receiver report per ready finalizer", () => {
        const {runtime, evmMock} = setup(configWithReceivers);
        const writes: {receiver: Address; payload: Hex}[] = [];

        configWithReceivers.vaults.forEach((vault) => {
            vault.finalizers.forEach((finalizer) => {
                const target = addContractMock(evmMock, {
                    address: finalizer.address as Address,
                    abi: CHECK_UPKEEP_ABI,
                });
                target.checkUpkeep = () => [true, "0xabcd"];
            });
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
                    txHash: "EjQ=",
                };
            };
        });

        const results = onCronTrigger(runtime, cronPayload());

        expect(writes).toHaveLength(3);
        expect(results.every((result) => result.txStatus === 2)).toBe(true);
        expect(
            results.every(
                (result) => result.receiverExecutionStatus === 0 && result.txHash === "0x1234"
            )
        ).toBe(true);
        const expectedTargets = configWithReceivers.vaults.flatMap((vault) =>
            vault.finalizers.map((finalizer) => ({
                receiver: vault.receiver,
                target: finalizer.address,
            }))
        );
        writes.forEach((write, index) => {
            const [target, callData, chainSelector, reportScheduledAt] = decodeAbiParameters(
                [{type: "address"}, {type: "bytes"}, {type: "uint64"}, {type: "uint64"}],
                write.payload
            );
            const decodedCall = decodeFunctionData({
                abi: PERFORM_UPKEEP_ABI,
                data: callData,
            });

            expect(write.receiver).toBe(expectedTargets[index].receiver as Address);
            expect(target).toBe(expectedTargets[index].target as Address);
            expect(chainSelector).toBe(16015286601757825753n);
            expect(reportScheduledAt).toBe(scheduledAt);
            expect(decodedCall.functionName).toBe("performUpkeep");
            expect(decodedCall.args).toEqual(["0xabcd"]);
        });
    });

    test("continues writing other vaults when one receiver write fails", () => {
        const {runtime, evmMock} = setup(configWithReceivers);

        configWithReceivers.vaults.forEach((vault) => {
            vault.finalizers.forEach((finalizer) => {
                const target = addContractMock(evmMock, {
                    address: finalizer.address as Address,
                    abi: CHECK_UPKEEP_ABI,
                });
                target.checkUpkeep = () => [true, "0x"];
            });
            const receiver = addContractMock(evmMock, {
                address: vault.receiver as Address,
                abi: [],
            });
            receiver.writeReport = () => {
                if (vault.id === "vault-1") throw new Error("write rejected");
                return {txStatus: "TX_STATUS_SUCCESS"};
            };
        });

        const results = onCronTrigger(runtime, cronPayload());

        expect(results[0]).toMatchObject({writeAttempted: true, error: "write rejected"});
        expect(results[1]).toMatchObject({writeAttempted: true, error: "write rejected"});
        expect(results[2]).toMatchObject({writeAttempted: true, txStatus: 2});
    });

    test("treats a reverted receiver execution as a failed write", () => {
        const {runtime, evmMock} = setup(configWithReceivers);

        configWithReceivers.vaults.forEach((vault) => {
            vault.finalizers.forEach((finalizer, index) => {
                const target = addContractMock(evmMock, {
                    address: finalizer.address as Address,
                    abi: CHECK_UPKEEP_ABI,
                });
                target.checkUpkeep = () => [vault.id === "vault-1" && index === 0, "0x"];
            });
            const receiver = addContractMock(evmMock, {
                address: vault.receiver as Address,
                abi: [],
            });
            receiver.writeReport = () => ({
                txStatus: "TX_STATUS_SUCCESS",
                receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED",
            });
        });

        const [result] = onCronTrigger(runtime, cronPayload());

        expect(result).toMatchObject({
            writeAttempted: true,
            error: "Receiver execution failed with status 1",
        });
    });

    test("treats a reverted writeReport transaction as a failed write", () => {
        const {runtime, evmMock} = setup(configWithReceivers);
        const finalizers = configWithReceivers.vaults.flatMap(({id, receiver, finalizers}) =>
            finalizers.map((finalizer) => ({vaultId: id, receiver, ...finalizer}))
        );

        finalizers.forEach((finalizer, index) => {
            const target = addContractMock(evmMock, {
                address: finalizer.address as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            target.checkUpkeep = () => [index === 0, "0x"];
        });
        const receiver = addContractMock(evmMock, {
            address: finalizers[0].receiver as Address,
            abi: [],
        });
        receiver.writeReport = () => ({
            txStatus: "TX_STATUS_REVERTED",
            errorMessage: "forwarder transaction reverted",
        });

        const [result] = onCronTrigger(runtime, cronPayload());

        expect(result).toMatchObject({
            writeAttempted: true,
            error: "writeReport transaction failed with status 1: forwarder transaction reverted",
        });
    });

    test("reports a ready finalizer when its receiver is not configured", () => {
        const {runtime, evmMock} = setup(configWithoutReceivers);
        const finalizers = configWithoutReceivers.vaults.flatMap(({id, finalizers}) =>
            finalizers.map((finalizer) => ({vaultId: id, ...finalizer}))
        );

        finalizers.forEach((finalizer, index) => {
            const target = addContractMock(evmMock, {
                address: finalizer.address as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            target.checkUpkeep = () => [index === 0, index === 0 ? "0xabcd" : "0x"];
        });

        const [result] = onCronTrigger(runtime, cronPayload());

        expect(result).toMatchObject({
            vaultId: "vault-1",
            tranche: "senior",
            upkeepNeeded: true,
            performData: "0xabcd",
            writeAttempted: false,
            error: "Receiver is not configured for vault-1",
        });
    });

    test("continues when one finalizer fails", () => {
        const {runtime, evmMock} = setup();
        const finalizers = config.vaults.flatMap(({id, finalizers}) =>
            finalizers.map((finalizer) => ({vaultId: id, ...finalizer}))
        );

        finalizers.forEach((finalizer, index) => {
            const target = addContractMock(evmMock, {
                address: finalizer.address as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            target.checkUpkeep = () => {
                if (index === 0) throw new Error("RPC unavailable");
                return [true, "0x"];
            };
        });

        const results = onCronTrigger(runtime, cronPayload());

        expect(results[0]).toMatchObject({
            vaultId: "vault-1",
            tranche: "senior",
            upkeepNeeded: false,
            error: "RPC unavailable",
        });
        expect(results[1]).toMatchObject({upkeepNeeded: true});
        expect(results[2]).toMatchObject({upkeepNeeded: true});
    });
});
