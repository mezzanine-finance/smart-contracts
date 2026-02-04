import {network, run} from "hardhat";
import {log} from "./logger";
import {isLocalNetwork} from "./helpers";

export async function verifyContract(
    address: string,
    constructorArguments: any[] = [],
    enabled = true
) {
    if (!enabled || isLocalNetwork(network.name)) {
        log.info(`Skipping verification for ${address}`);
        return;
    }

    try {
        log.info(`Verifying ${address}...`);
        await run("verify:verify", {address, constructorArguments});
        log.success(`Verified ${address}`);
    } catch (error: any) {
        log.warn(`Verification failed or already verified: ${error?.message ?? error}`);
    }
}
