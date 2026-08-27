import {CronCapability, handler, Runner, type Runtime} from "@chainlink/cre-sdk";

export interface NavVaultConfig {
    id: string;
    issuanceVault: string;
    navOracleAutomation: string;
}

export interface Config {
    schedule: string;
    chainName: string;
    vaults: NavVaultConfig[];
}

export const onCronTrigger = (runtime: Runtime<Config>): string => {
    runtime.log("NAV workflow triggered.");
    return "NAV workflow placeholder";
};

export const initWorkflow = (config: Config) => {
    const cron = new CronCapability();

    return [handler(cron.trigger({schedule: config.schedule}), onCronTrigger)];
};

export async function main() {
    const runner = await Runner.newRunner<Config>();
    await runner.run(initWorkflow);
}
