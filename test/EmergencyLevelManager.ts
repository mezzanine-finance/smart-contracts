import {expect} from "chai";
import hre, {ethers, upgrades, network} from "hardhat";
import {takeSnapshot} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";
import chalk from "chalk";
import {
    AccessManagerConfiguratorV1,
    EmergencyLevelManager,
    IERC20,
    LossManager,
    MZUSD,
    PolJuniorTranche,
    ReservoirUSDC,
    Tranche,
    Vault,
} from "../typechain-types";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const VAULT_WITHDRAW_ROLE = 1n;
const UPGRADE_ROLE = 4n;
const EMERGENCY_ESCALATE_ROLE = 100n;
const EMERGENCY_RELAX_ROLE = 101n;

const LEVEL_L0 = 0;
const LEVEL_L1 = 1;
const LEVEL_L2 = 2;

const RELAX_DELAY = 2 * 24 * 60 * 60;
const UPGRADE_DELAY = RELAX_DELAY;
const ADMIN_DELAY = RELAX_DELAY;

const isCoverageRun = (hre as any).__SOLIDITY_COVERAGE_RUNNING === true;
const itIfNotCoverage = isCoverageRun ? it.skip : it;
if (isCoverageRun)
    console.log(
        chalk.red(
            "Coverage run detected, skipping gas headroom test due to very poor ram performance in this testcase on coverage. To run all tests, use 'npx hardhat test'."
        )
    );
