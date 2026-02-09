import {ethers, network, upgrades} from "hardhat";
import {BaseContract} from "ethers";
import type {
    AccessManager,
    LossManager,
    MZUSD,
    MockUSDC,
    NavOracleAutomation,
    PauseManager,
    PolJuniorTranche,
    ReservoirUSDC,
    Tranche,
    UmbrellaEpochFinalizer,
    Vault,
} from "../../typechain-types";
import {loadConfig} from "./lib/config";
import {
    loadDeployments,
    saveDeployments,
    recordDeployment,
    getLatestDeployment,
} from "./lib/deployments";
import {log, format} from "./lib/logger";
import {assert, getArg, hasFlag, isLocalNetwork, parseUSDC, requireAddress} from "./lib/helpers";
import {ensureRoleMember, ensureTargetRole} from "./lib/roles";
import {verifyContract} from "./lib/verify";

interface DeployResult<T extends BaseContract> {
    contract: T;
    address: string;
    implementation?: string;
}

const MZUSD_SCALE = 1_000_000_000_000n;
const BPS = 10_000n;

async function hasCode(address: string) {
    const code = await ethers.provider.getCode(address);
    return code !== "0x";
}

async function ensureDeployment<T extends BaseContract>(
    name: string,
    factory: {attach: (address: string) => unknown},
    deploy: () => Promise<T>,
    fresh: boolean,
    deployments: ReturnType<typeof loadDeployments>
): Promise<DeployResult<T>> {
    if (!fresh) {
        const existing = getLatestDeployment(deployments, network.name, name);
        if (existing && (await hasCode(existing.address))) {
            log.info(`Reusing ${name} at ${existing.address}`);
            return {
                contract: factory.attach(existing.address) as T,
                address: existing.address,
                implementation: existing.implementation,
            };
        }
    }

    log.step(`Deploying ${name}`);
    const contract = await deploy();
    const address = await contract.getAddress();
    const tx = contract.deploymentTransaction();
    await contract.waitForDeployment();

    recordDeployment(deployments, network.name, name, {
        address,
        txHash: tx?.hash,
        deployedAt: new Date().toISOString(),
    });

    log.success(`${name} deployed at ${address}`);
    return {contract, address};
}

async function ensureProxyDeployment<T extends BaseContract>(
    name: string,
    factory: {attach: (address: string) => unknown},
    deploy: () => Promise<T>,
    fresh: boolean,
    deployments: ReturnType<typeof loadDeployments>
): Promise<DeployResult<T>> {
    if (!fresh) {
        const existing = getLatestDeployment(deployments, network.name, name);
        if (existing && (await hasCode(existing.address))) {
            const impl = await upgrades.erc1967.getImplementationAddress(existing.address);
            log.info(`Reusing ${name} proxy at ${existing.address}`);
            return {
                contract: factory.attach(existing.address) as T,
                address: existing.address,
                implementation: impl,
            };
        }
    }

    log.step(`Deploying ${name} (proxy)`);
    const contract = await deploy();
    const tx = contract.deploymentTransaction();
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const impl = await upgrades.erc1967.getImplementationAddress(address);

    recordDeployment(deployments, network.name, name, {
        address,
        implementation: impl,
        txHash: tx?.hash,
        deployedAt: new Date().toISOString(),
    });

    log.success(`${name} proxy deployed at ${address}`);
    return {contract, address, implementation: impl};
}

