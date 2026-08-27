/// <reference types="bun" />

import {describe, expect} from "bun:test";
import {getNetwork} from "@chainlink/cre-sdk";
import {addContractMock, EvmMock, newTestRuntime, test} from "@chainlink/cre-sdk/test";
import type {Address} from "viem";
import {CHECK_UPKEEP_ABI, configSchema, initWorkflow, onCronTrigger, type Config} from "./main";
import productionConfig from "./config.production.json";
import stagingConfig from "./config.staging.json";

describe("NAV workflow", () => {
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
        const config: Config = stagingConfig;
        const handlers = initWorkflow(config);

        expect(handlers).toHaveLength(1);
        expect(config.schedule).toBe("0 */5 * * * *");
    });

    test("configures both Sepolia vaults", () => {
        expect(stagingConfig.chainName).toBe("ethereum-testnet-sepolia");
        expect(stagingConfig.isTestnet).toBe(true);
        expect(stagingConfig.vaults).toEqual([
            {
                id: "vault-1",
                issuanceVault: "0xbE0F5B09932a29ac244D8ac776Ce1917313882F1",
                navOracleAutomation: "0x268cE58e8974F8BF7CB472CbBEE4Aeb6e45706E4",
            },
            {
                id: "vault-2",
                issuanceVault: "0xfE36122E7c9a55BcDb78Bc9CbFc4b2c1740FC259",
                navOracleAutomation: "0x5c614041Cab67d3a598aA0Ab29775eE0Ad2BBf6e",
            },
        ]);
    });

    test("does not configure targets in production yet", () => {
        expect(productionConfig.chainName).toBe("ethereum-mainnet");
        expect(productionConfig.isTestnet).toBe(false);
        expect(productionConfig.vaults).toEqual([]);
    });

    test("reports readiness and preserves performData for every target", () => {
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

        target1.checkUpkeep = () => [false, "0x"];
        target2.checkUpkeep = () => [true, "0x1234"];

        expect(onCronTrigger(runtime)).toEqual([
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
            },
        ]);
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

        const results = onCronTrigger(runtime);

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
