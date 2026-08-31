import fs from "fs";
import path from "path";

export interface DeploymentRecord {
    version: number;
    address: string;
    implementation?: string;
    txHash?: string;
    deployedAt?: string;
}

export type DeploymentNamespace = Record<string, DeploymentRecord[]>;
export type NetworkDeployments = Record<string, DeploymentRecord[] | DeploymentNamespace>;
export type DeploymentsFile = Record<string, NetworkDeployments>;

const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH
    ? path.resolve(process.env.DEPLOYMENTS_PATH)
    : path.join(__dirname, "..", "..", "..", "reports", "deployments.json");

export function loadDeployments(): DeploymentsFile {
    if (!fs.existsSync(DEPLOYMENTS_PATH)) return {};
    const raw = fs.readFileSync(DEPLOYMENTS_PATH, "utf8");
    return raw ? JSON.parse(raw) : {};
}

export function saveDeployments(data: DeploymentsFile) {
    fs.mkdirSync(path.dirname(DEPLOYMENTS_PATH), {recursive: true});
    fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(data, null, 2));
}

export function recordDeployment(
    data: DeploymentsFile,
    networkName: string,
    key: string,
    info: Omit<DeploymentRecord, "version">,
    namespace?: string
): DeploymentRecord {
    if (!data[networkName]) data[networkName] = {};

    const deployments = resolveNamespace(data[networkName], namespace, true);
    if (!deployments[key]) deployments[key] = [];

    const arr = deployments[key];
    const record: DeploymentRecord = {
        version: arr.length + 1,
        ...info,
    };
    arr.push(record);
    return record;
}

export function getLatestDeployment(
    data: DeploymentsFile,
    networkName: string,
    key: string,
    namespace?: string
): DeploymentRecord | undefined {
    const net = data[networkName];
    if (!net) return undefined;

    const deployments = resolveNamespace(net, namespace, false);
    const arr = deployments[key];
    if (!arr || arr.length === 0) return undefined;
    return arr[arr.length - 1];
}

function resolveNamespace(
    networkDeployments: NetworkDeployments,
    namespace: string | undefined,
    create: boolean
): DeploymentNamespace {
    if (!namespace) return networkDeployments as DeploymentNamespace;

    const existing = networkDeployments[namespace];
    if (Array.isArray(existing)) {
        throw new Error(`Deployment namespace conflicts with legacy contract key: ${namespace}`);
    }
    if (existing) return existing;
    if (!create) return {};

    const deployments: DeploymentNamespace = {};
    networkDeployments[namespace] = deployments;
    return deployments;
}
