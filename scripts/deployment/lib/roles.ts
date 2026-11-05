import type {AccessManager} from "../../../typechain-types";
import {log} from "./logger";

export interface AdminCallQueue {
    add(to: string, data: string): void;
}

export async function ensureTargetRole(
    accessManager: AccessManager,
    target: string,
    selectors: string[],
    roleId: number,
    queue?: AdminCallQueue
) {
    for (const selector of selectors) {
        const current = await accessManager.getTargetFunctionRole(target, selector);
        if (Number(current) === roleId) {
            continue;
        }
        log.info(`Setting target role ${roleId} for ${target} ${selector}`);
        if (queue) {
            queue.add(
                await accessManager.getAddress(),
                accessManager.interface.encodeFunctionData("setTargetFunctionRole", [
                    target,
                    [selector],
                    roleId,
                ])
            );
            continue;
        }
        const tx = await accessManager.setTargetFunctionRole(target, [selector], roleId);
        await tx.wait();
    }
}

export async function ensureRoleMember(
    accessManager: AccessManager,
    roleId: number,
    account: string,
    executionDelay = 0,
    queue?: AdminCallQueue
) {
    const [hasRole, currentDelay] = await accessManager.hasRole(roleId, account);
    if (hasRole && Number(currentDelay) === executionDelay) return;
    const action = hasRole ? "Updating" : "Granting";
    log.info(`${action} role ${roleId} for ${account} (delay=${executionDelay}s)`);
    if (queue) {
        queue.add(
            await accessManager.getAddress(),
            accessManager.interface.encodeFunctionData("grantRole", [
                roleId,
                account,
                executionDelay,
            ])
        );
        return;
    }
    const tx = await accessManager.grantRole(roleId, account, executionDelay);
    await tx.wait();
}
