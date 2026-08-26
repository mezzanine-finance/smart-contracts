import {describe, expect} from "bun:test";
import {newTestRuntime, test} from "@chainlink/cre-sdk/test";
import {initWorkflow, onCronTrigger, type Config} from "./main";

describe("Finalization workflow", () => {
    test("registers its cron schedule", () => {
        const config: Config = {schedule: "*/30 * * * * *"};
        const handlers = initWorkflow(config);

        expect(handlers).toHaveLength(1);
        expect(handlers[0].trigger.config.schedule).toBe(config.schedule);
    });

    test("runs the placeholder callback", () => {
        const runtime = newTestRuntime();
        runtime.config = {schedule: "*/30 * * * * *"};

        expect(onCronTrigger(runtime)).toBe("Finalization workflow placeholder");
        expect(runtime.getLogs()).toContain("Finalization workflow triggered.");
    });
});
