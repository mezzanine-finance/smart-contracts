import {CronCapability, handler, Runner, type Runtime} from "@chainlink/cre-sdk";

export interface Config {
    schedule: string;
}

export const onCronTrigger = (runtime: Runtime<Config>): string => {
    runtime.log("Finalization workflow triggered.");
    return "Finalization workflow placeholder";
};

export const initWorkflow = (config: Config) => {
    const cron = new CronCapability();

    return [handler(cron.trigger({schedule: config.schedule}), onCronTrigger)];
};

export async function main() {
    const runner = await Runner.newRunner<Config>();
    await runner.run(initWorkflow);
}
