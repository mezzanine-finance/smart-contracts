// CRE runner entry point for the test-only NAV submitter workflow.
import {Runner} from "@chainlink/cre-sdk";
import {configSchema, type Config} from "./config";
import {initWorkflow} from "./workflow";

export async function main() {
    const runner = await Runner.newRunner<Config>({configSchema});
    await runner.run(initWorkflow);
}
