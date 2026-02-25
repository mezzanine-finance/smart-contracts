import fs from "fs";
import path from "path";
import {ethers} from "hardhat";
import {assert, parseBps, parseMZUSD, parseUSDC, requireAddress} from "./helpers";

export interface RoleIdsConfig {
    PAUSER_ROLE: number;
    UNPAUSER_ROLE: number;
    UPGRADER_ROLE: number;
    RESERVOIR_WITHDRAW_ROLE: number;
    KEEPER_ROLE: number;
    ORACLE_ROLE: number;
    BURNER_ROLE: number;
}

export interface RolesConfig {
    admin: string;
    pauser: string;
    unpauser: string;
    upgrader: string;
    reservoirWithdrawers: string[];
    keepers?: string[];
    roleDelays?: {
        unpauser?: number;
        upgrader?: number;
        pauser?: number;
        reservoirWithdraw?: number;
        keeper?: number;
        oracle?: number;
        burner?: number;
    };
    oracles?: string[];
}

export interface DevConfig {
    deployer: string;
    grantRoles?: boolean;
}

export interface UsdcMockMint {
    to: string;
    amount: string;
}

export interface UsdcConfig {
    address?: string;
    deployMock?: boolean;
    mock?: {
        name: string;
        symbol: string;
        decimals: number;
        initialMints: UsdcMockMint[];
    };
}

export interface MZUSDConfig {
    redemptionCapUSDC: string;
    redemptionWindowDurationSec?: number;
    withdrawalFeeBps?: number;
}

export interface VaultConfig {
    performanceFeeBps: number;
    protocolFeeBps: number;
    performanceFeeReceiver: string;
    protocolFeeReceiver: string;
    idleBufferUSDC?: string;
    hysteresisBps?: number;
    epochDurationSec?: number;
}

export interface TrancheConfig {
    key: string;
    trancheId?: number;
    id?: number; // deprecated alias for trancheId
    name: string;
    symbol: string;
    riskPremiumBps: number;
    enabled: boolean;
    directWithdrawEnabled: boolean;
    unstakeDelayEpochs?: number;
    unstakeYieldReductionBps?: number;
    cancelUnstakeFeeBps?: number;
    depositLimits?: {
        enabled: boolean;
        capMZUSD?: string;
        capUSDC?: string; // deprecated alias; interpreted as USDC and converted to MZUSD
        tvlBps?: number;
    };
}

export interface LossManagerConfig {
    order: string[];
    isPairedWithNext: boolean[];
    maxLossPerTxUSDC?: string;
}

export interface NavOracleConfig {
    vetoPeriodSec: number;
    oracles: string[];
    navFeed?: string;
    totalSupplyFeed?: string;
    maxAnswerStalenessSec?: number;
}

export interface UmbrellaFinalizerConfig {
    enabled: boolean;
    startEpoch?: number;
}

export interface PostDeployConfig {
    renounceDeployerRoles?: boolean;
}

export interface VerifyConfig {
    enabled?: boolean;
}

export interface TrancheSeedConfig {
    key: string;
    amountMZUSD?: string;
    amountUSDC?: string; // deprecated alias; interpreted as USDC and converted to MZUSD
    receiver: string;
}

export interface TrancheDeadSharesConfig {
    key: string;
    amountMZUSD: string;
}

export interface SeedConfig {
    mzusdDepositUSDC?: string;
    vaultUSDC?: string;
    reservoirUSDC?: string;
    deadShares?: TrancheDeadSharesConfig[];
    trancheDeposits?: TrancheSeedConfig[];
}

export interface DeployConfig {
    version: number;
    dev: DevConfig;
    roleIds: RoleIdsConfig;
    roles: RolesConfig;
    usdc: UsdcConfig;
    mzusd: MZUSDConfig;
    vault: VaultConfig;
    tranches: TrancheConfig[];
    lossManager: LossManagerConfig;
    navOracle: NavOracleConfig;
    umbrellaFinalizer?: UmbrellaFinalizerConfig;
    postDeploy?: PostDeployConfig;
    verify?: VerifyConfig;
    seed?: SeedConfig;
}

const CONFIG_DIR = path.join(__dirname, "..", "config");

export function resolveConfigPath(networkName: string, overridePath?: string): string {
    if (overridePath) return path.resolve(overridePath);
    return path.join(CONFIG_DIR, `${networkName}.json`);
}

export function loadConfig(networkName: string, overridePath?: string): DeployConfig {
    const filePath = resolveConfigPath(networkName, overridePath);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Config file not found: ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const config = JSON.parse(raw) as DeployConfig;
    validateConfig(config, filePath);
    return config;
}

