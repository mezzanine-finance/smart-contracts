import chalk from "chalk";

const prefix = {
    info: chalk.blue("ℹ"),
    ok: chalk.green("✅"),
    warn: chalk.yellow("⚠️"),
    err: chalk.red("❌"),
    step: chalk.magenta("▶"),
};

export const log = {
    info: (message: string) => console.log(`${prefix.info} ${chalk.cyan(message)}`),
    step: (message: string) => console.log(`${prefix.step} ${chalk.bold(message)}`),
    success: (message: string) => console.log(`${prefix.ok} ${chalk.green(message)}`),
    warn: (message: string) => console.log(`${prefix.warn} ${chalk.yellow(message)}`),
    error: (message: string) => console.log(`${prefix.err} ${chalk.red(message)}`),
};

export const format = {
    addr: (value: string) => chalk.white(value),
    label: (value: string) => chalk.bold(value),
};
