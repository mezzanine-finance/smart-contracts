import type {DeployConfig} from "./config";
import {resolveDeploymentScope} from "./deploymentScope";
import {getLatestDeployment, type DeploymentsFile} from "./deployments";

export function buildDeploymentPlan(
    config: DeployConfig,
    networkName: string,
    deployments: DeploymentsFile,
    options: {deploymentId?: string; fresh?: boolean; freshShared?: boolean} = {}
) {
    const scope = resolveDeploymentScope(config, options.deploymentId);
    const items: {key: string; namespace?: string; fresh: boolean}[] = [];
    const shared = (key: string) =>
        items.push({key, namespace: scope.sharedNamespace, fresh: !!options.freshShared});
    const vault = (key: string) =>
        items.push({key, namespace: scope.vaultNamespace, fresh: !!options.fresh});
    shared("AccessManager");
    shared("PauseManager");
    if (config.usdc.deployMock) shared("MockUSDC");
    shared("AllowlistStub");
    for (const key of ["ReservoirUSDC", "MZUSD", "IssuanceVault"]) vault(key);
    for (const tranche of config.tranches) vault(`Tranche.${tranche.key}`);
    vault("LossManager");
    if (config.navOracle.deployMockFeeds) {
        vault("MockNavOracle");
        vault("MockTotalSupplyOracle");
    }
    vault("NavOracleAutomation");
    if (config.umbrellaFinalizer?.enabled) {
        for (const tranche of config.tranches.filter((item) => !item.directWithdrawEnabled)) {
            vault(`UmbrellaEpochFinalizer.${tranche.key}`);
        }
    }
    if (
        options.freshShared &&
        !options.fresh &&
        items.some(
            (item) =>
                item.namespace === scope.vaultNamespace &&
                !item.fresh &&
                getLatestDeployment(deployments, networkName, item.key, item.namespace)
        )
    ) {
        throw new Error(
            "Cannot replace shared infrastructure while reusing existing vault contracts"
        );
    }
    return {
        network: networkName,
        ...scope,
        note: "Record-based plan only; execution also checks deployed code and applies configuration and roles.",
        asset: config.usdc.deployMock ? "MockUSDC" : config.usdc.address,
        contracts: items.map(({key, namespace, fresh}) => {
            const record = getLatestDeployment(deployments, networkName, key, namespace);
            return {
                key,
                namespace: namespace ?? "legacy",
                action: fresh || !record ? "deploy" : "reuse",
                address: record?.address,
            };
        }),
    };
}
