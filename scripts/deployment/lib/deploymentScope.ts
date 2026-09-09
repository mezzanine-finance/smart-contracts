export interface DeploymentScopeConfig {
    deploymentId?: string;
    infrastructureId?: string;
}

export function resolveDeploymentScope(config: DeploymentScopeConfig, overrideId?: string) {
    const vaultNamespace = overrideId ?? config.deploymentId;
    const sharedNamespace = config.infrastructureId ?? (vaultNamespace ? "shared" : undefined);
    for (const [name, value] of Object.entries({
        deploymentId: vaultNamespace,
        infrastructureId: sharedNamespace,
    })) {
        if (value !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
            throw new Error(`${name} must contain only lowercase letters, numbers, and hyphens`);
        }
    }
    if (vaultNamespace === "shared") throw new Error('deploymentId "shared" is reserved');
    if (config.infrastructureId && !vaultNamespace) {
        throw new Error("infrastructureId requires a deploymentId");
    }
    if (vaultNamespace && vaultNamespace === sharedNamespace) {
        throw new Error("deploymentId and infrastructureId must be different");
    }
    return {vaultNamespace, sharedNamespace};
}
