/// <reference types="bun" />

import {describe, expect} from "bun:test";
import {getNetwork} from "@chainlink/cre-sdk";
import {addContractMock, EvmMock, newTestRuntime, test} from "@chainlink/cre-sdk/test";
import type {Address} from "viem";
import {CHECK_UPKEEP_ABI, configSchema, initWorkflow, onCronTrigger, type Config} from "./main";
import productionConfig from "./config.production.json";
import stagingConfig from "./config.staging.json";

describe("Finalization workflow", () => {
    const config = configSchema.parse(stagingConfig);

    const setup = () => {
        const network = getNetwork({
            chainFamily: "evm",
            chainSelectorName: config.chainName,
            isTestnet: config.isTestnet,
        });
        if (!network) throw new Error("Sepolia network is unavailable in the SDK");

        return {
            runtime: newTestRuntime<Config>(null, undefined, config),
            evmMock: EvmMock.testInstance(network.chainSelector.selector),
        };
    };

    test("registers its cron schedule", () => {
        const config: Config = stagingConfig as Config;
        const handlers = initWorkflow(config);

        expect(handlers).toHaveLength(1);
        expect(config.schedule).toBe("0 */5 * * * *");
    });

    test("configures all delayed-withdrawal finalizers", () => {
        expect(stagingConfig.chainName).toBe("ethereum-testnet-sepolia");
        expect(stagingConfig.isTestnet).toBe(true);
        expect(stagingConfig.vaults).toEqual([
            {
                id: "vault-1",
                issuanceVault: "0xbE0F5B09932a29ac244D8ac776Ce1917313882F1",
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
        const {runtime, evmMock} = setup();
        const finalizers = config.vaults.flatMap(({id, finalizers}) =>
            finalizers.map((finalizer) => ({vaultId: id, ...finalizer}))
        );

        finalizers.forEach((finalizer, index) => {
            const target = addContractMock(evmMock, {
                address: finalizer.address as Address,
                abi: CHECK_UPKEEP_ABI,
            });
            target.checkUpkeep = () => [index === 1, index === 1 ? "0xabcd" : "0x"];
        });

        expect(onCronTrigger(runtime)).toEqual([
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

        const results = onCronTrigger(runtime);

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
