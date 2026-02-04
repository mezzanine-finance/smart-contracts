import {ethers} from "hardhat";
import {parseUnits} from "ethers";

export const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

export function isLocalNetwork(name: string) {
    return LOCAL_NETWORKS.has(name);
}

export function getArg(flag: string): string | undefined {
    const idx = process.argv.indexOf(flag);
    if (idx === -1) return undefined;
    return process.argv[idx + 1];
}

export function hasFlag(flag: string): boolean {
    return process.argv.includes(flag);
}

export function requireAddress(value: string, label: string): string {
    if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
        throw new Error(`Invalid ${label} address: ${value}`);
    }
    return value;
}

export function parseUSDC(value: string | number | bigint): bigint {
    return parseUnits(value.toString(), 6);
}

export function parseBps(value: number): number {
    if (value < 0 || value > 10_000) {
        throw new Error(`Invalid bps value: ${value}`);
    }
    return value;
}

export function toNumber(value: bigint): number {
    return Number(value);
}

export function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}
