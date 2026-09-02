export interface CREWorkflowVaultConfig {
    id: string;
    receiver?: string;
    [key: string]: unknown;
}

export interface CREWorkflowConfig {
    vaults: CREWorkflowVaultConfig[];
    [key: string]: unknown;
}

export function syncWorkflowReceivers(
    config: CREWorkflowConfig,
    receivers: ReadonlyMap<string, string>
): {config: CREWorkflowConfig; changed: boolean} {
    const configuredVaultIds = new Set(config.vaults.map(({id}) => id));
    for (const vaultId of receivers.keys()) {
        if (!configuredVaultIds.has(vaultId)) {
            throw new Error(`Receiver deployment has no matching workflow vault: ${vaultId}`);
        }
    }

    let changed = false;
    const vaults = config.vaults.map((vault) => {
        const receiver = receivers.get(vault.id);
        if (!receiver) throw new Error(`Workflow vault has no receiver deployment: ${vault.id}`);
        if (vault.receiver === receiver) return vault;
        changed = true;
        return {...vault, receiver};
    });

    return {config: changed ? {...config, vaults} : config, changed};
}
