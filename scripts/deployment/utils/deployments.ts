import fs from "fs";
import path from "path";

export type DeploymentRecord = {
  version: number;
  address: string;
  implementation?: string;
  txHash?: string;
  deployedAt?: string;
};

export type NetworkDeployments = {
  [contractKey: string]: DeploymentRecord[];
};

export type DeploymentsFile = {
  [networkName: string]: NetworkDeployments;
};

const DEPLOYMENTS_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "reports",
  "deployments.json"
);

export function loadDeployments(): DeploymentsFile {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    return {};
  }
  const raw = fs.readFileSync(DEPLOYMENTS_PATH, "utf8");
  return raw ? JSON.parse(raw) : {};
}

export function saveDeployments(data: DeploymentsFile) {
  fs.mkdirSync(path.dirname(DEPLOYMENTS_PATH), { recursive: true });
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(data, null, 2));
}

export function recordDeployment(
  data: DeploymentsFile,
  networkName: string,
  key: string,
  info: Omit<DeploymentRecord, "version">
): DeploymentRecord {
  if (!data[networkName]) data[networkName] = {};
  if (!data[networkName][key]) data[networkName][key] = [];

  const arr = data[networkName][key];
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
  key: string
): DeploymentRecord | undefined {
  const net = data[networkName];
  if (!net) return undefined;
  const arr = net[key];
  if (!arr || arr.length === 0) return undefined;
  return arr[arr.length - 1];
}
