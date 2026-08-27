/// <reference types="bun" />

import {describe, expect} from "bun:test";
import {newTestRuntime, test} from "@chainlink/cre-sdk/test";
import {initWorkflow, onCronTrigger, type Config} from "./main";
import productionConfig from "./config.production.json";
import stagingConfig from "./config.staging.json";

describe("NAV workflow", () => {
    test("registers its cron schedule", () => {
        const config: Config = stagingConfig;
        const handlers = initWorkflow(config);

        expect(handlers).toHaveLength(1);
        expect(config.schedule).toBe("0 */5 * * * *");
    });

    test("configures both Sepolia vaults", () => {
        expect(stagingConfig.chainName).toBe("ethereum-testnet-sepolia");
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
        expect(productionConfig.vaults).toEqual([]);
    });

    test("runs the placeholder callback with the staging config", () => {
        const runtime = newTestRuntime<Config>();
        runtime.config = stagingConfig;

        expect(onCronTrigger(runtime)).toBe("NAV workflow placeholder");
        expect(runtime.getLogs()).toContain("NAV workflow triggered.");
    });
});