function validateConfig(config: DeployConfig, filePath: string) {
    assert(typeof config.version === "number", `Missing version in ${filePath}`);
    const roleIds = config.roleIds;
    assert(roleIds !== undefined, `Missing roleIds in ${filePath}`);
    const seenRoleIds = new Set<number>();
    for (const [name, value] of Object.entries(roleIds)) {
        assert(Number.isSafeInteger(value), `roleIds.${name} must be a safe integer`);
        assert(value > 0, `roleIds.${name} must be > 0`);
        assert(!seenRoleIds.has(value), `roleIds.${name} duplicates role id ${value}`);
        seenRoleIds.add(value);
    }

    requireAddress(config.dev.deployer, "dev.deployer");

    const roles = config.roles;
    requireAddress(roles.admin, "roles.admin");
    requireAddress(roles.pauser, "roles.pauser");
    requireAddress(roles.unpauser, "roles.unpauser");
    requireAddress(roles.upgrader, "roles.upgrader");
    for (const addr of roles.reservoirWithdrawers ?? []) {
        requireAddress(addr, "roles.reservoirWithdrawers");
    }
    for (const addr of roles.keepers ?? []) {
        requireAddress(addr, "roles.keepers");
    }
    for (const addr of roles.oracles ?? []) {
        requireAddress(addr, "roles.oracles");
    }

    const usdc = config.usdc;
    if (usdc.deployMock) {
        assert(usdc.mock !== undefined, "usdc.mock is required when deployMock = true");
        assert(usdc.mock.decimals === 6, "mock USDC must use 6 decimals");
        for (const mint of usdc.mock.initialMints ?? []) {
            requireAddress(mint.to, "usdc.mock.initialMints.to");
        }
    } else {
        requireAddress(usdc.address ?? "", "usdc.address");
    }

    const vault = config.vault;
    parseBps(vault.performanceFeeBps);
    parseBps(vault.protocolFeeBps);
    if (vault.hysteresisBps !== undefined) {
        parseBps(vault.hysteresisBps);
    }
    if (vault.performanceFeeBps + vault.protocolFeeBps > 5000) {
        throw new Error("IssuanceVault fees exceed MAX_TOTAL_FEE_BPS (5000)");
    }
    requireAddress(vault.performanceFeeReceiver, "vault.performanceFeeReceiver");
    requireAddress(vault.protocolFeeReceiver, "vault.protocolFeeReceiver");
    assert(
        vault.performanceFeeReceiver.toLowerCase() !== vault.protocolFeeReceiver.toLowerCase(),
        "IssuanceVault fee receivers must be distinct"
    );

    const tranches = config.tranches ?? [];
    assert(tranches.length > 0, "At least one tranche must be configured");
    const keys = new Set<string>();
    for (const tranche of tranches) {
        assert(tranche.key, "Tranche key is required");
        assert(!keys.has(tranche.key), `Duplicate tranche key: ${tranche.key}`);
        keys.add(tranche.key);
        parseBps(tranche.riskPremiumBps);
        const trancheId = tranche.trancheId ?? tranche.id;
        assert(trancheId !== undefined, `Tranche trancheId is required: ${tranche.key}`);
        assert(trancheId > 0, `Tranche trancheId must be > 0: ${tranche.key}`);
        if (tranche.unstakeYieldReductionBps !== undefined) {
            parseBps(tranche.unstakeYieldReductionBps);
            assert(
                tranche.unstakeYieldReductionBps < 10_000,
                `Tranche ${tranche.key}: unstakeYieldReductionBps must be < 10_000`
            );
        }
        if (tranche.cancelUnstakeFeeBps !== undefined) {
            parseBps(tranche.cancelUnstakeFeeBps);
            assert(
                tranche.cancelUnstakeFeeBps < 10_000,
                `Tranche ${tranche.key}: cancelUnstakeFeeBps must be < 10_000`
            );
        }
        if (tranche.depositLimits) {
            if (
                tranche.depositLimits.capMZUSD !== undefined &&
                tranche.depositLimits.capUSDC !== undefined
            ) {
                throw new Error(
                    `Tranche ${tranche.key}: specify only one of depositLimits.capMZUSD or depositLimits.capUSDC`
                );
            }
            if (tranche.depositLimits.capMZUSD !== undefined) {
                parseMZUSD(tranche.depositLimits.capMZUSD);
            }
            if (tranche.depositLimits.capUSDC !== undefined) {
                parseUSDC(tranche.depositLimits.capUSDC);
            }
            if (tranche.depositLimits.tvlBps !== undefined) {
                parseBps(tranche.depositLimits.tvlBps);
            }
        }
    }

    const loss = config.lossManager;
    assert(
        loss.order.length === loss.isPairedWithNext.length,
        "lossManager order/isPairedWithNext mismatch"
    );
    for (const key of loss.order) {
        assert(keys.has(key), `lossManager.order references unknown tranche key: ${key}`);
    }

    for (let i = 0; i < loss.isPairedWithNext.length; ) {
        if (!loss.isPairedWithNext[i]) {
            i += 1;
            continue;
        }

        if (i + 1 >= loss.isPairedWithNext.length || !loss.isPairedWithNext[i + 1]) {
            throw new Error(
                `lossManager.isPairedWithNext must use contiguous true/true pairs (index ${i})`
            );
        }

        i += 2;
    }

    if (config.navOracle.oracles.length === 0) {
        throw new Error("navOracle.oracles must include at least one address");
    }

    for (const addr of config.navOracle.oracles) {
        requireAddress(addr, "navOracle.oracles");
    }
    if (config.navOracle.navFeed) {
        requireAddress(config.navOracle.navFeed, "navOracle.navFeed");
    }
    if (config.navOracle.totalSupplyFeed) {
        requireAddress(config.navOracle.totalSupplyFeed, "navOracle.totalSupplyFeed");
    }
    if (config.navOracle.maxAnswerStalenessSec !== undefined) {
        assert(
            Number.isInteger(config.navOracle.maxAnswerStalenessSec) &&
                config.navOracle.maxAnswerStalenessSec > 0 &&
                config.navOracle.maxAnswerStalenessSec <= 0xffff_ffff,
            "navOracle.maxAnswerStalenessSec must be in range [1, 4294967295]"
        );
    }

    if (roles.oracles && roles.oracles.length > 0) {
        for (const addr of roles.oracles) {
            requireAddress(addr, "roles.oracles");
        }
        const mismatch = roles.oracles.some(
            (addr) =>
                !config.navOracle.oracles.some(
                    (oracle) => oracle.toLowerCase() === addr.toLowerCase()
                )
        );
        if (mismatch) {
            throw new Error("roles.oracles must match navOracle.oracles when provided");
        }
    }

    assert(
        ethers.isAddress(config.roles.admin),
        `roles.admin must be a valid address in ${filePath}`
    );

    const seed = config.seed;
    if (seed?.mzusdDepositUSDC) {
        parseUSDC(seed.mzusdDepositUSDC);
    }
    if (seed?.vaultUSDC) {
        parseUSDC(seed.vaultUSDC);
    }
    if (seed?.reservoirUSDC) {
        parseUSDC(seed.reservoirUSDC);
    }
    if (seed?.deadShares) {
        const seenDeadShares = new Set<string>();
        for (const deadShare of seed.deadShares) {
            assert(deadShare.key, "seed.deadShares.key is required");
            assert(
                keys.has(deadShare.key),
                `seed.deadShares references unknown tranche: ${deadShare.key}`
            );
            assert(
                !seenDeadShares.has(deadShare.key),
                `seed.deadShares has duplicate tranche key: ${deadShare.key}`
            );
            seenDeadShares.add(deadShare.key);
            assert(
                deadShare.amountMZUSD !== undefined,
                `seed.deadShares for ${deadShare.key}: amountMZUSD is required`
            );
            const amount = parseMZUSD(deadShare.amountMZUSD);
            assert(amount > 0n, `seed.deadShares for ${deadShare.key}: amountMZUSD must be > 0`);
        }
    }
    if (seed?.trancheDeposits) {
        for (const deposit of seed.trancheDeposits) {
            assert(deposit.key, "seed.trancheDeposits.key is required");
            assert(
                keys.has(deposit.key),
                `seed.trancheDeposits references unknown tranche: ${deposit.key}`
            );
            requireAddress(deposit.receiver, "seed.trancheDeposits.receiver");
            if (deposit.amountMZUSD !== undefined && deposit.amountUSDC !== undefined) {
                throw new Error(
                    `seed.trancheDeposits for ${deposit.key}: specify only one of amountMZUSD or amountUSDC`
                );
            }
            if (deposit.amountMZUSD !== undefined) {
                parseMZUSD(deposit.amountMZUSD);
            } else if (deposit.amountUSDC !== undefined) {
                parseUSDC(deposit.amountUSDC);
            } else {
                throw new Error(
                    `seed.trancheDeposits for ${deposit.key}: amountMZUSD is required (amountUSDC is deprecated)`
                );
            }
        }
    }

    if (config.umbrellaFinalizer?.startEpoch !== undefined) {
        assert(
            Number.isSafeInteger(config.umbrellaFinalizer.startEpoch),
            "umbrellaFinalizer.startEpoch must be a safe integer"
        );
        assert(config.umbrellaFinalizer.startEpoch > 0, "umbrellaFinalizer.startEpoch must be > 0");
    }

    if (config.mzusd.withdrawalFeeBps !== undefined) {
        parseBps(config.mzusd.withdrawalFeeBps);
    }
}
