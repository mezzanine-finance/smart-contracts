export const PauseCategory = {
    DEPOSITS: 0,
    WITHDRAWALS: 1,
    TRANSFERS: 2,
    ADMIN: 3,
    PROTOCOL: 4,
} as const;

export async function grantPausePermissions(
    accessManager: any,
    pauseManager: any,
    adminRole: bigint
) {
    const pauseGlobalSelector = pauseManager.interface.getFunction("pauseGlobal").selector;
    const unpauseGlobalSelector = pauseManager.interface.getFunction("unpauseGlobal").selector;
    const pauseContractSelector = pauseManager.interface.getFunction("pauseContract").selector;
    const unpauseContractSelector = pauseManager.interface.getFunction("unpauseContract").selector;

    await accessManager.setTargetFunctionRole(
        pauseManager.target,
        [
            pauseGlobalSelector,
            unpauseGlobalSelector,
            pauseContractSelector,
            unpauseContractSelector,
        ],
        adminRole
    );
}