describe("EmergencyLevelManager", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let guardian: any;
    let governor: any;

    let accessManager: any;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;
    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;
    let tranche: Tranche;
    let pol: PolJuniorTranche;
    let lossManager: LossManager;
    let manager: EmergencyLevelManager;
    let configurator: AccessManagerConfiguratorV1;

    before(async () => {
        [deployer, guardian, governor] = await ethers.getSigners();

        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
        usdcTotalSupply = await usdc.totalSupply();

        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        accessManager = await AccessManagerFactory.deploy(deployer.address);
        await accessManager.waitForDeployment();

        upgrades.silenceWarnings();

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(MZUSDFactory, [accessManager.target, usdcTotalSupply], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [MAINNET_USDC],
        })) as unknown as MZUSD;

        const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
        reservoir = (await upgrades.deployProxy(ReservoirFactory, [accessManager.target], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [MAINNET_USDC],
        })) as unknown as ReservoirUSDC;

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(
            VaultFactory,
            [mzusd.target, reservoir.target, accessManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as Vault;

        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        tranche = (await upgrades.deployProxy(
            TrancheFactory,
            [mzusd.target, vault.target, 1, 0, "Senior Tranche", "sMZUSD", accessManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [false],
            }
        )) as unknown as Tranche;

        const PolFactory = await ethers.getContractFactory("PolJuniorTranche", deployer);
        pol = (await upgrades.deployProxy(
            PolFactory,
            [mzusd.target, "POL Junior Tranche", "pJLT", accessManager.target, deployer.address],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as PolJuniorTranche;

        const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
        lossManager = (await upgrades.deployProxy(
            LossManagerFactory,
            [accessManager.target, mzusd.target, [tranche.target], 0],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as LossManager;

        const ManagerFactory = await ethers.getContractFactory("EmergencyLevelManager", deployer);
        manager = (await upgrades.deployProxy(
            ManagerFactory,
            [
                accessManager.target,
                mzusd.target,
                vault.target,
                reservoir.target,
                lossManager.target,
                pol.target,
                [tranche.target],
                LEVEL_L0,
            ],
            {kind: "uups", initializer: "initialize"}
        )) as unknown as EmergencyLevelManager;

        const ConfiguratorFactory = await ethers.getContractFactory(
            "AccessManagerConfiguratorV1",
            deployer
        );
        configurator = (await ConfiguratorFactory.deploy(
            deployer.address
        )) as AccessManagerConfiguratorV1;
        await configurator.waitForDeployment();

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await accessManager.grantRole(ADMIN_ROLE, configurator.target, 0);

        await configurator.configure(
            accessManager.target,
            manager.target,
            deployer.address,
            guardian.address,
            governor.address,
            mzusd.target,
            vault.target,
            reservoir.target,
            lossManager.target,
            [tranche.target],
            RELAX_DELAY,
            UPGRADE_DELAY,
            ADMIN_DELAY
        );

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    it("Applies L0 roles after configuration", async () => {
        const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();

        const depositRole = await accessManager.getTargetFunctionRole(
            mzusd.target,
            mzusd.interface.getFunction("deposit").selector
        );
        const withdrawalRole = await accessManager.getTargetFunctionRole(
            mzusd.target,
            mzusd.interface.getFunction("requestWithdrawal").selector
        );
        const vaultWithdrawRole = await accessManager.getTargetFunctionRole(
            vault.target,
            vault.interface.getFunction("withdraw").selector
        );
        const rebalanceRole = await accessManager.getTargetFunctionRole(
            vault.target,
            vault.interface.getFunction("rebalance").selector
        );

        expect(depositRole).to.equal(PUBLIC_ROLE);
        expect(withdrawalRole).to.equal(PUBLIC_ROLE);
        expect(vaultWithdrawRole).to.equal(VAULT_WITHDRAW_ROLE);
        expect(rebalanceRole).to.equal(await manager.PROTOCOL_ADMIN_ROLE());
    });

    it("Escalates to L1 and blocks ingress", async () => {
        const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();
        const disabledRole = await manager.DISABLED_ROLE();

        await manager.connect(guardian).escalateTo(LEVEL_L1);

        const depositRole = await accessManager.getTargetFunctionRole(
            mzusd.target,
            mzusd.interface.getFunction("deposit").selector
        );
        const withdrawalRole = await accessManager.getTargetFunctionRole(
            mzusd.target,
            mzusd.interface.getFunction("requestWithdrawal").selector
        );
        const trancheDepositRole = await accessManager.getTargetFunctionRole(
            tranche.target,
            tranche.interface.getFunction("deposit").selector
        );

        expect(depositRole).to.equal(disabledRole);
        expect(withdrawalRole).to.equal(PUBLIC_ROLE);
        expect(trancheDepositRole).to.equal(disabledRole);
    });

    it("Escalates to L2 and keeps only upgrade/admin", async () => {
        const disabledRole = await manager.DISABLED_ROLE();

        await manager.connect(guardian).escalateTo(LEVEL_L2);

        const withdrawalRole = await accessManager.getTargetFunctionRole(
            mzusd.target,
            mzusd.interface.getFunction("requestWithdrawal").selector
        );
        const upgradeRole = await accessManager.getTargetFunctionRole(
            vault.target,
            vault.interface.getFunction("upgradeToAndCall").selector
        );
        const setAuthorityRole = await accessManager.getTargetFunctionRole(
            vault.target,
            vault.interface.getFunction("setAuthority").selector
        );

        expect(withdrawalRole).to.equal(disabledRole);
        expect(upgradeRole).to.equal(UPGRADE_ROLE);
        expect(setAuthorityRole).to.equal(await accessManager.ADMIN_ROLE());
    });

    it("Enforces delays for relax and admin roles", async () => {
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const [adminSince, adminDelay] = await accessManager.getAccess(
            ADMIN_ROLE,
            deployer.address
        );
        expect(adminSince).to.not.equal(0n);
        expect(adminDelay).to.equal(BigInt(ADMIN_DELAY));

        const relaxSelector = manager.interface.getFunction("relaxTo").selector;
        const relaxTargetRole = await accessManager.getTargetFunctionRole(
            manager.target,
            relaxSelector
        );
        expect(relaxTargetRole).to.equal(EMERGENCY_RELAX_ROLE);

        const [relaxHasRole, relaxRoleDelay] = await accessManager.hasRole(
            EMERGENCY_RELAX_ROLE,
            governor.address
        );
        expect(relaxHasRole).to.equal(true);
        expect(relaxRoleDelay).to.equal(BigInt(RELAX_DELAY));

        const [relaxImmediate, relaxDelay] = await accessManager.canCall(
            governor.address,
            manager.target,
            relaxSelector
        );
        expect(relaxImmediate).to.equal(false);
        expect(relaxDelay).to.equal(BigInt(RELAX_DELAY));

        const [escalateImmediate, escalateDelay] = await accessManager.canCall(
            guardian.address,
            manager.target,
            manager.interface.getFunction("escalateTo").selector
        );
        expect(escalateImmediate).to.equal(true);
        expect(escalateDelay).to.equal(0n);

        const minSetback = await accessManager.minSetback();
        const upgradeGrantDelayInitial = await accessManager.getRoleGrantDelay(UPGRADE_ROLE);
        const adminGrantDelayInitial = await accessManager.getRoleGrantDelay(ADMIN_ROLE);
        expect(upgradeGrantDelayInitial).to.equal(0n);
        expect(adminGrantDelayInitial).to.equal(0n);

        await network.provider.send("evm_increaseTime", [Number(minSetback)]);
        await network.provider.send("evm_mine");

        const upgradeGrantDelay = await accessManager.getRoleGrantDelay(UPGRADE_ROLE);
        const adminGrantDelay = await accessManager.getRoleGrantDelay(ADMIN_ROLE);
        expect(upgradeGrantDelay).to.equal(BigInt(UPGRADE_DELAY));
        expect(adminGrantDelay).to.equal(BigInt(ADMIN_DELAY));
    });

    itIfNotCoverage("Has enough gas headroom for full apply", async () => {
        const gasEstimate = await manager
            .connect(guardian)
            .getFunction("escalateTo")
            .estimateGas(LEVEL_L1);
        const totalRules = await manager.totalRulesCount();
        const block = await ethers.provider.getBlock("latest");
        const gasLimit = block?.gasLimit ?? 0n;

        const maxSelectors = (gasLimit * totalRules) / gasEstimate;
        expect(maxSelectors).to.be.gte(totalRules * 2n);
    });
});