async function main() {
    const configPath = getArg("--config");
    const fresh = hasFlag("--fresh");
    const skipVerify = hasFlag("--skip-verify");
    const forceRenounce = hasFlag("--renounce");
    const skipRenounce = hasFlag("--no-renounce");

    const config = loadConfig(network.name, configPath);
    upgrades.silenceWarnings();

    const [deployer] = await ethers.getSigners();
    const deployerAddress = await deployer.getAddress();
    const devDeployer = config.dev.deployer;

    log.step("Deployment preflight");
    log.info(`Network: ${network.name}`);
    log.info(`Deployer: ${format.addr(deployerAddress)}`);
    log.info(`Dev deployer: ${format.addr(devDeployer)}`);
    log.info(`Final admin: ${format.addr(config.roles.admin)}`);
    log.info(
        `Config: ${format.addr(configPath ?? `scripts/deployment/config/${network.name}.json`)}`
    );

    const ethBalance = await ethers.provider.getBalance(deployerAddress);
    assert(ethBalance > 0n, "Deployer ETH balance is zero");

    let adminSigner = deployer;
    if (devDeployer.toLowerCase() !== deployerAddress.toLowerCase()) {
        if (isLocalNetwork(network.name)) {
            log.warn(`Impersonating dev.deployer on ${network.name}: ${devDeployer}`);
            await network.provider.send("hardhat_setBalance", [
                devDeployer,
                "0x3635C9ADC5DEA00000",
            ]);
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [devDeployer],
            });
            adminSigner = await ethers.getSigner(devDeployer);
        } else {
            throw new Error(
                `Deployer must be dev.deployer. Config dev=${devDeployer}, deployer=${deployerAddress}`
            );
        }
    }

    const shouldVerify =
        config.verify?.enabled !== false && !skipVerify && !isLocalNetwork(network.name);

    const deployments = loadDeployments();

    // === Deploy core contracts ===
    const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
    const accessManager = await ensureDeployment<AccessManager>(
        "AccessManager",
        AccessManagerFactory,
        async () => AccessManagerFactory.deploy(devDeployer),
        fresh,
        deployments
    );

    const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
    const pauseManager = await ensureProxyDeployment<PauseManager>(
        "PauseManager",
        PauseManagerFactory,
        async () =>
            upgrades.deployProxy(PauseManagerFactory, [accessManager.address], {
                kind: "uups",
                initializer: "initialize",
            }),
        fresh,
        deployments
    );

    let mockUsdc: DeployResult<MockUSDC> | undefined;
    let usdcAddress: string;
    if (!config.usdc.deployMock) {
        requireAddress(config.usdc.address ?? "", "usdc.address");
        usdcAddress = config.usdc.address!;
    } else {
        const mock = config.usdc.mock!;
        const MockUSDCFactory = await ethers.getContractFactory("MockUSDC", deployer);
        mockUsdc = await ensureDeployment<MockUSDC>(
            "MockUSDC",
            MockUSDCFactory,
            async () => MockUSDCFactory.deploy(),
            fresh,
            deployments
        );

        const mockUsdcAdmin = mockUsdc.contract.connect(adminSigner);
        for (const mint of mock.initialMints ?? []) {
            const amount = parseUSDC(mint.amount);
            log.info(`Minting ${mint.amount} USDC to ${mint.to}`);
            const tx = await mockUsdcAdmin.mint(mint.to, amount);
            await tx.wait();
        }

        usdcAddress = mockUsdc.address;
    }

    const usdcToken = await ethers.getContractAt("IERC20Metadata", usdcAddress, deployer);
    const usdcDecimals = await usdcToken.decimals();
    assert(Number(usdcDecimals) === 6, `USDC decimals must be 6 (got ${usdcDecimals})`);

    const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
    const reservoir = await ensureProxyDeployment<ReservoirUSDC>(
        "ReservoirUSDC",
        ReservoirFactory,
        async () =>
            upgrades.deployProxy(ReservoirFactory, [accessManager.address, pauseManager.address], {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [usdcAddress],
            }),
        fresh,
        deployments
    );

    const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
    const mzusd = await ensureProxyDeployment<MZUSD>(
        "MZUSD",
        MZUSDFactory,
        async () =>
            upgrades.deployProxy(
                MZUSDFactory,
                [
                    accessManager.address,
                    pauseManager.address,
                    parseUSDC(config.mzusd.redemptionCapUSDC),
                ],
                {
                    kind: "uups",
                    initializer: "initialize",
                    unsafeAllow: ["constructor", "state-variable-immutable"],
                    constructorArgs: [usdcAddress],
                }
            ),
        fresh,
        deployments
    );

    const VaultFactory = await ethers.getContractFactory("Vault", deployer);
    const vault = await ensureProxyDeployment<Vault>(
        "Vault",
        VaultFactory,
        async () =>
            upgrades.deployProxy(
                VaultFactory,
                [
                    config.vault.performanceFeeBps,
                    config.vault.performanceFeeReceiver,
                    config.vault.protocolFeeBps,
                    config.vault.protocolFeeReceiver,
                ],
                {
                    kind: "uups",
                    initializer: "initialize",
                    unsafeAllow: ["constructor", "state-variable-immutable"],
                    constructorArgs: [mzusd.address, reservoir.address],
                }
            ),
        fresh,
        deployments
    );

    // === Deploy tranches ===
    const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
    const trancheByKey = new Map<string, DeployResult<Tranche>>();
    for (const tranche of config.tranches) {
        const key = `Tranche.${tranche.key}`;
        const result = await ensureProxyDeployment<Tranche>(
            key,
            TrancheFactory,
            async () =>
                upgrades.deployProxy(
                    TrancheFactory,
                    [
                        mzusd.address,
                        vault.address,
                        tranche.id,
                        tranche.unstakeDelayEpochs ?? 0,
                        tranche.name,
                        tranche.symbol,
                        accessManager.address,
                        pauseManager.address,
                    ],
                    {
                        kind: "uups",
                        initializer: "initialize",
                        unsafeAllow: ["constructor", "state-variable-immutable"],
                        constructorArgs: [tranche.directWithdrawEnabled],
                    }
                ),
            fresh,
            deployments
        );
        trancheByKey.set(tranche.key, result);
    }

    let polJunior: DeployResult<PolJuniorTranche> | undefined;
    if (config.polJunior?.enabled) {
        const PolFactory = await ethers.getContractFactory("PolJuniorTranche", deployer);
        polJunior = await ensureProxyDeployment<PolJuniorTranche>(
            "PolJuniorTranche",
            PolFactory,
            async () =>
                upgrades.deployProxy(
                    PolFactory,
                    [
                        mzusd.address,
                        vault.address,
                        accessManager.address,
                        pauseManager.address,
                        config.polJunior!.polPayout,
                    ],
                    {
                        kind: "uups",
                        initializer: "initialize",
                        unsafeAllow: ["constructor", "state-variable-immutable"],
                        constructorArgs: [vault.address],
                    }
                ),
            fresh,
            deployments
        );
    }

    const orderAddresses = config.lossManager.order.map((key) => {
        if (key === "polJunior") {
            assert(polJunior, "polJunior is required for lossManager.order");
            return polJunior.address;
        }
        const tranche = trancheByKey.get(key);
        assert(tranche !== undefined, `Unknown tranche key in lossManager.order: ${key}`);
        return tranche.address;
    });

    const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
    const lossManager = await ensureProxyDeployment<LossManager>(
        "LossManager",
        LossManagerFactory,
        async () =>
            upgrades.deployProxy(
                LossManagerFactory,
                [
                    mzusd.address,
                    vault.address,
                    orderAddresses,
                    config.lossManager.isPairedWithNext,
                    parseUSDC(config.lossManager.maxLossPerTxUSDC ?? "0"),
                ],
                {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
            ),
        fresh,
        deployments
    );

    const NavFactory = await ethers.getContractFactory("NavOracleAutomation", deployer);
    const navOracle = await ensureDeployment<NavOracleAutomation>(
        "NavOracleAutomation",
        NavFactory,
        async () =>
            NavFactory.deploy(
                accessManager.address,
                mzusd.address,
                vault.address,
                lossManager.address,
                config.navOracle.vetoPeriodSec
            ),
        fresh,
        deployments
    );

    const accessManagerAdmin = accessManager.contract.connect(adminSigner);
    const vaultAdmin = vault.contract.connect(adminSigner);
    const mzusdAdmin = mzusd.contract.connect(adminSigner);
    const lossManagerAdmin = lossManager.contract.connect(adminSigner);
    const navOracleAdmin = navOracle.contract.connect(adminSigner);

    const finalizers: DeployResult<UmbrellaEpochFinalizer>[] = [];
    const finalizerByKey = new Map<string, DeployResult<UmbrellaEpochFinalizer>>();
    if (config.umbrellaFinalizer?.enabled) {
        const FinalizerFactory = await ethers.getContractFactory(
            "UmbrellaEpochFinalizer",
            deployer
        );
        const finalizerStartEpoch = BigInt(config.umbrellaFinalizer.startEpoch ?? 1);
        for (const tranche of config.tranches) {
            if (tranche.directWithdrawEnabled) continue;
            const trancheContract = trancheByKey.get(tranche.key)!;
            const key = `UmbrellaEpochFinalizer.${tranche.key}`;
            const finalizer = await ensureDeployment<UmbrellaEpochFinalizer>(
                key,
                FinalizerFactory,
                async () => FinalizerFactory.deploy(trancheContract.address, finalizerStartEpoch),
                fresh,
                deployments
            );
            finalizers.push(finalizer);
            finalizerByKey.set(tranche.key, finalizer);
        }
    }

    // === Validate automation contracts ===
    log.step("Validating automation contracts");
    assert(
        (await navOracle.contract.authority()).toLowerCase() ===
            accessManager.address.toLowerCase(),
        "NavOracleAutomation.authority mismatch"
    );
    assert(
        (await navOracle.contract.mzusd()).toLowerCase() === mzusd.address.toLowerCase(),
        "NavOracleAutomation.mzusd mismatch"
    );
    assert(
        (await navOracle.contract.vault()).toLowerCase() === vault.address.toLowerCase(),
        "NavOracleAutomation.vault mismatch"
    );
    assert(
        (await navOracle.contract.lossManager()).toLowerCase() ===
            lossManager.address.toLowerCase(),
        "NavOracleAutomation.lossManager mismatch"
    );
    if (config.umbrellaFinalizer?.enabled) {
        for (const tranche of config.tranches) {
            if (tranche.directWithdrawEnabled) continue;
            const finalizer = finalizerByKey.get(tranche.key);
            assert(finalizer, `UmbrellaEpochFinalizer missing for tranche ${tranche.key}`);
            const trancheContract = trancheByKey.get(tranche.key)!;
            assert(
                (await finalizer.contract.tranche()).toLowerCase() ===
                    trancheContract.address.toLowerCase(),
                `UmbrellaEpochFinalizer.tranche mismatch for ${tranche.key}`
            );
        }
    }

    // === Wire core references ===
    log.step("Wiring core references");
    if ((await mzusd.contract.vault()) === ethers.ZeroAddress) {
        await (await mzusdAdmin.setVault(vault.address)).wait();
        log.success("MZUSD.setVault wired");
    }

    if ((await reservoir.contract.vault()) === ethers.ZeroAddress) {
        await (await reservoir.contract.connect(adminSigner).setVault(vault.address)).wait();
        log.success("ReservoirUSDC.setVault wired");
    }

    if ((await vault.contract.lossManager()) === ethers.ZeroAddress) {
        await (await vaultAdmin.setLossManager(lossManager.address)).wait();
        log.success("Vault.setLossManager wired");
    }

    if ((await vault.contract.navOracle()) !== navOracle.address) {
        await (await vaultAdmin.setNavOracle(navOracle.address)).wait();
        log.success("Vault.setNavOracle wired");
    }

    if ((await lossManager.contract.navOracle()) !== navOracle.address) {
        await (await lossManagerAdmin.setNavOracle(navOracle.address)).wait();
        log.success("LossManager.setNavOracle wired");
    }

    if ((await mzusd.contract.lossManager()) === ethers.ZeroAddress) {
        await (await mzusdAdmin.setLossManager(lossManager.address)).wait();
        log.success("MZUSD.setLossManager wired");
    }

    // === Register tranches ===
    log.step("Registering tranches");
    for (const tranche of config.tranches) {
        const trancheContract = trancheByKey.get(tranche.key)!;
        const isRegistered = await vault.contract.isTranche(trancheContract.address);
        if (!isRegistered) {
            await (
                await vaultAdmin.addTranche({
                    tranche: trancheContract.address,
                    weight: tranche.weight,
                    enabled: tranche.enabled,
                })
            ).wait();
            log.success(`Vault.addTranche ${tranche.key}`);
        } else {
            const len = Number(await vault.contract.tranchesLength());
            for (let i = 0; i < len; i += 1) {
                const info = await vault.contract.tranches(i);
                if (info.tranche.toLowerCase() === trancheContract.address.toLowerCase()) {
                    const desiredWeight = BigInt(tranche.weight);
                    if (info.weight !== desiredWeight || info.enabled !== tranche.enabled) {
                        await (
                            await vaultAdmin.updateTranche(i, tranche.weight, tranche.enabled)
                        ).wait();
                        log.success(`Vault.updateTranche ${tranche.key}`);
                    }
                    break;
                }
            }
        }
    }

    if (config.polJunior?.enabled && config.polJunior.registerInVault) {
        assert(polJunior, "polJunior deployment missing");
        const enabled = config.polJunior.enabledInVault ?? true;
        const weight = config.polJunior.weight ?? 0;
        const isRegistered = await vault.contract.isTranche(polJunior.address);
        if (!isRegistered) {
            await (
                await vaultAdmin.addTranche({
                    tranche: polJunior.address,
                    weight,
                    enabled,
                })
            ).wait();
            log.success("Vault.addTranche polJunior");
        } else {
            const len = Number(await vault.contract.tranchesLength());
            for (let i = 0; i < len; i += 1) {
                const info = await vault.contract.tranches(i);
                if (info.tranche.toLowerCase() === polJunior.address.toLowerCase()) {
                    const desiredWeight = BigInt(weight);
                    if (info.weight !== desiredWeight || info.enabled !== enabled) {
                        await (await vaultAdmin.updateTranche(i, weight, enabled)).wait();
                        log.success("Vault.updateTranche polJunior");
                    }
                    break;
                }
            }
        }
    }

    // === Apply tranche parameters ===
    log.step("Applying tranche parameters");
    for (const tranche of config.tranches) {
        const trancheContract = trancheByKey.get(tranche.key)!;
        const trancheAdmin = trancheContract.contract.connect(adminSigner);
        if (tranche.unstakeDelayEpochs !== undefined) {
            const current = await trancheContract.contract.unstakeDelayEpochs();
            if (current !== BigInt(tranche.unstakeDelayEpochs)) {
                await (await trancheAdmin.setUnstakeDelayEpochs(tranche.unstakeDelayEpochs)).wait();
                log.success(`Tranche.setUnstakeDelayEpochs ${tranche.key}`);
            }
        }

        if (tranche.depositLimits) {
            const enabled = await trancheContract.contract.depositLimitEnabled();
            const cap = await trancheContract.contract.maxDepositCap();
            const tvl = await trancheContract.contract.maxDepositTvlBps();

            const targetEnabled = tranche.depositLimits.enabled;
            const targetCap = BigInt(parseUSDC(tranche.depositLimits.capUSDC ?? "0"));
            const targetTvl = BigInt(tranche.depositLimits.tvlBps ?? 0);

            if (enabled !== targetEnabled || cap !== targetCap || tvl !== targetTvl) {
                await (
                    await trancheAdmin.setDepositLimits(targetEnabled, targetCap, targetTvl)
                ).wait();
                log.success(`Tranche.setDepositLimits ${tranche.key}`);
            }
        }
    }

    if (polJunior) {
        const polJuniorAdmin = polJunior.contract.connect(adminSigner);
        const payout = await polJunior.contract.polPayout();
        if (payout.toLowerCase() !== config.polJunior!.polPayout.toLowerCase()) {
            await (await polJuniorAdmin.setPolPayout(config.polJunior!.polPayout)).wait();
            log.success("PolJuniorTranche.setPolPayout");
        }
    }

    // === Optional seeding ===
    const seed = config.seed;
    if (seed) {
        log.step("Seeding balances");
        const seedSigner = adminSigner;
        const seedAddress = devDeployer;
        const usdcSeeder = usdcToken.connect(seedSigner);
        const mzusdSeeder = mzusd.contract.connect(seedSigner);
        const reservoirSeeder = reservoir.contract.connect(seedSigner);

        const seedMzusdUsdc = parseUSDC(seed.mzusdDepositUSDC ?? "0");
        const seedVaultUsdc = parseUSDC(seed.vaultUSDC ?? "0");
        const seedReservoirUsdc = parseUSDC(seed.reservoirUSDC ?? "0");
        const totalSeedUsdc = seedMzusdUsdc + seedVaultUsdc + seedReservoirUsdc;

        if (totalSeedUsdc > 0n) {
            const balance = await usdcToken.balanceOf(seedAddress);
            assert(
                balance >= totalSeedUsdc,
                `Deployer USDC balance too low for seeding (need ${totalSeedUsdc}, have ${balance})`
            );
        }

        if (seedMzusdUsdc > 0n) {
            await (await usdcSeeder.approve(mzusd.address, seedMzusdUsdc)).wait();
            await (await mzusdSeeder.deposit(seedMzusdUsdc)).wait();
            log.success(`MZUSD.deposit ${seed.mzusdDepositUSDC}`);
        }

        if (seedVaultUsdc > 0n) {
            await (await usdcSeeder.transfer(vault.address, seedVaultUsdc)).wait();
            log.success(`Vault seed ${seed.vaultUSDC}`);
        }

        if (seedReservoirUsdc > 0n) {
            await (await usdcSeeder.approve(reservoir.address, seedReservoirUsdc)).wait();
            await (await reservoirSeeder.deposit(seedReservoirUsdc)).wait();
            log.success(`Reservoir seed ${seed.reservoirUSDC}`);
        }

        if (seed.trancheDeposits && seed.trancheDeposits.length > 0) {
            for (const deposit of seed.trancheDeposits) {
                const tranche = trancheByKey.get(deposit.key);
                assert(tranche !== undefined, `Unknown tranche key in seed: ${deposit.key}`);
                const amountUsdc = parseUSDC(deposit.amountUSDC);
                const amountMzusd = amountUsdc * MZUSD_SCALE;
                const mzBalance = await mzusd.contract.balanceOf(seedAddress);
                assert(
                    mzBalance >= amountMzusd,
                    `Insufficient MZUSD for tranche seed ${deposit.key}`
                );
                await (await mzusdSeeder.approve(tranche.address, amountMzusd)).wait();
                await (
                    await tranche.contract
                        .connect(seedSigner)
                        .deposit(amountMzusd, deposit.receiver)
                ).wait();
                log.success(`Tranche.seed ${deposit.key} ${deposit.amountUSDC}`);
            }
        }
    }

    // === Apply global protocol config ===
    log.step("Applying global protocol config");
    const currentPerfBps = await vault.contract.performanceFeeBps();
    const currentProtBps = await vault.contract.protocolFeeBps();
    const currentPerfReceiver = await vault.contract.performanceFeeReceiver();
    const currentProtReceiver = await vault.contract.protocolFeeReceiver();
    if (
        currentPerfBps !== BigInt(config.vault.performanceFeeBps) ||
        currentProtBps !== BigInt(config.vault.protocolFeeBps)
    ) {
        await (
            await vaultAdmin.setFeeRates(
                config.vault.performanceFeeBps,
                config.vault.protocolFeeBps
            )
        ).wait();
        log.success("Vault.setFeeRates");
    }
    if (
        currentPerfReceiver.toLowerCase() !== config.vault.performanceFeeReceiver.toLowerCase() ||
        currentProtReceiver.toLowerCase() !== config.vault.protocolFeeReceiver.toLowerCase()
    ) {
        await (
            await vaultAdmin.setFeeReceivers(
                config.vault.performanceFeeReceiver,
                config.vault.protocolFeeReceiver
            )
        ).wait();
        log.success("Vault.setFeeReceivers");
    }

    const cap = await mzusd.contract.globalRedemptionCapUSDC();
    const desiredCap = parseUSDC(config.mzusd.redemptionCapUSDC);
    if (cap !== desiredCap) {
        await (await mzusdAdmin.setGlobalRedemptionCap(desiredCap)).wait();
        log.success("MZUSD.setGlobalRedemptionCap");
    }

    if (config.mzusd.redemptionWindowDurationSec !== undefined) {
        const current = await mzusd.contract.redemptionWindowDuration();
        const next = await mzusd.contract.nextRedemptionWindowDuration();
        const desired = config.mzusd.redemptionWindowDurationSec;
        if (current !== BigInt(desired) && next !== BigInt(desired)) {
            await (await mzusdAdmin.setRedemptionWindowDuration(desired)).wait();
            log.success("MZUSD.setRedemptionWindowDuration");
        }
    }

    if (config.vault.idleBufferUSDC !== undefined || config.vault.hysteresisBps !== undefined) {
        assert(
            config.vault.idleBufferUSDC !== undefined && config.vault.hysteresisBps !== undefined,
            "vault.idleBufferUSDC and vault.hysteresisBps must be set together"
        );
        const currentBuffer = await vault.contract.idleBufferUSDC();
        const currentHysteresis = await vault.contract.hysteresisBps();
        const desiredBuffer = parseUSDC(config.vault.idleBufferUSDC ?? "0");
        const desiredHysteresis = BigInt(config.vault.hysteresisBps ?? 0);
        assert(desiredBuffer > 0n, "vault.idleBufferUSDC must be > 0");
        if (currentBuffer !== desiredBuffer || currentHysteresis !== desiredHysteresis) {
            const vaultUsdc = await usdcToken.balanceOf(vault.address);
            const reservoirUsdc = await usdcToken.balanceOf(reservoir.address);
            const low = (desiredBuffer * (BPS - desiredHysteresis)) / BPS;
            if (vaultUsdc < low && reservoirUsdc === 0n) {
                throw new Error(
                    "Vault.setBuffer requires seeded USDC in Vault or Reservoir before rebalance"
                );
            }
            await (await vaultAdmin.setBuffer(desiredBuffer, Number(desiredHysteresis))).wait();
            log.success("Vault.setBuffer");
        }
    }

    if (config.vault.epochDurationSec !== undefined) {
        const current = await vault.contract.epochDuration();
        const pending = await vault.contract.pendingEpochDuration();
        const desired = config.vault.epochDurationSec;
        if (current !== BigInt(desired) && pending !== BigInt(desired)) {
            await (await vaultAdmin.setEpochConfig(desired)).wait();
            log.success("Vault.setEpochConfig queued");
        }
    }

    const [currentOrder, currentPairFlags] = await lossManager.contract.getTrancheOrderAndPairs();
    const orderMatch =
        currentOrder.length === orderAddresses.length &&
        currentOrder.every(
            (addr: string, i: number) => addr.toLowerCase() === orderAddresses[i].toLowerCase()
        );
    const pairFlagsMatch =
        currentPairFlags.length === config.lossManager.isPairedWithNext.length &&
        currentPairFlags.every(
            (flag: boolean, i: number) => flag === config.lossManager.isPairedWithNext[i]
        );
    if (!orderMatch || !pairFlagsMatch) {
        await (
            await lossManagerAdmin.setTrancheOrderAndPairs(
                orderAddresses,
                config.lossManager.isPairedWithNext
            )
        ).wait();
        log.success("LossManager.setTrancheOrderAndPairs");
    }

    if (config.lossManager.maxLossPerTxUSDC !== undefined) {
        const current = await lossManager.contract.maxLossPerTxUSDC();
        const desired = parseUSDC(config.lossManager.maxLossPerTxUSDC);
        if (current !== desired) {
            await (await lossManagerAdmin.setMaxLossPerTxUSDC(desired)).wait();
            log.success("LossManager.setMaxLossPerTxUSDC");
        }
    }

    const currentVeto = await navOracle.contract.vetoPeriod();
    if (currentVeto !== BigInt(config.navOracle.vetoPeriodSec)) {
        await (await navOracleAdmin.setVetoPeriod(config.navOracle.vetoPeriodSec)).wait();
        log.success("NavOracleAutomation.setVetoPeriod");
    }

    // === Configure AccessManager roles ===
    log.step("Configuring AccessManager roles");
    const roleIds = config.roleIds;
    const delays = config.roles.roleDelays ?? {};
    const adminRole = Number(await accessManagerAdmin.ADMIN_ROLE());
    const grantDevRoles = config.dev.grantRoles !== false;

    const pauseSelectors = [
        pauseManager.contract.interface.getFunction("pauseGlobal").selector,
        pauseManager.contract.interface.getFunction("pauseContract").selector,
    ];
    const unpauseSelectors = [
        pauseManager.contract.interface.getFunction("unpauseGlobal").selector,
        pauseManager.contract.interface.getFunction("unpauseContract").selector,
    ];
    await ensureTargetRole(
        accessManagerAdmin,
        pauseManager.address,
        pauseSelectors,
        roleIds.PAUSER_ROLE
    );
    await ensureTargetRole(
        accessManagerAdmin,
        pauseManager.address,
        unpauseSelectors,
        roleIds.UNPAUSER_ROLE
    );
    await ensureTargetRole(
        accessManagerAdmin,
        pauseManager.address,
        [pauseManager.contract.interface.getFunction("upgradeToAndCall").selector],
        roleIds.UPGRADER_ROLE
    );

    await ensureTargetRole(
        accessManagerAdmin,
        vault.address,
        [
            vault.contract.interface.getFunction("setLossManager").selector,
            vault.contract.interface.getFunction("setNavOracle").selector,
            vault.contract.interface.getFunction("setFeeRates").selector,
            vault.contract.interface.getFunction("setFeeReceivers").selector,
            vault.contract.interface.getFunction("setBuffer").selector,
            vault.contract.interface.getFunction("setEpochConfig").selector,
            vault.contract.interface.getFunction("addTranche").selector,
            vault.contract.interface.getFunction("updateTranche").selector,
        ],
        adminRole
    );
    await ensureTargetRole(
        accessManagerAdmin,
        vault.address,
        [vault.contract.interface.getFunction("rebalance").selector],
        roleIds.KEEPER_ROLE
    );
    await ensureTargetRole(
        accessManagerAdmin,
        vault.address,
        [vault.contract.interface.getFunction("upgradeToAndCall").selector],
        roleIds.UPGRADER_ROLE
    );

    await ensureTargetRole(
        accessManagerAdmin,
        mzusd.address,
        [
            mzusd.contract.interface.getFunction("setVault").selector,
            mzusd.contract.interface.getFunction("setGlobalRedemptionCap").selector,
            mzusd.contract.interface.getFunction("setRedemptionWindowDuration").selector,
            mzusd.contract.interface.getFunction("setLossManager").selector,
        ],
        adminRole
    );
    await ensureTargetRole(
        accessManagerAdmin,
        mzusd.address,
        [mzusd.contract.interface.getFunction("burn").selector],
        roleIds.BURNER_ROLE
    );
    await ensureTargetRole(
        accessManagerAdmin,
        mzusd.address,
        [mzusd.contract.interface.getFunction("upgradeToAndCall").selector],
        roleIds.UPGRADER_ROLE
    );

    await ensureTargetRole(
        accessManagerAdmin,
        reservoir.address,
        [reservoir.contract.interface.getFunction("withdraw").selector],
        roleIds.RESERVOIR_WITHDRAW_ROLE
    );
    await ensureTargetRole(
        accessManagerAdmin,
        reservoir.address,
        [reservoir.contract.interface.getFunction("setVault").selector],
        adminRole
    );
    await ensureTargetRole(
        accessManagerAdmin,
        reservoir.address,
        [reservoir.contract.interface.getFunction("upgradeToAndCall").selector],
        roleIds.UPGRADER_ROLE
    );

    await ensureTargetRole(
        accessManagerAdmin,
        lossManager.address,
        [
            lossManager.contract.interface.getFunction("setTrancheOrderAndPairs").selector,
            lossManager.contract.interface.getFunction("setNavOracle").selector,
            lossManager.contract.interface.getFunction("setMaxLossPerTxUSDC").selector,
        ],
        adminRole
    );
    await ensureTargetRole(
        accessManagerAdmin,
        lossManager.address,
        [lossManager.contract.interface.getFunction("upgradeToAndCall").selector],
        roleIds.UPGRADER_ROLE
    );

    for (const tranche of trancheByKey.values()) {
        await ensureTargetRole(
            accessManagerAdmin,
            tranche.address,
            [
                tranche.contract.interface.getFunction("setUnstakeDelayEpochs").selector,
                tranche.contract.interface.getFunction("setDepositLimits").selector,
            ],
            adminRole
        );
        await ensureTargetRole(
            accessManagerAdmin,
            tranche.address,
            [tranche.contract.interface.getFunction("upgradeToAndCall").selector],
            roleIds.UPGRADER_ROLE
        );
    }

    if (polJunior) {
        await ensureTargetRole(
            accessManagerAdmin,
            polJunior.address,
            [
                polJunior.contract.interface.getFunction("withdraw").selector,
                polJunior.contract.interface.getFunction("setPolPayout").selector,
            ],
            adminRole
        );
        await ensureTargetRole(
            accessManagerAdmin,
            polJunior.address,
            [polJunior.contract.interface.getFunction("upgradeToAndCall").selector],
            roleIds.UPGRADER_ROLE
        );
    }

    await ensureTargetRole(
        accessManagerAdmin,
        navOracle.address,
        [navOracle.contract.interface.getFunction("submitNav").selector],
        roleIds.ORACLE_ROLE
    );
    await ensureTargetRole(
        accessManagerAdmin,
        navOracle.address,
        [
            navOracle.contract.interface.getFunction("rejectPendingNav").selector,
            navOracle.contract.interface.getFunction("setVetoPeriod").selector,
        ],
        adminRole
    );

    await ensureRoleMember(accessManagerAdmin, adminRole, config.roles.admin, 0);

    await ensureRoleMember(
        accessManagerAdmin,
        roleIds.PAUSER_ROLE,
        config.roles.pauser,
        delays.pauser ?? 0
    );
    if (grantDevRoles && config.roles.pauser.toLowerCase() !== devDeployer.toLowerCase()) {
        await ensureRoleMember(
            accessManagerAdmin,
            roleIds.PAUSER_ROLE,
            devDeployer,
            delays.pauser ?? 0
        );
    }
    await ensureRoleMember(
        accessManagerAdmin,
        roleIds.UNPAUSER_ROLE,
        config.roles.unpauser,
        delays.unpauser ?? 0
    );
    if (grantDevRoles && config.roles.unpauser.toLowerCase() !== devDeployer.toLowerCase()) {
        await ensureRoleMember(
            accessManagerAdmin,
            roleIds.UNPAUSER_ROLE,
            devDeployer,
            delays.unpauser ?? 0
        );
    }
    await ensureRoleMember(
        accessManagerAdmin,
        roleIds.UPGRADER_ROLE,
        config.roles.upgrader,
        delays.upgrader ?? 0
    );
    if (grantDevRoles && config.roles.upgrader.toLowerCase() !== devDeployer.toLowerCase()) {
        await ensureRoleMember(
            accessManagerAdmin,
            roleIds.UPGRADER_ROLE,
            devDeployer,
            delays.upgrader ?? 0
        );
    }

    const withdrawers = new Set<string>([
        config.roles.admin,
        ...(config.roles.reservoirWithdrawers ?? []),
        vault.address,
    ]);
    if (grantDevRoles) {
        withdrawers.add(devDeployer);
    }
    for (const addr of withdrawers) {
        await ensureRoleMember(
            accessManagerAdmin,
            roleIds.RESERVOIR_WITHDRAW_ROLE,
            addr,
            delays.reservoirWithdraw ?? 0
        );
    }

    const keeperMembers = new Set<string>(config.roles.keepers ?? []);
    if (grantDevRoles) {
        keeperMembers.add(devDeployer);
    }
    for (const addr of keeperMembers) {
        await ensureRoleMember(accessManagerAdmin, roleIds.KEEPER_ROLE, addr, delays.keeper ?? 0);
    }

    const oracleMembers = new Set<string>(config.navOracle.oracles);
    if (grantDevRoles) {
        oracleMembers.add(devDeployer);
    }
    for (const addr of oracleMembers) {
        await ensureRoleMember(accessManagerAdmin, roleIds.ORACLE_ROLE, addr, delays.oracle ?? 0);
    }

    const burnerMembers = new Set<string>(Array.from(trancheByKey.values(), (t) => t.address));
    if (polJunior) {
        burnerMembers.add(polJunior.address);
    }
    for (const addr of burnerMembers) {
        await ensureRoleMember(accessManagerAdmin, roleIds.BURNER_ROLE, addr, delays.burner ?? 0);
    }

    // === Post-deploy checks ===
    log.step("Post-deploy checks");
    assert(
        (await vault.contract.mzusd()).toLowerCase() === mzusd.address.toLowerCase(),
        "Vault.mzusd mismatch"
    );
    assert(
        (await mzusd.contract.vault()).toLowerCase() === vault.address.toLowerCase(),
        "MZUSD.vault mismatch"
    );
    assert(
        (await vault.contract.lossManager()).toLowerCase() === lossManager.address.toLowerCase(),
        "Vault.lossManager mismatch"
    );
    assert(
        (await vault.contract.navOracle()).toLowerCase() === navOracle.address.toLowerCase(),
        "Vault.navOracle mismatch"
    );
    assert(
        (await lossManager.contract.navOracle()).toLowerCase() === navOracle.address.toLowerCase(),
        "LossManager.navOracle mismatch"
    );
    assert(
        (await mzusd.contract.lossManager()).toLowerCase() === lossManager.address.toLowerCase(),
        "MZUSD.lossManager mismatch"
    );

    for (const tranche of trancheByKey.values()) {
        const trancheVault = await tranche.contract.vault();
        assert(
            trancheVault.toLowerCase() === vault.address.toLowerCase(),
            "Tranche.vault mismatch"
        );
    }

    if (polJunior) {
        const polVault = await polJunior.contract.vault();
        assert(
            polVault.toLowerCase() === vault.address.toLowerCase(),
            "PolJuniorTranche.vault mismatch"
        );
    }

    log.success("Deployment checks passed");

    // === Verification ===
    log.step("Verification");
    await verifyContract(accessManager.address, [devDeployer], shouldVerify);
    if (mockUsdc) {
        const mock = config.usdc.mock!;
        await verifyContract(mockUsdc.address, [mock.name, mock.symbol, devDeployer], shouldVerify);
    }
    if (pauseManager.implementation) {
        await verifyContract(pauseManager.implementation, [], shouldVerify);
    }
    if (reservoir.implementation) {
        await verifyContract(reservoir.implementation, [usdcAddress], shouldVerify);
    }
    if (vault.implementation) {
        await verifyContract(
            vault.implementation,
            [mzusd.address, reservoir.address],
            shouldVerify
        );
    }
    if (mzusd.implementation) {
        await verifyContract(mzusd.implementation, [usdcAddress], shouldVerify);
    }
    for (const trancheConfig of config.tranches) {
        const tranche = trancheByKey.get(trancheConfig.key);
        if (tranche?.implementation) {
            await verifyContract(
                tranche.implementation,
                [trancheConfig.directWithdrawEnabled],
                shouldVerify
            );
        }
    }
    if (polJunior?.implementation) {
        await verifyContract(polJunior.implementation, [vault.address], shouldVerify);
    }
    if (lossManager.implementation) {
        await verifyContract(lossManager.implementation, [], shouldVerify);
    }
    await verifyContract(
        navOracle.address,
        [
            accessManager.address,
            mzusd.address,
            vault.address,
            lossManager.address,
            config.navOracle.vetoPeriodSec,
        ],
        shouldVerify
    );

    saveDeployments(deployments);
    log.success("Deployments saved");

    // === Deployment summary ===
    log.step("Deployment summary");
    log.info(`AccessManager: ${accessManager.address}`);
    log.info(`PauseManager (proxy): ${pauseManager.address}`);
    log.info(`USDC: ${usdcAddress}`);
    log.info(`ReservoirUSDC (proxy): ${reservoir.address}`);
    log.info(`Vault (proxy): ${vault.address}`);
    log.info(`MZUSD (proxy): ${mzusd.address}`);
    for (const [key, tranche] of trancheByKey.entries()) {
        log.info(`Tranche ${key}: ${tranche.address}`);
    }
    if (polJunior) {
        log.info(`PolJuniorTranche: ${polJunior.address}`);
    }
    log.info(`LossManager (proxy): ${lossManager.address}`);
    log.info(`NavOracleAutomation: ${navOracle.address}`);
    for (const finalizer of finalizers) {
        log.info(`UmbrellaEpochFinalizer: ${finalizer.address}`);
    }

    const renounceConfig = config.postDeploy?.renounceDeployerRoles ?? false;
    const shouldRenounce = (forceRenounce || renounceConfig) && !skipRenounce;
    if (shouldRenounce) {
        log.warn(
            "Renounce roles requested. Run scripts/deployment/renounceRoles.ts to execute with safety checks."
        );
    }
}

main().catch((err) => {
    log.error(err?.message ?? err);
    process.exitCode = 1;
});
