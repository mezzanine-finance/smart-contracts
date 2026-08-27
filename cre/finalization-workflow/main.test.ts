/// <reference types="bun" />

import {describe, expect} from "bun:test";
import {newTestRuntime, test} from "@chainlink/cre-sdk/test";
import {initWorkflow, onCronTrigger, type Config} from "./main";
import productionConfig from "./config.production.json";
import stagingConfig from "./config.staging.json";

describe("Finalization workflow", () => {
    test("registers its cron schedule", () => {
        const config: Config = stagingConfig as Config;
        const handlers = initWorkflow(config);

        expect(handlers).toHaveLength(1);
        expect(config.schedule).toBe("0 */5 * * * *");
    });

    test("configures all delayed-withdrawal finalizers", () => {
        expect(stagingConfig.chainName).toBe("ethereum-testnet-sepolia");
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
        expect(productionConfig.vaults).toEqual([]);
    });

    test("runs the placeholder callback with the staging config", () => {
        const runtime = newTestRuntime<Config>();
        runtime.config = stagingConfig as Config;

        expect(onCronTrigger(runtime)).toBe("Finalization workflow placeholder");
        expect(runtime.getLogs()).toContain("Finalization workflow triggered.");
    });
});
