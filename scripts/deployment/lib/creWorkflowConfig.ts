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

export function resolveWorkflowReceivers(
    configs: readonly CREWorkflowConfig[]
): ReadonlyMap<string, string> {
    if (configs.length === 0) throw new Error("At least one workflow config is required");

    const receivers = new Map<string, string>();
    for (const [configIndex, config] of configs.entries()) {
        const vaultIds = new Set<string>();
        for (const vault of config.vaults) {
            if (vaultIds.has(vault.id)) {
                throw new Error(`Duplicate workflow vault: ${vault.id}`);
            }
            vaultIds.add(vault.id);
            if (!vault.receiver) {
                throw new Error(`Workflow vault has no receiver: ${vault.id}`);
            }
            const expected = receivers.get(vault.id);
            if (configIndex === 0) {
                receivers.set(vault.id, vault.receiver);
            } else if (!expected || expected.toLowerCase() !== vault.receiver.toLowerCase()) {
                throw new Error(`Workflow receiver mismatch for ${vault.id}`);
            }
        }
        if (configIndex > 0 && vaultIds.size !== receivers.size) {
            throw new Error("Workflow configs contain different vault sets");
        }
        for (const vaultId of receivers.keys()) {
            if (!vaultIds.has(vaultId)) {
                throw new Error(`Workflow config is missing vault: ${vaultId}`);
            }
        }
    }
    return receivers;
}
