import {Contract} from "ethers";
import {log} from "./logger";

export async function ensureTargetRole(
    accessManager: Contract,
    target: string,
    selectors: string[],
    roleId: number
) {
    for (const selector of selectors) {
        const current = await accessManager.getTargetFunctionRole(target, selector);
        if (Number(current) === roleId) {
            continue;
        }
        log.info(`Setting target role ${roleId} for ${target} ${selector}`);
        const tx = await accessManager.setTargetFunctionRole(target, [selector], roleId);
        await tx.wait();
    }
}

export async function ensureRoleMember(
    accessManager: Contract,
    roleId: number,
    account: string,
    executionDelay = 0
) {
    const [hasRole, currentDelay] = await accessManager.hasRole(roleId, account);
    if (hasRole && Number(currentDelay) === executionDelay) return;
    const action = hasRole ? "Updating" : "Granting";
    log.info(`${action} role ${roleId} for ${account} (delay=${executionDelay}s)`);
    const tx = await accessManager.grantRole(roleId, account, executionDelay);
    await tx.wait();
}
