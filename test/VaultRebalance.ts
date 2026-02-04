import {expect} from "chai";
import {ethers, upgrades, network} from "hardhat";
import {parseUnits} from "ethers";
import {
    impersonateAccount,
    setBalance,
    takeSnapshot,
} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

import {Vault, ReservoirUSDC, MZUSD, IERC20, PauseManager} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

// Role for Vault to call Reservoir.withdraw
const RESERVOIR_WITHDRAW_ROLE = 2n;

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
    let bob: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;
    let whale: any;

    before(async () => {
        [deployer, alice, bob] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
        usdcTotalSupply = await usdc.totalSupply();
        whale = await imp(USDC_WHALE);
        upgrades.silenceWarnings();

        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        accessManager = await AccessManagerFactory.deploy(deployer.address);
        await accessManager.waitForDeployment();

        const PauseManagerFactory = await ethers.getContractFactory("PauseManager", deployer);
        pauseManager = (await upgrades.deployProxy(PauseManagerFactory, [accessManager.target], {
            kind: "uups",
            initializer: "initialize",
        })) as unknown as PauseManager;

        const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
        reservoir = (await upgrades.deployProxy(
            ReservoirFactory,
            [accessManager.target, pauseManager.target],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as ReservoirUSDC;

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                pauseManager.target,
                usdcTotalSupply, // _hourlyLimitUSDC (max allowed)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, deployer.address, 0, alice.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        })) as unknown as Vault;

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);
        const setVaultSelector = mzusd.interface.getFunction("setVault").selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSelector], ADMIN_ROLE);

        await mzusd.setVault(vault.target);

        const rebalanceSelector = vault.interface.getFunction("rebalance").selector;
        const setBufferSelector = vault.interface.getFunction("setBuffer").selector;

        await accessManager.setTargetFunctionRole(
            vault.target,
            [rebalanceSelector, setBufferSelector],
            ADMIN_ROLE
        );

        const reservoirWithdrawSelector = reservoir.interface.getFunction("withdraw").selector;
        const reservoirSetVaultSelector = reservoir.interface.getFunction("setVault").selector;

        await accessManager.setTargetFunctionRole(
            reservoir.target,
            [reservoirWithdrawSelector],
            RESERVOIR_WITHDRAW_ROLE
        );

        await accessManager.grantRole(
            RESERVOIR_WITHDRAW_ROLE,
            vault.target,
            0 // executionDelay
        );

        await accessManager.setTargetFunctionRole(
            reservoir.target,
            [reservoirSetVaultSelector],
            ADMIN_ROLE
        );
        await reservoir.setVault(vault.target);

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function whaleTransfer(to: string, amount6: bigint) {
        await usdc.connect(whale).transfer(to, amount6);
    }

    describe("Getters", () => {
        it("Getters expose buffer bounds and reservoir totalUSDC", async () => {
            const target = to6(1000n);
            const bandBps = 1000n; // 10%

            await whaleTransfer(vault.target as string, target);
            await vault.connect(deployer).setBuffer(target, Number(bandBps));

            const [buffer, hysteresis, low, high] = await vault.getBufferConfig();
            const expectedLow = (target * (10_000n - bandBps)) / 10_000n;
            const expectedHigh = (target * (10_000n + bandBps)) / 10_000n;

            expect(buffer).to.equal(target);
            expect(hysteresis).to.equal(bandBps);
            expect(low).to.equal(expectedLow);
            expect(high).to.equal(expectedHigh);

            await whaleTransfer(reservoir.target as string, to6(123n));
            expect(await reservoir.totalUSDC()).to.equal(to6(123n));
        });
    });

    describe("Initialization", () => {
        it("Reverts on zero accessManager during Reservoir init", async () => {
            const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
            await expect(
                upgrades.deployProxy(ReservoirFactory, [ethers.ZeroAddress, pauseManager.target], {
                    kind: "uups",
                    initializer: "initialize",
                    unsafeAllow: ["constructor", "state-variable-immutable"],
                    constructorArgs: [MAINNET_USDC],
                })
            ).to.be.revertedWithCustomError(ReservoirFactory, "ZeroAddress");
        });
    });

    describe("Rebalance flows", () => {
        it("Sends excess idle USDC to Reservoir when idle > high bound", async () => {
            // Fund Vault with 1500 USDC -> should send 500 to Reservoir
            await whaleTransfer(vault.target as string, to6(1500n));

            const vaultBefore = await usdc.balanceOf(vault.target);
            const resBefore = await usdc.balanceOf(reservoir.target);

            expect(vaultBefore).to.equal(to6(1500n));
            expect(resBefore).to.equal(0n);

            // Buffer target: 1000 USDC, band: 10% -> low=900, high=1100
            await expect(vault.connect(deployer).setBuffer(to6(1000n), 1000))
                .to.emit(vault, "Rebalanced")
                .withArgs(to6(500n), 0n, to6(1000n));

            const vaultAfter = await usdc.balanceOf(vault.target);
            const resAfter = await usdc.balanceOf(reservoir.target);

            expect(vaultAfter).to.equal(to6(1000n));
            expect(resAfter - resBefore).to.equal(to6(500n));
        });

        it("Pulls USDC from Reservoir when idle < low bound", async () => {
            // Fund Reservoir so it can pay out
            await whaleTransfer(reservoir.target as string, to6(600n));

            // Fund Vault with 500 (< low=900) -> should pull 500 to reach 1000
            await whaleTransfer(vault.target as string, to6(500n));

            const vaultBefore = await usdc.balanceOf(vault.target);
            const resBefore = await usdc.balanceOf(reservoir.target);

            expect(vaultBefore).to.equal(to6(500n));
            expect(resBefore).to.equal(to6(600n));

            await expect(vault.connect(deployer).setBuffer(to6(1000n), 1000))
                .to.emit(vault, "Rebalanced")
                .withArgs(0n, to6(500n), to6(1000n));

            const vaultAfter = await usdc.balanceOf(vault.target);
            const resAfter = await usdc.balanceOf(reservoir.target);

            expect(vaultAfter).to.equal(to6(1000n));
            expect(resBefore - resAfter).to.equal(to6(500n));
        });

        it("Pulls partial USDC when Reservoir has less than needed", async () => {
            // Reservoir has only 200, Vault idle is 500 -> need 500 to reach 1000
            await whaleTransfer(reservoir.target as string, to6(200n));
            await whaleTransfer(vault.target as string, to6(500n));

            const resBefore = await usdc.balanceOf(reservoir.target);

            await expect(vault.connect(deployer).setBuffer(to6(1000n), 1000))
                .to.emit(vault, "Rebalanced")
                .withArgs(0n, to6(200n), to6(700n));

            const vaultAfter = await usdc.balanceOf(vault.target);
            const resAfter = await usdc.balanceOf(reservoir.target);

            expect(vaultAfter).to.equal(to6(700n));
            expect(resBefore - resAfter).to.equal(to6(200n));
        });

        it("Reverts when Reservoir is empty and idle < low bound", async () => {
            await whaleTransfer(vault.target as string, to6(500n));

            await expect(
                vault.connect(deployer).setBuffer(to6(1000n), 1000)
            ).to.be.revertedWithCustomError(vault, "ReservoirEmpty");
        });

        it("Does nothing when idle is within [low, high] band", async () => {
            // 1050 is within [900,1100] => no move
            await whaleTransfer(vault.target as string, to6(1050n));

            const vaultBefore = await usdc.balanceOf(vault.target);
            const resBefore = await usdc.balanceOf(reservoir.target);

            await expect(vault.connect(deployer).setBuffer(to6(1000n), 1000))
                .to.emit(vault, "Rebalanced")
                .withArgs(0n, 0n, to6(1050n));

            const vaultAfter = await usdc.balanceOf(vault.target);
            const resAfter = await usdc.balanceOf(reservoir.target);

            expect(vaultAfter).to.equal(vaultBefore);
            expect(resAfter).to.equal(resBefore);
        });

        it("setBuffer uses the new target/band for rebalance decisions", async () => {
            await whaleTransfer(vault.target as string, to6(1000n));
            await vault.connect(deployer).setBuffer(to6(1000n), 1000);

            // With the old config, 1200 would be above high=1100.
            await whaleTransfer(vault.target as string, to6(200n));

            const resBefore = await usdc.balanceOf(reservoir.target);

            // New target makes 1200 fall inside [1170, 1430], so no move.
            await expect(vault.connect(deployer).setBuffer(to6(1300n), 1000))
                .to.emit(vault, "Rebalanced")
                .withArgs(0n, 0n, to6(1200n));

            const resAfter = await usdc.balanceOf(reservoir.target);
            const vaultAfter = await usdc.balanceOf(vault.target);

            expect(resAfter).to.equal(resBefore);
            expect(vaultAfter).to.equal(to6(1200n));
        });

        it("rebalance moves funds explicitly after setBuffer", async () => {
            await whaleTransfer(vault.target as string, to6(1000n));
            await vault.connect(deployer).setBuffer(to6(1000n), 1000);

            await whaleTransfer(vault.target as string, to6(500n));

            await expect(vault.connect(deployer).rebalance())
                .to.emit(vault, "Rebalanced")
                .withArgs(to6(500n), 0n, to6(1000n));
        });
    });

    describe("Access control", () => {
        it("Pauses protocol operations via PauseManager", async () => {
            await accessManager.grantRole(RESERVOIR_WITHDRAW_ROLE, deployer.address, 0);

            await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);
            await expect(vault.connect(deployer).rebalance())
                .to.be.revertedWithCustomError(vault, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await expect(reservoir.connect(deployer).deposit(1n))
                .to.be.revertedWithCustomError(reservoir, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await expect(reservoir.connect(deployer).withdraw(1n, deployer.address))
                .to.be.revertedWithCustomError(reservoir, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
        });

        it("Reverts for non-authorized caller (restricted)", async () => {
            await expect(vault.connect(alice).rebalance()).to.be.reverted;
        });
    });

    describe("Tracking", () => {
        it("Tracks deposits/withdrawals and excludes the Vault address", async () => {
            await accessManager.grantRole(RESERVOIR_WITHDRAW_ROLE, deployer.address, 0);

            const aliceDepositA = to6(10n);
            const aliceDepositB = to6(5n);
            const bobDeposit = to6(7n);

            await usdc.connect(whale).transfer(alice.address, aliceDepositA + aliceDepositB);
            await usdc.connect(whale).transfer(bob.address, bobDeposit);

            await usdc.connect(alice).approve(reservoir.target, aliceDepositA + aliceDepositB);
            await reservoir.connect(alice).deposit(aliceDepositA);
            await reservoir.connect(alice).deposit(aliceDepositB);

            await usdc.connect(bob).approve(reservoir.target, bobDeposit);
            await reservoir.connect(bob).deposit(bobDeposit);

            expect(await reservoir.depositedBy(alice.address)).to.equal(
                aliceDepositA + aliceDepositB
            );
            expect(await reservoir.depositedBy(bob.address)).to.equal(bobDeposit);

            expect(await reservoir.actorsLength()).to.equal(2n);
            expect(await reservoir.actors(0)).to.equal(alice.address);
            expect(await reservoir.actors(1)).to.equal(bob.address);

            const rebalanceTarget = to6(100n);
            const rebalanceBand = 1000;
            await vault.connect(deployer).setBuffer(rebalanceTarget, rebalanceBand);
            await usdc.connect(whale).transfer(vault.target as string, to6(200n));

            const vaultBefore = await usdc.balanceOf(vault.target);
            const resBefore = await usdc.balanceOf(reservoir.target);
            await vault.connect(deployer).rebalance();
            const vaultAfter = await usdc.balanceOf(vault.target);
            const resAfter = await usdc.balanceOf(reservoir.target);
            expect(vaultAfter).to.equal(rebalanceTarget);
            expect(vaultBefore - vaultAfter).to.equal(resAfter - resBefore);
            expect(await reservoir.actorsLength()).to.equal(2n);

            const toVault = to6(3n);
            await reservoir.connect(deployer).withdraw(toVault, vault.target);
            expect(await reservoir.withdrawnTo(vault.target)).to.equal(0n);
            expect(await reservoir.actorsLength()).to.equal(2n);

            const toAliceA = to6(2n);
            const toAliceB = to6(1n);
            const toBob = to6(1n);
            await reservoir.connect(deployer).withdraw(toAliceA, alice.address);
            await reservoir.connect(deployer).withdraw(toAliceB, alice.address);
            await reservoir.connect(deployer).withdraw(toBob, bob.address);
            expect(await reservoir.withdrawnTo(alice.address)).to.equal(toAliceA + toAliceB);
            expect(await reservoir.withdrawnTo(bob.address)).to.equal(toBob);
            expect(await reservoir.actorsLength()).to.equal(2n);

            // trigger rebalances; Vault should not be tracked
            await usdc.connect(whale).transfer(vault.target as string, to6(200n));
            await vault.connect(deployer).rebalance();
            expect(await reservoir.actorsLength()).to.equal(2n);
        });
    });
});
