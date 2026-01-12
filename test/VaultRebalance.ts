import {expect} from "chai";
import {ethers, upgrades, network} from "hardhat";
import {parseUnits} from "ethers";
import {
    impersonateAccount,
    setBalance,
    takeSnapshot,
} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

import {Vault, ReservoirUSDC, MZUSD, IERC20} from "../typechain-types";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0x01b8697695EAb322A339c4bf75740Db75dc9375E";

// Role for Vault to call Reservoir.deposit/withdraw
const VAULT_ROLE = 2n;

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

async function imp(addr: string) {
    await setBalance(addr, to18(10)); // ETH for gas
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("Vault <-> Reservoir", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;

    let accessManager: any;
    let usdc: IERC20;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;

    before(async () => {
        [deployer, alice] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
        upgrades.silenceWarnings();

        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        accessManager = await AccessManagerFactory.deploy(deployer.address);
        await accessManager.waitForDeployment();

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                0, // _hourlyLimitUSDC
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;

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

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();

        const rebalanceSelector = vault.interface.getFunction("rebalance").selector;
        const setBufferSelector = vault.interface.getFunction("setBuffer").selector;

        await accessManager.setTargetFunctionRole(
            vault.target,
            [rebalanceSelector, setBufferSelector],
            ADMIN_ROLE
        );

        const reservoirDepositSelector = reservoir.interface.getFunction("deposit").selector;
        const reservoirWithdrawSelector = reservoir.interface.getFunction("withdraw").selector;

        await accessManager.setTargetFunctionRole(
            reservoir.target,
            [reservoirDepositSelector, reservoirWithdrawSelector],
            VAULT_ROLE
        );

        await accessManager.grantRole(
            VAULT_ROLE,
            vault.target,
            0 // executionDelay
        );

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function whaleTransfer(to: string, amount6: bigint) {
        const whale = await imp(USDC_WHALE);
        await usdc.connect(whale).transfer(to, amount6);
    }

    it("Sends excess idle USDC to Reservoir when idle > high bound", async () => {
        // Buffer target: 1000 USDC, band: 10% -> low=900, high=1100
        await vault.connect(deployer).setBuffer(to6(1000n), 1000);

        // Fund Vault with 1500 USDC -> should send 500 to Reservoir
        await whaleTransfer(vault.target as string, to6(1500n));

        const vaultBefore = await usdc.balanceOf(vault.target);
        const resBefore = await usdc.balanceOf(reservoir.target);

        expect(vaultBefore).to.equal(to6(1500n));
        expect(resBefore).to.equal(0n);

        await expect(vault.connect(deployer).rebalance())
            .to.emit(vault, "Rebalanced")
            .withArgs(to6(500n), 0n, to6(1000n));

        const vaultAfter = await usdc.balanceOf(vault.target);
        const resAfter = await usdc.balanceOf(reservoir.target);

        expect(vaultAfter).to.equal(to6(1000n));
        expect(resAfter - resBefore).to.equal(to6(500n));
    });

    it("Pulls USDC from Reservoir when idle < low bound", async () => {
        await vault.connect(deployer).setBuffer(to6(1000n), 1000);

        // Fund Reservoir so it can pay out
        await whaleTransfer(reservoir.target as string, to6(600n));

        // Fund Vault with 500 (< low=900) -> should pull 500 to reach 1000
        await whaleTransfer(vault.target as string, to6(500n));

        const vaultBefore = await usdc.balanceOf(vault.target);
        const resBefore = await usdc.balanceOf(reservoir.target);

        expect(vaultBefore).to.equal(to6(500n));
        expect(resBefore).to.equal(to6(600n));

        await expect(vault.connect(deployer).rebalance())
            .to.emit(vault, "Rebalanced")
            .withArgs(0n, to6(500n), to6(1000n));

        const vaultAfter = await usdc.balanceOf(vault.target);
        const resAfter = await usdc.balanceOf(reservoir.target);

        expect(vaultAfter).to.equal(to6(1000n));
        expect(resBefore - resAfter).to.equal(to6(500n));
    });

    it("Does nothing when idle is within [low, high] band", async () => {
        await vault.connect(deployer).setBuffer(to6(1000n), 1000);

        // 1050 is within [900,1100] => no move
        await whaleTransfer(vault.target as string, to6(1050n));

        const vaultBefore = await usdc.balanceOf(vault.target);
        const resBefore = await usdc.balanceOf(reservoir.target);

        await expect(vault.connect(deployer).rebalance())
            .to.emit(vault, "Rebalanced")
            .withArgs(0n, 0n, to6(1050n));

        const vaultAfter = await usdc.balanceOf(vault.target);
        const resAfter = await usdc.balanceOf(reservoir.target);

        expect(vaultAfter).to.equal(vaultBefore);
        expect(resAfter).to.equal(resBefore);
    });

    it("Reverts for non-authorized caller (restricted)", async () => {
        await vault.connect(deployer).setBuffer(to6(1000n), 1000);
        await whaleTransfer(vault.target as string, to6(1500n));

        await expect(vault.connect(alice).rebalance()).to.be.reverted;
    });
});
