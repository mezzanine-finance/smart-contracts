/// <reference types="bun" />

import {describe, expect} from "bun:test";
import {bytesToHex, EVMClient, getNetwork, hexToBase64} from "@chainlink/cre-sdk";
import {EvmMock, newTestRuntime, test} from "@chainlink/cre-sdk/test";
import {decodeFunctionData, encodeFunctionResult, type Address} from "viem";
import {configSchema, type Config} from "./config";
import {CHECK_UPKEEP_ABI} from "./contracts";
import {readUpkeep} from "./read";
import stagingConfig from "./config.staging.json";

describe("latest upkeep reads", () => {
    const target = "0x1111111111111111111111111111111111111111" as Address;
    const config = configSchema.parse(stagingConfig);
    const setup = () => {
        const network = getNetwork({
            chainFamily: "evm",
            chainSelectorName: config.chainName,
            isTestnet: config.isTestnet,
        });
        if (!network) throw new Error("Test network is unavailable in the SDK");
        return {
            runtime: newTestRuntime<Config>(null, undefined, config),
            client: new EVMClient(network.chainSelector.selector),
            mock: EvmMock.testInstance(network.chainSelector.selector),
        };
    };

    test("skips work already completed at latest even when older state still reports ready", () => {
        const {runtime, client, mock} = setup();
        let reads = 0;
        mock.callContract = (request) => {
            reads++;
            expect(bytesToHex(request.call!.to)).toBe(target);
            expect(
                decodeFunctionData({
                    abi: CHECK_UPKEEP_ABI,
                    data: bytesToHex(request.call!.data),
                })
            ).toEqual({functionName: "checkUpkeep", args: ["0x"]});
            // EVM capability encodes latest as -2. Older state still has pending work.
            const isLatest =
                request.blockNumber?.sign === -1n &&
                bytesToHex(request.blockNumber.absVal) === "0x02";
            return {
                data: hexToBase64(
                    encodeFunctionResult({
                        abi: CHECK_UPKEEP_ABI,
                        functionName: "checkUpkeep",
                        result: isLatest ? [false, "0x"] : [true, "0x1234"],
                    })
                ),
            };
        };
        expect(readUpkeep(runtime, client, target)).toEqual({
            upkeepNeeded: false,
            performData: "0x",
        });
        expect(reads).toBe(1);
    });

    test("preserves ready upkeep calldata from the latest block", () => {
        const {runtime, client, mock} = setup();
        mock.callContract = (request) => {
            expect(request.blockNumber?.sign).toBe(-1n);
            expect(bytesToHex(request.blockNumber!.absVal)).toBe("0x02");
            return {
                data: hexToBase64(
                    encodeFunctionResult({
                        abi: CHECK_UPKEEP_ABI,
                        functionName: "checkUpkeep",
                        result: [true, "0x1234"],
                    })
                ),
            };
        };
        expect(readUpkeep(runtime, client, target)).toEqual({
            upkeepNeeded: true,
            performData: "0x1234",
        });
    });
});
