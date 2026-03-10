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
    MZUSD,
    IssuanceVault,
    ReservoirUSDC,
    IERC20,
    Tranche,
    PauseManager,
} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";
const to6 = (value: string | number | bigint) => parseUnits(value.toString(), 6);
const to18 = (value: string | number | bigint) => parseUnits(value.toString(), 18);
const FINALIZER_ROLE = 8n;

async function imp(addr: string) {
    // Give the whale some ETH for gas
    await setBalance(addr, to18(10));
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("Tranche", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let vault: IssuanceVault;
    let mzusd: MZUSD;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;
    let reservoir: ReservoirUSDC;
    let tranche: Tranche;
    let whale: any;
    let lossManagerRef: any;
    let navOracleRef: any;
    let lossManagerSigner: any;
    let navOracleSigner: any;

    before(async () => {
        [deployer, alice, bob, carol] = await ethers.getSigners();

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

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

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

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, carol.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        })) as unknown as IssuanceVault;

        // Tranche
        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        tranche = (await upgrades.deployProxy(
            TrancheFactory,
            [
                1, // trancheIdentifier
                0, // initialUnstakeDelayEpochs
                "Senior Tranche", // name
                "sMZUSD", // symbol
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [vault.target, false], //direct withdraw disabled
            }
        )) as unknown as Tranche;

        const MockLossManagerFactory = await ethers.getContractFactory(
            "MockLossManagerRef",
            deployer
        );
        lossManagerRef = await MockLossManagerFactory.deploy(vault.target, mzusd.target);
        await lossManagerRef.waitForDeployment();

        const MockNavOracleFactory = await ethers.getContractFactory(
            "MockNavOracleAutomationRef",
            deployer
        );
        navOracleRef = await MockNavOracleFactory.deploy(
            vault.target,
            lossManagerRef.target,
            mzusd.target
        );
        await navOracleRef.waitForDeployment();
        lossManagerSigner = await imp(lossManagerRef.target as string);
        navOracleSigner = await imp(navOracleRef.target as string);

        // ROLES & AccessManager wiring
        // 2) Admin-only functions on MZUSD & IssuanceVault
        const setVaultSelector = mzusd.interface.getFunction("setVault").selector;
        const distributeYieldSelector = vault.interface.getFunction("distributeYield").selector;
        const advanceEpochSelector = vault.interface.getFunction("advanceEpoch").selector;
        const addTrancheSelector = vault.interface.getFunction("registerTranche").selector;
        const setYieldDistributionSelector =
            vault.interface.getFunction("setTrancheConfig").selector;
        const setLossManagerSelector = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSelector = vault.interface.getFunction("setNavOracle").selector;

        await accessManager.setTargetFunctionRole(
            vault.target,
            [
                distributeYieldSelector,
                advanceEpochSelector,
                addTrancheSelector,
                setYieldDistributionSelector,
                setLossManagerSelector,
                setNavOracleSelector,
            ],
            ADMIN_ROLE
        );
        const finalizeEpochSel = tranche.interface.getFunction("finalizeEpoch").selector;
        await accessManager.setTargetFunctionRole(tranche, [finalizeEpochSel], FINALIZER_ROLE);
        await accessManager.grantRole(FINALIZER_ROLE, deployer, 0);

        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSelector], ADMIN_ROLE);

        // 5) Wire IssuanceVault to MZUSD and register tranche in IssuanceVault (after roles are configured)
        await mzusd.setVault(vault.target);
        await vault.setLossManager(lossManagerRef.target);
        await vault.setNavOracle(navOracleRef.target);

        await vault.registerTranche(tranche.target);
        await vault.setTrancheConfig(
            [{tranche: tranche.target, riskPremiumBps: 10_000, enabled: true}],
            [false],
            0
        );

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    // small helper to mint MZUSD via real deposit
    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        // give user some USDC
        await usdc.connect(whale).transfer(user.address, usdcAmount6);

        // deposit to MZUSD
        await usdc.connect(user).approve(mzusd.target, usdcAmount6);
        await mzusd.connect(user).deposit(usdcAmount6);

        const mzBalance = await mzusd.balanceOf(user.address);
        return mzBalance;
    }
    // helper deposit MZUSD into Tranche (ERC4626)
    async function depositMZIntoTranche(
        user: any,
        mzAmount18: bigint,
        receiver: string = user.address
    ) {
        await mzusd.connect(user).approve(tranche.target, mzAmount18);
        const tx = await tranche.connect(user).deposit(mzAmount18, receiver);
        await tx.wait();
        return tx;
    }

    // helper mint MZUSD via USDC deposit and immediately deposit into Tranche
    async function mintAndDepositIntoTranche(
        user: any,
        usdcAmount6: bigint,
        receiver: string = user.address
    ) {
        const mintedMZ = await mintMZUSDFor(user, usdcAmount6);
        const tx = await depositMZIntoTranche(user, mintedMZ, receiver);
        const shares = await tranche.balanceOf(receiver);
        return {mintedMZ, shares, tx};
    }

    async function deployDirectTranche(
        trancheId = 2,
        name = "Direct Tranche",
        symbol = "dMZUSD"
    ): Promise<Tranche> {
        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
        return (await upgrades.deployProxy(TrancheFactory, [trancheId, 0, name, symbol], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target, true],
        })) as unknown as Tranche;
    }

    async function shareScaleFor(targetTranche: Tranche): Promise<bigint> {
        const trancheDecimals = await targetTranche.decimals();
        const assetDecimals = await mzusd.decimals();
        return 10n ** BigInt(trancheDecimals - assetDecimals);
    }

    describe("ERC4626 basics", () => {
        it("Uses 3-decimals share offset (21 share decimals over 18-decimals MZUSD)", async () => {
            const trancheDecimals = await tranche.decimals();
            const assetDecimals = await mzusd.decimals();

            expect(assetDecimals).to.equal(18n);
            expect(trancheDecimals).to.equal(21n);
            expect(trancheDecimals - assetDecimals).to.equal(3n);

            const wholeShare = 10n ** trancheDecimals;
            const wholeShareAssets = await tranche.convertToAssets(wholeShare);
            expect(wholeShareAssets).to.equal(10n ** assetDecimals);
        });

        it("Should allow basic deposit into Tranche (ERC4626 semantics)", async () => {
            const depositUSDC = to6(100n); // 100 USDC
            const expectedMZ = to18(100n); // 100 MZUSD (18 decimals)

            // 1) Mint MZUSD for Alice via real deposit into MZUSD
            const aliceMZBefore = await mzusd.balanceOf(alice.address);
            expect(aliceMZBefore).to.equal(0n);

            const minted = await mintMZUSDFor(alice, depositUSDC);
            expect(minted).to.equal(expectedMZ);

            const aliceMZAfterMint = await mzusd.balanceOf(alice.address);
            expect(aliceMZAfterMint).to.equal(expectedMZ);

            const trancheAssetsBefore = await tranche.totalAssets();
            const trancheSharesBefore = await tranche.totalSupply();
            expect(trancheAssetsBefore).to.equal(0n);
            expect(trancheSharesBefore).to.equal(0n);

            // 2) Alice deposits MZUSD into Tranche
            await mzusd.connect(alice).approve(tranche.target, expectedMZ);
            const expectedShares = await tranche.previewDeposit(expectedMZ);

            const tx = await tranche.connect(alice).deposit(expectedMZ, alice.address);
            await tx.wait();

            await expect(tx)
                .to.emit(tranche, "Deposit")
                .withArgs(alice.address, alice.address, expectedMZ, expectedShares);

            const aliceMZFinal = await mzusd.balanceOf(alice.address);
            const aliceShares = await tranche.balanceOf(alice.address);
            const trancheAssetsAfter = await tranche.totalAssets();
            const trancheSharesAfter = await tranche.totalSupply();

            // MZUSD moved from Alice to Tranche
            expect(aliceMZFinal).to.equal(0n);

            // first deposit in ERC4626 with offset -> shares are scaled by 10^offset
            expect(aliceShares).to.equal(expectedShares);
            expect(trancheSharesAfter).to.equal(expectedShares);

            // totalAssets uses virtual NAV, but without streaming = real MZUSD balance
            expect(trancheAssetsAfter).to.equal(expectedMZ);

            // convertToAssets(shares) will return the same amount
            const previewAssets = await tranche.convertToAssets(aliceShares);
            const assetsDiff =
                previewAssets > expectedMZ
                    ? previewAssets - expectedMZ
                    : expectedMZ - previewAssets;
            expect(assetsDiff).to.be.lte(1n);
        });

        it("Mints, transfers, and exposes unaccrued yield", async () => {
            const minted = await mintMZUSDFor(alice, to6(20n));

            const shares = to18(10n);
            const assetsRequired = await tranche.previewMint(shares);
            expect(assetsRequired).to.be.lte(minted);

            await mzusd.connect(alice).approve(tranche.target, assetsRequired);
            await (await tranche.connect(alice).mint(shares, alice.address)).wait();

            await (await tranche.connect(alice).transfer(bob.address, shares / 2n)).wait();

            await (await tranche.connect(alice).approve(deployer.address, shares / 2n)).wait();
            await (
                await tranche
                    .connect(deployer)
                    .transferFrom(alice.address, carol.address, shares / 2n)
            ).wait();

            expect(await tranche.unaccruedYield()).to.equal(0n);
        });

        it("Deposit limit info returns zero when TVL exceeds limit", async () => {
            const minted = await mintMZUSDFor(alice, to6(100n));
            await mzusd.connect(alice).approve(tranche.target, minted);
            await (await tranche.connect(alice).deposit(minted, alice.address)).wait();

            const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
            const setDepositLimitsSel = tranche.interface.getFunction("setDepositLimits").selector;
            const setDepositLimitEnabledSel =
                tranche.interface.getFunction("setDepositLimitEnabled").selector;
            await accessManager.setTargetFunctionRole(
                tranche.target,
                [setDepositLimitsSel, setDepositLimitEnabledSel],
                ADMIN_ROLE
            );

            await (await tranche.connect(deployer).setDepositLimits(ethers.MaxUint256, 1n)).wait();
            await (await tranche.connect(deployer).setDepositLimitEnabled(true)).wait();

            const [enabled, limit, limitByTvl, cap] = await tranche.getDepositLimitInfo();
            expect(enabled).to.equal(true);
            expect(cap).to.equal(ethers.MaxUint256);
            expect(limitByTvl).to.equal(0n);
            expect(limit).to.equal(0n);
        });

        it("Handles 1-wei MZUSD deposit and umbrella withdrawal", async () => {
            const vaultSigner = await imp(vault.target as string);
            await (await mzusd.connect(vaultSigner).mint(alice.address, 1n)).wait();

            await mzusd.connect(alice).approve(tranche.target, 1n);
            const expectedShares = await tranche.previewDeposit(1n);
            await (await tranche.connect(alice).deposit(1n, alice.address)).wait();

            expect(await tranche.balanceOf(alice.address)).to.equal(expectedShares);

            const epochId = await vault.currentEpochId();
            await (await tranche.connect(alice).requestWithdrawal(expectedShares)).wait();

            await time.increase(24 * 60 * 60);
            await (await vault.connect(lossManagerSigner).advanceEpoch()).wait();

            await (await tranche.connect(deployer).finalizeEpoch(epochId)).wait();

            const before = await mzusd.balanceOf(alice.address);
            await (await tranche.connect(alice).claim(alice.address, epochId)).wait();
            const after = await mzusd.balanceOf(alice.address);
            expect(after - before).to.equal(1n);
        });
    });
    describe("Pause guards", () => {
        it("Pauses deposits via PauseManager", async () => {
            await pauseManager.pauseGlobal(PauseCategory.DEPOSITS);
            await expect(tranche.deposit(1n, alice.address))
                .to.be.revertedWithCustomError(tranche, "ERC4626ExceededMaxDeposit")
                .withArgs(alice.address, 1n, 0n);
        });

        it("Pauses all guarded functions (umbrella mode)", async () => {
            const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
            const setUnstakeDelaySel =
                tranche.interface.getFunction("setUnstakeDelayEpochs").selector;
            const setDepositLimitsSel = tranche.interface.getFunction("setDepositLimits").selector;
            const setDepositLimitEnabledSel =
                tranche.interface.getFunction("setDepositLimitEnabled").selector;
            await accessManager.setTargetFunctionRole(
                tranche.target,
                [setUnstakeDelaySel, setDepositLimitsSel, setDepositLimitEnabledSel],
                ADMIN_ROLE
            );
            const vaultSigner = await imp(vault.target as string);

            await pauseManager.pauseGlobal(PauseCategory.DEPOSITS);
            await expect(tranche.deposit(1n, alice.address))
                .to.be.revertedWithCustomError(tranche, "ERC4626ExceededMaxDeposit")
                .withArgs(alice.address, 1n, 0n);
            await expect(tranche.mint(1n, alice.address))
                .to.be.revertedWithCustomError(tranche, "ERC4626ExceededMaxMint")
                .withArgs(alice.address, 1n, 0n);
            await pauseManager.unpauseGlobal(PauseCategory.DEPOSITS);

            await pauseManager.pauseGlobal(PauseCategory.WITHDRAWALS);
            await expect(tranche.requestWithdrawal(1n))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.WITHDRAWALS);
            await expect(tranche.claim(deployer.address, 1n))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.WITHDRAWALS);
            await pauseManager.unpauseGlobal(PauseCategory.WITHDRAWALS);

            await tranche.connect(alice).approve(deployer, 1n);
            await (await mzusd.connect(vaultSigner).mint(alice.address, 1n)).wait();
            await mzusd.connect(alice).approve(tranche.target, 1n);
            await pauseManager.pauseGlobal(PauseCategory.TRANSFERS);
            await expect(tranche.transfer(bob.address, 1n))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.TRANSFERS);
            await expect(tranche.approve(bob.address, 1n))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.TRANSFERS);
            await expect(tranche.transferFrom(alice.address, bob.address, 1n))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.TRANSFERS);
            await expect(tranche.connect(alice).deposit(1n, alice.address)).to.be.reverted;
            await pauseManager.unpauseGlobal(PauseCategory.TRANSFERS);

            await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);
            await expect(tranche.connect(vaultSigner).notifyYield(1n))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await expect(tranche.finalizeEpoch(1n))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await pauseManager.unpauseGlobal(PauseCategory.PROTOCOL);

            await pauseManager.pauseGlobal(PauseCategory.ADMIN);
            await expect(tranche.setUnstakeDelayEpochs(1n))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(tranche.setDepositLimits(1n, 1n))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(tranche.setDepositLimitEnabled(true))
                .to.be.revertedWithCustomError(tranche, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
        });
    });

    describe("Direct mode", () => {
        it("Pauses withdrawals in direct mode", async () => {
            const directTranche = await deployDirectTranche();

            const mintedMZ = await mintMZUSDFor(alice, to6(100n));
            await mzusd.connect(alice).approve(directTranche, mintedMZ);
            await directTranche.connect(alice).deposit(mintedMZ, alice);

            await pauseManager.pauseGlobal(PauseCategory.WITHDRAWALS);
            await expect(directTranche.withdraw(1n, alice.address, alice.address))
                .to.be.revertedWithCustomError(directTranche, "CategoryPaused")
                .withArgs(PauseCategory.WITHDRAWALS);
            await expect(directTranche.redeem(1n, alice.address, alice.address))
                .to.be.revertedWithCustomError(directTranche, "CategoryPaused")
                .withArgs(PauseCategory.WITHDRAWALS);
        });

        it("Direct mode: requestWithdrawal redeems immediately", async () => {
            const directTranche = await deployDirectTranche();

            const mintedMZ = await mintMZUSDFor(alice, to6(100n));
            await mzusd.connect(alice).approve(directTranche.target, mintedMZ);
            const expectedShares = await directTranche.previewDeposit(mintedMZ);
            await directTranche.connect(alice).deposit(mintedMZ, alice.address);

            const shares = await directTranche.balanceOf(alice.address);
            expect(shares).to.equal(expectedShares);
            expect(await mzusd.balanceOf(alice.address)).to.equal(0n);

            const tx = await directTranche.connect(alice).requestWithdrawal(shares);

            await expect(tx)
                .to.emit(directTranche, "Withdraw")
                .withArgs(alice.address, alice.address, alice.address, mintedMZ, shares);
            await expect(tx).to.not.emit(directTranche, "UnstakeRequested");

            expect(await directTranche.balanceOf(alice.address)).to.equal(0n);
            expect(await mzusd.balanceOf(alice.address)).to.equal(mintedMZ);
            expect(await mzusd.balanceOf(directTranche.target)).to.equal(0n);
            expect(await directTranche.totalSupply()).to.equal(0n);

            const epochId = await vault.currentEpochId();
            expect(await directTranche.umbrellaSharesByEpoch(epochId)).to.equal(0n);
            expect(await directTranche.userSharesByEpoch(alice.address, epochId)).to.equal(0n);
        });

        it("Direct mode: withdraw and redeem work", async () => {
            const directTranche = await deployDirectTranche();

            const mintedMZ = await mintMZUSDFor(alice, to6(50n));
            await mzusd.connect(alice).approve(directTranche.target, mintedMZ);
            await (await directTranche.connect(alice).deposit(mintedMZ, alice.address)).wait();

            const halfAssets = mintedMZ / 2n;
            await (
                await directTranche
                    .connect(alice)
                    .withdraw(halfAssets, alice.address, alice.address)
            ).wait();

            const remainingShares = await directTranche.balanceOf(alice.address);
            await (
                await directTranche
                    .connect(alice)
                    .redeem(remainingShares, alice.address, alice.address)
            ).wait();

            expect(await directTranche.totalSupply()).to.equal(0n);
        });

        it("Direct mode: supports 1-wei withdraw and redeem", async () => {
            const directTranche = await deployDirectTranche();

            const vaultSigner = await imp(vault.target as string);
            await (await mzusd.connect(vaultSigner).mint(alice.address, 1n)).wait();

            await mzusd.connect(alice).approve(directTranche.target, 1n);
            const expectedShares = await directTranche.previewDeposit(1n);
            await (await directTranche.connect(alice).deposit(1n, alice.address)).wait();
            expect(await directTranche.balanceOf(alice.address)).to.equal(expectedShares);

            await (
                await directTranche.connect(alice).withdraw(1n, alice.address, alice.address)
            ).wait();
            expect(await directTranche.balanceOf(alice.address)).to.equal(0n);
            expect(await mzusd.balanceOf(alice.address)).to.equal(1n);
            expect(await mzusd.balanceOf(directTranche.target)).to.equal(0n);

            await mzusd.connect(alice).approve(directTranche.target, 1n);
            const expectedSharesSecond = await directTranche.previewDeposit(1n);
            await (await directTranche.connect(alice).deposit(1n, alice.address)).wait();
            await (
                await directTranche
                    .connect(alice)
                    .redeem(expectedSharesSecond, alice.address, alice.address)
            ).wait();
            expect(await directTranche.totalSupply()).to.equal(0n);
        });
    });

    describe("Direct mode inflation", () => {
        it("Direct mode: donation inflation attack is not profitable", async () => {
            const directTranche = await deployDirectTranche();
            const shareScale = await shareScaleFor(directTranche);

            const attackerDeposit = to18(1n);
            const attackerDonation = to18(100n);
            const attackerMinted = await mintMZUSDFor(alice, to6(101n));
            expect(attackerMinted).to.equal(attackerDeposit + attackerDonation);

            await mzusd.connect(alice).approve(directTranche.target, attackerDeposit);
            await (
                await directTranche.connect(alice).deposit(attackerDeposit, alice.address)
            ).wait();

            await mzusd.connect(alice).transfer(directTranche.target, attackerDonation);

            const victimMinted = await mintMZUSDFor(bob, to6(10_000n));
            await mzusd.connect(bob).approve(directTranche.target, victimMinted);
            await (await directTranche.connect(bob).deposit(victimMinted, bob.address)).wait();

            const victimShares = await directTranche.balanceOf(bob.address);
            expect(victimShares).to.be.lt(victimMinted * shareScale);

            const attackerShares = await directTranche.balanceOf(alice.address);
            await (
                await directTranche
                    .connect(alice)
                    .redeem(attackerShares, alice.address, alice.address)
            ).wait();

            const attackerFinal = await mzusd.balanceOf(alice.address);
            const profit = attackerFinal - attackerMinted;
            expect(profit).to.be.lte(0n);
        });

        it("Direct mode: minimum donation threshold to zero out victim is D = 2V*10^offset - 1", async () => {
            const directTranche = await deployDirectTranche(99, "Inflation Tranche", "iMZUSD");
            const vaultSigner = await imp(vault.target as string);
            const shareScale = await shareScaleFor(directTranche);

            const victimDeposit = to18(100_000n);
            const attackerInitialDeposit = 1n;
            const thresholdMinusOne = 2n * victimDeposit * shareScale - 2n;
            const threshold = 2n * victimDeposit * shareScale - 1n;

            // Seed with 1 wei so the ERC4626 state is non-empty and deterministic.
            await mzusd
                .connect(vaultSigner)
                .mint(alice.address, attackerInitialDeposit + thresholdMinusOne);
            await mzusd.connect(alice).approve(directTranche.target, attackerInitialDeposit);
            await directTranche.connect(alice).deposit(attackerInitialDeposit, alice.address);
            await mzusd.connect(alice).transfer(directTranche.target, thresholdMinusOne);
            expect(await directTranche.previewDeposit(victimDeposit)).to.equal(1n);

            // Fresh tranche for exact threshold branch.
            const directTranche2 = await deployDirectTranche(100, "Inflation Tranche 2", "iMZUSD2");
            await mzusd.connect(vaultSigner).mint(alice.address, threshold + 1n);
            await mzusd.connect(alice).approve(directTranche2.target, attackerInitialDeposit);
            await directTranche2.connect(alice).deposit(attackerInitialDeposit, alice.address);
            await mzusd.connect(alice).transfer(directTranche2.target, threshold);
            expect(await directTranche2.previewDeposit(victimDeposit)).to.equal(0n);
        });

        it("Direct mode: calibrated single-victim inflation attack stays unprofitable with non-zero offset", async () => {
            const directTranche = await deployDirectTranche(101, "Inflation Tranche", "iMZUSD");
            const vaultSigner = await imp(vault.target as string);
            const shareScale = await shareScaleFor(directTranche);

            const victimDeposit = to18(100_000n);
            const attackerInitialDeposit = 1n;
            const attackerDonation = 2n * victimDeposit * shareScale - 1n;
            const attackerSpent = attackerInitialDeposit + attackerDonation;

            await mzusd.connect(vaultSigner).mint(alice.address, attackerSpent);
            await mzusd.connect(vaultSigner).mint(bob.address, victimDeposit);

            await mzusd.connect(alice).approve(directTranche.target, attackerInitialDeposit);
            await directTranche.connect(alice).deposit(attackerInitialDeposit, alice.address);
            const attackerShares = await directTranche.balanceOf(alice.address);
            expect(attackerShares).to.equal(shareScale);

            await mzusd.connect(alice).transfer(directTranche.target, attackerDonation);

            expect(await directTranche.previewDeposit(victimDeposit)).to.equal(0n);
            await mzusd.connect(bob).approve(directTranche.target, victimDeposit);
            await directTranche.connect(bob).deposit(victimDeposit, bob.address);
            expect(await directTranche.balanceOf(bob.address)).to.equal(0n);

            const totalAssetsAfterVictim = await directTranche.totalAssets();
            const expectedAttackerRedeemed = await directTranche.previewRedeem(attackerShares);

            const attackerBefore = await mzusd.balanceOf(alice.address);
            await directTranche.connect(alice).redeem(attackerShares, alice.address, alice.address);
            const attackerAfter = await mzusd.balanceOf(alice.address);
            const attackerRedeemed = attackerAfter - attackerBefore;
            const attackerLoss = attackerSpent - attackerRedeemed;

            expect(attackerRedeemed).to.equal(expectedAttackerRedeemed);
            expect(attackerLoss).to.be.gt(0n);
            expect(attackerLoss).to.be.gt(victimDeposit / 2n);

            // Victim has 0 shares and cannot recover.
            expect(await mzusd.balanceOf(bob.address)).to.equal(0n);

            const trappedDust = await mzusd.balanceOf(directTranche.target);
            expect(trappedDust).to.equal(totalAssetsAfterVictim - attackerRedeemed);
            expect(trappedDust).to.be.gt(victimDeposit);
        });

        it("Direct mode: calibrated multi-victim inflation attack with few victims stays unprofitable", async () => {
            const directTranche = await deployDirectTranche(102, "Inflation Tranche", "iMZUSD");
            const vaultSigner = await imp(vault.target as string);
            const shareScale = await shareScaleFor(directTranche);

            const victimDeposit = to18(100_000n);
            const attackerInitialDeposit = 1n;
            const attackerDonation = 2n * victimDeposit * shareScale - 1n;
            const attackerSpent = attackerInitialDeposit + attackerDonation;

            await mzusd.connect(vaultSigner).mint(alice.address, attackerSpent);
            for (const user of [bob, carol, deployer]) {
                await mzusd.connect(vaultSigner).mint(user.address, victimDeposit);
            }

            await mzusd.connect(alice).approve(directTranche.target, attackerInitialDeposit);
            await directTranche.connect(alice).deposit(attackerInitialDeposit, alice.address);
            const attackerShares = await directTranche.balanceOf(alice.address);
            await mzusd.connect(alice).transfer(directTranche.target, attackerDonation);

            for (const user of [bob, carol, deployer]) {
                await mzusd.connect(user).approve(directTranche.target, victimDeposit);
                expect(await directTranche.previewDeposit(victimDeposit)).to.equal(0n);
                await directTranche.connect(user).deposit(victimDeposit, user.address);
                expect(await directTranche.balanceOf(user.address)).to.equal(0n);
            }

            const expectedAttackerRedeemed = await directTranche.previewRedeem(attackerShares);

            const attackerBefore = await mzusd.balanceOf(alice.address);
            await directTranche.connect(alice).redeem(attackerShares, alice.address, alice.address);
            const attackerAfter = await mzusd.balanceOf(alice.address);
            const attackerRedeemed = attackerAfter - attackerBefore;
            const attackerProfit = attackerRedeemed - attackerSpent;

            expect(attackerRedeemed).to.equal(expectedAttackerRedeemed);
            expect(attackerProfit).to.be.lt(0n);
        });
    });
    describe("Yield streaming", () => {
        it("Streams yield linearly and affects deposits & pricePerShare correctly", async () => {
            const DAY = 24 * 60 * 60;

            // 1) Alice gets MZUSD
            const depositUSDC = to6(100n); // 100 USDC -> 100 MZUSD
            const expectedMZ = to18(100n);

            const {mintedMZ: aliceMintedMZ, shares: aliceShares} = await mintAndDepositIntoTranche(
                alice,
                depositUSDC,
                alice.address
            );

            expect(aliceMintedMZ).to.equal(expectedMZ);
            const shareScale = await shareScaleFor(tranche);
            expect(aliceShares).to.equal(expectedMZ * shareScale);

            const assetsAfterAliceDeposit = await tranche.totalAssets();
            expect(assetsAfterAliceDeposit).to.equal(expectedMZ); // 100

            await expect(
                vault.connect(navOracleSigner).distributeYield(1000n)
            ).to.be.revertedWithCustomError(vault, "EpochTooSoon"); // dummy call to check revert

            // 2) Time skip for one epoch, distributeYield on IssuanceVault is called
            // needed to make _advanceEpochAndValidate() not to fail with EpochTooSoon (1 day because we initialized contract with 1 day minEpochDuration)
            await time.increase(DAY);

            const reportedUSDC = to6(20n);
            const expectedYieldMZ = to18(20n);
            const epochIdBefore = await vault.currentEpochId();
            const newEpochId = (await vault.currentEpochId()) + 1n;

            // Call distributeYield and get tx
            const tx = await vault.connect(navOracleSigner).distributeYield(reportedUSDC);
            await tx.wait();

            // Use Hardhat time helper to get latest block timestamp (the tx block)
            const streamStartTs = BigInt(await time.latest());
            const minDuration = await vault.epochDuration();
            const expectedStreamEnd = streamStartTs + minDuration;

            await expect(tx)
                .to.emit(tranche, "YieldNotified")
                .withArgs(expectedYieldMZ, streamStartTs, expectedStreamEnd)
                .and.emit(vault, "YieldDistributed")
                .withArgs(reportedUSDC, expectedYieldMZ, newEpochId);

            const streamingAmount = await tranche.yieldStreamingAmount();
            expect(streamingAmount).to.equal(expectedYieldMZ);

            const yieldStart = await tranche.yieldStreamStart();
            const yieldEnd = await tranche.yieldStreamEnd();

            expect(yieldStart).to.equal(streamStartTs);
            expect(yieldEnd).to.equal(expectedStreamEnd);
            expect(yieldEnd - yieldStart).to.equal(minDuration);

            // On Tranche the yield is already there, but all "unaccrued" (ts = start)
            const trancheBalanceAfterYield = await mzusd.balanceOf(tranche.target);
            expect(trancheBalanceAfterYield).to.equal(expectedMZ + expectedYieldMZ); // 100 + 20 = 120

            const totalAssetsImmediately = await tranche.totalAssets();
            // Virtual NAV 100 for now, all yield is unaccrued
            expect(totalAssetsImmediately).to.equal(expectedMZ);

            const price0 = await tranche.pricePerShare();
            // pricePerShare ≈ 1.0
            expect(price0).to.equal(to18(1n));

            // Go half-way through the streaming period
            await time.increase(minDuration / 2n);

            const totalAssetsMid = await tranche.totalAssets();
            // After half epoch half of yield should be accrued
            // NAV = 100 + 10 = 110
            expect(totalAssetsMid).to.equal(to18(110n));

            const priceMid = await tranche.pricePerShare();
            // pricePerShare ≈ 1.1
            const expectedMidPrice = to18(11n) / 10n; // 1.1 * 1e18
            const priceDiff =
                priceMid > expectedMidPrice
                    ? priceMid - expectedMidPrice
                    : expectedMidPrice - priceMid;

            expect(priceDiff).to.be.lte(1n);

            // 4) Bob comes in the middle of the stream: deposits MZUSD at the already increased price
            const bobUSDCDeposit = to6(100n);
            const bobMintedMZ = await mintMZUSDFor(bob, bobUSDCDeposit);

            // previewDeposit needs to show less shares than assets, because pricePerShare > 1
            const previewBobShares = await tranche.previewDeposit(bobMintedMZ);
            expect(previewBobShares).to.be.lt(bobMintedMZ * shareScale);
            const txBob = await depositMZIntoTranche(bob, bobMintedMZ, bob.address);
            const bobShares = await tranche.balanceOf(bob.address);

            //price grow up because of streaming, between preview and actual deposit
            //because of it actual shares should be lte than previewed
            expect(bobShares).to.be.lte(previewBobShares);
            expect(bobShares).to.be.gt(0n);
            const delta =
                previewBobShares > bobShares
                    ? previewBobShares - bobShares
                    : bobShares - previewBobShares;

            // Difference comes from integer rounding + a small streaming time shift between preview and tx.
            // With non-zero share offset, absolute share deltas are scaled up.
            expect(delta).to.be.lte(10n ** 18n);

            // For checking sanity: Alice still has her original shares
            const aliceSharesAfterBob = await tranche.balanceOf(alice.address);
            expect(aliceSharesAfterBob).to.equal(aliceShares);

            // 5) Move time to the end of streaming and check that all yield is accrued
            await time.increase(DAY);

            const finalBalance = await mzusd.balanceOf(tranche.target);
            const finalTotalAssets = await tranche.totalAssets();

            // On the balance: 100 (Alice) + 100 (Bob) + 20 (yield) = 220
            expect(finalBalance).to.equal(to18(220n));

            // Virtual totalAssets should match real balance, as unaccruedYield = 0
            expect(finalTotalAssets).to.equal(finalBalance);

            const totalShares = await tranche.totalSupply();
            const finalPrice = await tranche.pricePerShare();

            // Price should be > midPrice and > 1
            expect(finalPrice).to.be.gt(priceMid);
            expect(finalPrice).to.be.gt(to18(1n));

            // Invariant check: NAV ~= price * totalShares / 10^shareDecimals
            const shareUnit = 10n ** BigInt(await tranche.decimals());
            const reconstructedAssets = (finalPrice * totalShares) / shareUnit;
            // Allow a small difference due to integer divisions, but it should be minimal
            const diff = finalTotalAssets - reconstructedAssets;
            const absDiff = diff >= 0n ? diff : -diff;

            // difference is purely from integer division rounding (streaming + ERC4626 formulas),
            // should be tiny compared to total NAV
            expect(absDiff).to.be.lte(1000n);
        });
    });
    describe("Umbrella withdrawals", () => {
        it("Finalization should not inflate pricePerShare before claims", async () => {
            const DAY = 24 * 60 * 60;
            await mintAndDepositIntoTranche(alice, to6(100n), alice.address);

            const ppsBefore = await tranche.pricePerShare();
            const epochAtRequest = await vault.currentEpochId();
            const sharesToWithdraw = await tranche.previewWithdraw(to18(50n));

            await tranche.connect(alice).requestWithdrawal(sharesToWithdraw);

            await time.increase(DAY);
            await vault.connect(navOracleSigner).distributeYield(0);

            await tranche.connect(deployer).finalizeEpoch(epochAtRequest);

            const ppsAfter = await tranche.pricePerShare();
            expect(ppsAfter).to.equal(ppsBefore);
        });

        it("Deposits after finalize should mint at fair PPS", async () => {
            const DAY = 24 * 60 * 60;
            await mintAndDepositIntoTranche(alice, to6(100n), alice.address);

            const epochAtRequest = await vault.currentEpochId();
            const sharesToWithdraw = await tranche.previewWithdraw(to18(50n));
            await tranche.connect(alice).requestWithdrawal(sharesToWithdraw);

            await time.increase(DAY);
            await vault.connect(navOracleSigner).distributeYield(0);
            await tranche.connect(deployer).finalizeEpoch(epochAtRequest);

            const bobSharesBefore = await tranche.balanceOf(bob.address);
            const expectedBobShares = await tranche.previewDeposit(to18(10n));
            const {mintedMZ} = await mintAndDepositIntoTranche(bob, to6(10n), bob.address);
            const bobSharesAfter = await tranche.balanceOf(bob.address);
            expect(mintedMZ).to.equal(to18(10n));
            expect(bobSharesAfter - bobSharesBefore).to.equal(expectedBobShares);
        });

        it("totalAssets should exclude finalized-but-unclaimed assets", async () => {
            const DAY = 24 * 60 * 60;
            await mintAndDepositIntoTranche(alice, to6(100n), alice.address);

            const epochAtRequest = await vault.currentEpochId();
            const sharesToWithdraw = await tranche.previewWithdraw(to18(50n));
            await tranche.connect(alice).requestWithdrawal(sharesToWithdraw);

            await time.increase(DAY);
            await vault.connect(navOracleSigner).distributeYield(0);
            await tranche.connect(deployer).finalizeEpoch(epochAtRequest);

            expect(await tranche.totalAssets()).to.equal(to18(50n));
        });

        it("Handles umbrella unstake and claim flow", async () => {
            const DAY = 24 * 60 * 60;

            const depositUSDC = to6(100n); // 100 USDC
            const expectedMZ = to18(100n); // 100 MZUSD

            // 1) Alice mints MZUSD and deposits into the tranche
            const {mintedMZ: aliceMintedMZ, shares: aliceSharesBefore} =
                await mintAndDepositIntoTranche(alice, depositUSDC, alice.address);

            expect(aliceMintedMZ).to.equal(expectedMZ);
            expect(aliceSharesBefore).to.equal(expectedMZ * (await shareScaleFor(tranche)));

            const epochAtRequest = await vault.currentEpochId();

            // 2) Alice requests withdrawal for all her shares (umbrella system)
            const txReq = await tranche.connect(alice).requestWithdrawal(aliceSharesBefore);
            await txReq.wait();

            const targetEpoch = epochAtRequest + 0n; // since unstakeDelayEpochs = 0

            await expect(txReq)
                .to.emit(tranche, "UnstakeRequested")
                .withArgs(alice.address, aliceSharesBefore, epochAtRequest, targetEpoch);

            const umbrellaShares = await tranche.umbrellaSharesByEpoch(targetEpoch);
            const userEpochShares = await tranche.userSharesByEpoch(alice.address, targetEpoch);

            expect(umbrellaShares).to.equal(aliceSharesBefore);
            expect(userEpochShares).to.equal(aliceSharesBefore);

            const aliceSharesAfterRequest = await tranche.balanceOf(alice.address);
            expect(aliceSharesAfterRequest).to.equal(0n);

            // 3) Advance epoch in IssuanceVault and distribute some yield for the next epoch
            await time.increase(DAY);

            const reportedUSDC = to6(10n); // small yield just to advance epoch
            await vault.connect(navOracleSigner).distributeYield(reportedUSDC);

            const currentEpochAfterYield = await vault.currentEpochId();
            expect(currentEpochAfterYield).to.equal(epochAtRequest + 1n);

            // 4) Admin finalizes the epoch for which Alice requested unstake
            // NOTE: finalizeEpoch uses convertToAssets(shares) at the finalization block timestamp.
            // Because yield is streamed linearly, NAV can increase by a small amount between our view calls
            // and the finalize tx (often ~1 second). Here we assert the exact expected math.

            const trancheSupplyBeforeFinal = await tranche.totalSupply();

            // Snapshot streaming params + tranche balance before finalization
            const streamAmount = await tranche.yieldStreamingAmount();
            const streamStart = await tranche.yieldStreamStart();
            const streamEnd = await tranche.yieldStreamEnd();
            const balanceAtFinalize = await mzusd.balanceOf(tranche.target);

            const txFinal = await tranche.connect(deployer).finalizeEpoch(targetEpoch);
            const receiptFinal = await txFinal.wait();
            const blockFinal = await ethers.provider.getBlock(receiptFinal!.blockNumber);
            const finalizeTs = BigInt(blockFinal!.timestamp);

            const [umbrellaAfterFinal, isFinalized, totalSharesFinal, totalAssetsFinal] =
                await tranche.getEpochInfo(targetEpoch);

            expect(isFinalized).to.equal(true);
            expect(umbrellaAfterFinal).to.equal(0n);
            expect(totalSharesFinal).to.equal(aliceSharesBefore);

            // Exact expected NAV at finalization time:
            // totalAssets(t) = balance - unaccrued(t)
            // unaccrued(t) = streamAmount - floor(streamAmount * elapsed / duration)
            // => totalAssets(t) = (balance - streamAmount) + floor(streamAmount * elapsed / duration)
            const duration = BigInt(streamEnd) - BigInt(streamStart);

            let elapsed: bigint;
            if (finalizeTs <= BigInt(streamStart)) {
                elapsed = 0n;
            } else if (finalizeTs >= BigInt(streamEnd)) {
                elapsed = duration;
            } else {
                elapsed = finalizeTs - BigInt(streamStart);
            }

            const accrued = duration === 0n ? 0n : (streamAmount * elapsed) / duration;

            expect(balanceAtFinalize).to.be.gte(streamAmount);

            const expectedTotalAssetsFinal = balanceAtFinalize - (streamAmount - accrued);

            // In theory this should match exactly, but depending on the exact ERC4626 conversion math
            // used during finalize (vs. our direct NAV reconstruction), a 1-wei rounding difference is possible.
            const navDiff =
                totalAssetsFinal > expectedTotalAssetsFinal
                    ? totalAssetsFinal - expectedTotalAssetsFinal
                    : expectedTotalAssetsFinal - totalAssetsFinal;

            expect(navDiff).to.be.lte(1n);

            const trancheSupplyAfterFinal = await tranche.totalSupply();
            expect(trancheSupplyAfterFinal).to.equal(trancheSupplyBeforeFinal - aliceSharesBefore);

            // 5) Alice claims her withdrawal for that epoch
            const aliceMZBeforeClaim = await mzusd.balanceOf(alice.address);

            const [pendingSharesBefore, claimableBefore] = await tranche.getUserEpochInfo(
                alice.address,
                targetEpoch
            );

            expect(pendingSharesBefore).to.equal(aliceSharesBefore);
            // Since Alice is the only pending user for this epoch, claimable = finalized totalAssets
            expect(claimableBefore).to.equal(totalAssetsFinal);

            const txClaim = await tranche.connect(alice).claim(alice.address, targetEpoch);
            await txClaim.wait();

            const aliceMZAfterClaim = await mzusd.balanceOf(alice.address);
            await expect(txClaim)
                .to.emit(tranche, "WithdrawalClaimed")
                .withArgs(alice.address, targetEpoch, claimableBefore);

            // Claim transfers the finalized, claimable assets for this epoch back to Alice
            expect(aliceMZAfterClaim).to.equal(aliceMZBeforeClaim + claimableBefore);

            const [pendingSharesAfter, claimableAfter] = await tranche.getUserEpochInfo(
                alice.address,
                targetEpoch
            );

            expect(pendingSharesAfter).to.equal(0n);
            expect(claimableAfter).to.equal(0n);
        });
        it("Allows a third party to claim on behalf of a user", async () => {
            const DAY = 24 * 60 * 60;
            const depositUSDC = to6(100n);
            const {shares} = await mintAndDepositIntoTranche(alice, depositUSDC, alice.address);

            const epochAtRequest = await vault.currentEpochId();
            await (await tranche.connect(alice).requestWithdrawal(shares)).wait();
            const targetEpoch = epochAtRequest;

            await time.increase(DAY);
            await (await vault.connect(navOracleSigner).distributeYield(0n)).wait();
            await (await tranche.connect(deployer).finalizeEpoch(targetEpoch)).wait();

            const [, claimable] = await tranche.getUserEpochInfo(alice.address, targetEpoch);
            expect(claimable).to.be.gt(0n);

            const aliceBefore = await mzusd.balanceOf(alice.address);
            const bobBefore = await mzusd.balanceOf(bob.address);

            // Bob claims on behalf of Alice
            await tranche.connect(bob).claim(alice.address, targetEpoch);

            const aliceAfter = await mzusd.balanceOf(alice.address);
            const bobAfter = await mzusd.balanceOf(bob.address);

            // Alice receives the funds
            expect(aliceAfter - aliceBefore).to.equal(claimable);
            // Bob receives nothing
            expect(bobAfter).to.equal(bobBefore);
        });
        it("Does not allow transferring shares held under umbrella", async () => {
            const {shares} = await mintAndDepositIntoTranche(alice, to6(10n), alice.address);

            const epochAtRequest = await vault.currentEpochId();
            await (await tranche.connect(alice).requestWithdrawal(shares)).wait();

            expect(await tranche.balanceOf(alice.address)).to.equal(0n);
            expect(await tranche.userSharesByEpoch(alice.address, epochAtRequest)).to.equal(shares);

            await expect(tranche.connect(alice).transfer(bob.address, 1n)).to.be.reverted;
        });
        it("Handles umbrella unstake (finalize + claim for multiple users with awkward numbers)", async () => {
            const DAY = 24 * 60 * 60;

            // Awkward deposit sizes
            const aUSDC = to6(123n);
            const bUSDC = to6(77n);
            const cUSDC = to6(19n);

            // 1) Alice deposits at epoch 1 (pricePerShare ~ 1.0)
            const {mintedMZ: aMinted, shares: aShares} = await mintAndDepositIntoTranche(
                alice,
                aUSDC,
                alice.address
            );

            expect(aMinted).to.equal(to18(123n));
            expect(aShares).to.equal(aMinted * (await shareScaleFor(tranche)));

            expect(await vault.currentEpochId()).to.equal(1n);

            // 2) Advance to epoch 2 and start streaming yield (odd amount -> rounding)
            await time.increase(DAY);

            const yieldUSDC = to6(17n);
            const txYield1 = await vault.connect(navOracleSigner).distributeYield(yieldUSDC);
            await txYield1.wait();

            expect(await vault.currentEpochId()).to.equal(2n);

            const minDuration = await vault.epochDuration();

            // Move into the stream by a non-round fraction to create ugly share math
            await time.increase(minDuration / 3n + 7n);

            // 3) Bob & Carol deposit mid-stream (pricePerShare > 1 => shares < assets)
            const {mintedMZ: bMinted, shares: bShares} = await mintAndDepositIntoTranche(
                bob,
                bUSDC,
                bob.address
            );
            const {mintedMZ: cMinted, shares: cShares} = await mintAndDepositIntoTranche(
                carol,
                cUSDC,
                carol.address
            );
            const shareScale = await shareScaleFor(tranche);

            expect(bShares).to.be.lt(bMinted * shareScale);
            expect(cShares).to.be.lt(cMinted * shareScale);

            // 4) All request withdrawal for all shares in current vault epoch (targetEpoch = 2)
            const targetEpoch = await vault.currentEpochId(); // 2
            expect(targetEpoch).to.equal(2n);

            const aReq = await tranche.balanceOf(alice.address);
            const bReq = await tranche.balanceOf(bob.address);
            const cReq = await tranche.balanceOf(carol.address);

            await expect(
                tranche.connect(alice).requestWithdrawal(aReq + 5n)
            ).to.be.revertedWithCustomError(tranche, "InvalidBalance");
            await tranche.connect(alice).requestWithdrawal(aReq);
            await tranche.connect(bob).requestWithdrawal(bReq);
            await tranche.connect(carol).requestWithdrawal(cReq);

            const umbrella = await tranche.umbrellaSharesByEpoch(targetEpoch);
            expect(umbrella).to.equal(aReq + bReq + cReq);

            expect(await tranche.balanceOf(alice.address)).to.equal(0n);
            expect(await tranche.balanceOf(bob.address)).to.equal(0n);
            expect(await tranche.balanceOf(carol.address)).to.equal(0n);

            // 5) Advance epoch again so finalizeEpoch(2) becomes allowed
            await time.increase(DAY);
            const txYield2 = await vault.connect(navOracleSigner).distributeYield(to6(1n));
            await txYield2.wait();

            expect(await vault.currentEpochId()).to.equal(3n);

            // 6) Finalize epoch 2
            await tranche.connect(deployer).finalizeEpoch(targetEpoch);

            const [umbrellaAfter, isFinalized, totalSharesFinal, totalAssetsFinal] =
                await tranche.getEpochInfo(targetEpoch);

            expect(isFinalized).to.equal(true);
            expect(umbrellaAfter).to.equal(0n);
            expect(totalSharesFinal).to.equal(aReq + bReq + cReq);

            // 7) Pro-rata claim math with floor rounding (exactly as in Tranche.claim)
            const expectedA = (aReq * totalAssetsFinal) / totalSharesFinal;
            const expectedB = (bReq * totalAssetsFinal) / totalSharesFinal;
            const expectedC = (cReq * totalAssetsFinal) / totalSharesFinal;

            // Verify getUserEpochInfo matches the same formula
            const [aPending, aClaimable] = await tranche.getUserEpochInfo(
                alice.address,
                targetEpoch
            );
            const [, aFinalized, aTotShares, aTotAssets] = await tranche.getEpochInfo(targetEpoch);
            expect(aPending).to.equal(aReq);
            expect(aFinalized).to.equal(true);
            expect(aTotShares).to.equal(totalSharesFinal);
            expect(aTotAssets).to.equal(totalAssetsFinal);
            expect(aClaimable).to.equal(expectedA);

            const [bPending, bClaimable] = await tranche.getUserEpochInfo(bob.address, targetEpoch);
            expect(bPending).to.equal(bReq);
            expect(bClaimable).to.equal(expectedB);

            const [cPending, cClaimable] = await tranche.getUserEpochInfo(
                carol.address,
                targetEpoch
            );
            expect(cPending).to.equal(cReq);
            expect(cClaimable).to.equal(expectedC);

            // Claim and check balances
            const aBalBefore = await mzusd.balanceOf(alice.address);
            const bBalBefore = await mzusd.balanceOf(bob.address);
            const cBalBefore = await mzusd.balanceOf(carol.address);

            const trancheBalBeforeClaims = await mzusd.balanceOf(tranche.target);

            await tranche.connect(alice).claim(alice.address, targetEpoch);
            await tranche.connect(bob).claim(bob.address, targetEpoch);
            await tranche.connect(carol).claim(carol.address, targetEpoch);

            const aBalAfter = await mzusd.balanceOf(alice.address);
            const bBalAfter = await mzusd.balanceOf(bob.address);
            const cBalAfter = await mzusd.balanceOf(carol.address);

            expect(aBalAfter).to.equal(aBalBefore + expectedA);
            expect(bBalAfter).to.equal(bBalBefore + expectedB);
            expect(cBalAfter).to.equal(cBalBefore + expectedC);

            // Rounding invariant: sumClaims <= totalAssetsFinal, leftover < number of users
            const sumClaims = expectedA + expectedB + expectedC;
            expect(sumClaims).to.be.lte(totalAssetsFinal);
            expect(totalAssetsFinal - sumClaims).to.be.lt(3n);

            // Contract balance decreases by exactly sumClaims (no other transfers during claim)
            const trancheBalAfterClaims = await mzusd.balanceOf(tranche.target);
            expect(trancheBalAfterClaims).to.equal(trancheBalBeforeClaims - sumClaims);

            // Pending shares cleared
            const [aPendingAfter] = await tranche.getUserEpochInfo(alice.address, targetEpoch);
            const [bPendingAfter] = await tranche.getUserEpochInfo(bob.address, targetEpoch);
            const [cPendingAfter] = await tranche.getUserEpochInfo(carol.address, targetEpoch);

            expect(aPendingAfter).to.equal(0n);
            expect(bPendingAfter).to.equal(0n);
            expect(cPendingAfter).to.equal(0n);
        });
        it("Finalizes newer epoch before older one without losing pending shares", async () => {
            const DAY = 24 * 60 * 60;

            const {shares: aShares} = await mintAndDepositIntoTranche(
                alice,
                to6(50n),
                alice.address
            );
            const epoch1 = await vault.currentEpochId();
            await (await tranche.connect(alice).requestWithdrawal(aShares)).wait();

            await time.increase(DAY);
            await (await vault.connect(navOracleSigner).distributeYield(to6(1n))).wait();

            const {shares: bShares} = await mintAndDepositIntoTranche(bob, to6(30n), bob.address);
            const epoch2 = await vault.currentEpochId();
            await (await tranche.connect(bob).requestWithdrawal(bShares)).wait();

            await time.increase(DAY);
            await (await vault.connect(navOracleSigner).distributeYield(to6(1n))).wait();

            await (await tranche.connect(deployer).finalizeEpoch(epoch2)).wait();

            expect(await tranche.umbrellaSharesByEpoch(epoch1)).to.equal(aShares);
            const [, finalized2] = await tranche.getEpochInfo(epoch2);
            expect(finalized2).to.equal(true);

            await (await tranche.connect(deployer).finalizeEpoch(epoch1)).wait();
            const [, finalized1] = await tranche.getEpochInfo(epoch1);
            expect(finalized1).to.equal(true);
        });
    });
    describe("Limits and delays", () => {
        it("Deposit limits stress and streaming NAV", async () => {
            const DAY = 24 * 60 * 60;

            // Give users some MZUSD upfront
            await mintMZUSDFor(alice, to6(200n));
            await mintMZUSDFor(bob, to6(300n));
            await mintMZUSDFor(carol, to6(400n));

            const totalSupply0 = await mzusd.totalSupply();

            // Phase 0: enable limits (global caps, not per-tx)
            const cap0 = ethers.MaxUint256; // no cap sentinel
            const tvlBps0 = 4000n; // 40% of total supply
            await (await tranche.connect(deployer).setDepositLimitEnabled(true)).wait();
            const txCfg0 = await tranche.connect(deployer).setDepositLimits(cap0, tvlBps0);
            await expect(txCfg0)
                .to.emit(tranche, "DepositLimitUpdated")
                .withArgs(true, cap0, tvlBps0);

            const maxTotal0 = (totalSupply0 * tvlBps0) / 10_000n;

            // Alice deposits 200 -> OK
            const aliceExact = to18(200n);
            await mzusd.connect(alice).approve(tranche.target, aliceExact);
            await (await tranche.connect(alice).deposit(aliceExact, alice.address)).wait();
            expect(await tranche.totalAssets()).to.equal(aliceExact);

            // Remaining capacity after Alice
            const limit1 = maxTotal0 - aliceExact;

            // Bob attempts to exceed remaining capacity -> revert
            const bob170 = to18(170n);
            await mzusd.connect(bob).approve(tranche.target, bob170);
            await expect(tranche.connect(bob).deposit(bob170, bob.address))
                .to.be.revertedWithCustomError(tranche, "ERC4626ExceededMaxDeposit")
                .withArgs(bob.address, bob170, limit1);

            // Admin sets a tighter global cap to bind instead of TVL-bps
            const cap3 = to18(250n);
            const tvlBps3 = tvlBps0;
            const txCfg3 = await tranche.connect(deployer).setDepositLimits(cap3, tvlBps3);
            await expect(txCfg3)
                .to.emit(tranche, "DepositLimitUpdated")
                .withArgs(true, cap3, tvlBps3);

            const capRemaining = cap3 - aliceExact;

            const bob60 = to18(60n);
            await mzusd.connect(bob).approve(tranche.target, bob60);
            await expect(tranche.connect(bob).deposit(bob60, bob.address))
                .to.be.revertedWithCustomError(tranche, "ERC4626ExceededMaxDeposit")
                .withArgs(bob.address, bob60, capRemaining);

            await mzusd.connect(bob).approve(tranche.target, capRemaining);
            await (await tranche.connect(bob).deposit(capRemaining, bob.address)).wait();
            expect(await tranche.totalAssets()).to.equal(cap3);

            const carol1 = to18(1n);
            await mzusd.connect(carol).approve(tranche.target, carol1);
            await expect(tranche.connect(carol).deposit(carol1, carol.address))
                .to.be.revertedWithCustomError(tranche, "ERC4626ExceededMaxDeposit")
                .withArgs(carol.address, carol1, 0n);

            // Phase 3: streaming NAV stress (limits should use virtual NAV, not raw balance)
            // Start a yield stream by advancing epoch and distributing yield
            await time.increase(DAY);
            await (await vault.connect(navOracleSigner).distributeYield(to6(13n))).wait();

            const epochDuration = await vault.epochDuration();
            // Move into the stream by a weird amount (to create ugly virtual NAV)
            await time.increase(epochDuration / 2n + 17n);

            const bal = await mzusd.balanceOf(tranche.target);
            const nav = await tranche.totalAssets();
            // While stream is active - balance includes full yield, NAV excludes unaccrued part
            expect(nav).to.be.lt(bal);

            // Loosen cap and set TVL-bps to allow only small headroom
            const cap4 = ethers.MaxUint256; // no cap sentinel; TVL-bps should bind
            const tvlBps4 = 3000n; // 30%
            const txCfg4 = await tranche.connect(deployer).setDepositLimits(cap4, tvlBps4);
            await expect(txCfg4)
                .to.emit(tranche, "DepositLimitUpdated")
                .withArgs(true, cap4, tvlBps4);

            // Large deposit should revert (do not assert args here because NAV moves per-second during streaming)
            const big = to18(100n);
            await mzusd.connect(carol).approve(tranche.target, big);
            await expect(
                tranche.connect(carol).deposit(big, carol.address)
            ).to.be.revertedWithCustomError(tranche, "ERC4626ExceededMaxDeposit");

            // A small enough deposit should pass even mid-stream
            const small = to18(1n);
            await mzusd.connect(carol).approve(tranche.target, small);
            await (await tranche.connect(carol).deposit(small, carol.address)).wait();

            // Phase 4: disable limits mid-stream, deposits should proceed
            const txOff = await tranche.connect(deployer).setDepositLimitEnabled(false);
            await expect(txOff)
                .to.emit(tranche, "DepositLimitUpdated")
                .withArgs(false, cap4, tvlBps4);

            const huge = to18(123n);
            await mzusd.connect(carol).approve(tranche.target, huge);
            await (await tranche.connect(carol).deposit(huge, carol.address)).wait();

            // No strict numeric equality here (streaming changes NAV continuously), just basic sanity
            expect(await tranche.totalSupply()).to.be.gt(0n);
            expect(await tranche.totalAssets()).to.be.gt(0n);
        });
        it("Unstake delay epochs stress ", async () => {
            const DAY = 24 * 60 * 60;

            // epoch 1: Alice deposits and requests with delay = 0 -> target = request epoch (1)
            await mintAndDepositIntoTranche(alice, to6(100n), alice.address);
            const epoch1 = await vault.currentEpochId();
            expect(epoch1).to.equal(1n);

            const aShares = await tranche.balanceOf(alice.address);
            const txReqA = await tranche.connect(alice).requestWithdrawal(aShares);
            await expect(txReqA)
                .to.emit(tranche, "UnstakeRequested")
                .withArgs(alice.address, aShares, epoch1, epoch1);

            // Admin changes delay to 2 for future requests
            const txDelay = await tranche.connect(deployer).setUnstakeDelayEpochs(2n);
            await expect(txDelay).to.emit(tranche, "UnstakeDelayUpdated").withArgs(2n);

            // epoch 1: Bob deposits and requests -> target = 3
            await mintAndDepositIntoTranche(bob, to6(50n), bob.address);
            const bShares = await tranche.balanceOf(bob.address);
            const txReqB = await tranche.connect(bob).requestWithdrawal(bShares);
            await expect(txReqB)
                .to.emit(tranche, "UnstakeRequested")
                .withArgs(bob.address, bShares, epoch1, epoch1 + 2n);

            // Existing pending should stay where it was
            expect(await tranche.userSharesByEpoch(alice.address, 1n)).to.equal(aShares);
            expect(await tranche.umbrellaSharesByEpoch(1n)).to.equal(aShares);

            expect(await tranche.userSharesByEpoch(bob.address, 3n)).to.equal(bShares);
            expect(await tranche.umbrellaSharesByEpoch(3n)).to.equal(bShares);

            // Advance to epoch 2 (starts a yield stream for epoch 2)
            await time.increase(DAY);
            await (await vault.connect(navOracleSigner).distributeYield(to6(5n))).wait();
            expect(await vault.currentEpochId()).to.equal(2n);

            // Bob's pending request for epoch 3 remains untouched until finalization.
            expect(await tranche.userSharesByEpoch(bob.address, 3n)).to.equal(bShares);
            expect(await tranche.umbrellaSharesByEpoch(3n)).to.equal(bShares);

            // Finalize epoch 1 now allowed (current = 2 > 1) and Alice claims
            await (await tranche.connect(deployer).finalizeEpoch(1n)).wait();
            const [, finalized1, totalShares1, totalAssets1] = await tranche.getEpochInfo(1n);
            expect(finalized1).to.equal(true);
            expect(totalShares1).to.equal(aShares);

            const aBalBefore = await mzusd.balanceOf(alice.address);
            await (await tranche.connect(alice).claim(alice.address, 1n)).wait();
            expect(await mzusd.balanceOf(alice.address)).to.equal(aBalBefore + totalAssets1);

            // Move to epoch 3 (starts a yield stream for epoch 3)
            await time.increase(DAY);
            await (await vault.connect(navOracleSigner).distributeYield(to6(7n))).wait();
            expect(await vault.currentEpochId()).to.equal(3n);

            // finalizeEpoch(3) is NOT allowed when currentEpoch = epochId
            await expect(tranche.connect(deployer).finalizeEpoch(3n)).to.be.revertedWithCustomError(
                tranche,
                "EpochNotPassed"
            );

            // Move to epoch 4 (starts a yield stream for epoch 4)
            await time.increase(DAY);
            await (await vault.connect(navOracleSigner).distributeYield(to6(9n))).wait();
            expect(await vault.currentEpochId()).to.equal(4n);

            // Key addition: finalize epoch 3 while a yield stream (epoch 4) is ACTIVE
            // Move into the stream by an awkward fraction to force non-trivial virtual NAV
            const epochDuration = await vault.epochDuration();
            await time.increase(epochDuration / 2n + 13n);

            // Snapshot stream params + balance + totalSupply BEFORE finalization
            const streamAmount = await tranche.yieldStreamingAmount();
            const streamStart = await tranche.yieldStreamStart();
            const streamEnd = await tranche.yieldStreamEnd();
            const balanceAtFinalize = await mzusd.balanceOf(tranche.target);
            const supplyBeforeFinal = await tranche.totalSupply();

            const bPendingFinal = await tranche.userSharesByEpoch(bob.address, 3n);
            expect(bPendingFinal).to.equal(bShares);

            // Finalize epoch 3
            const txFinal3 = await tranche.connect(deployer).finalizeEpoch(3n);
            const rc3 = await txFinal3.wait();
            const blk3 = await ethers.provider.getBlock(rc3!.blockNumber);
            const finalizeTs = BigInt(blk3!.timestamp);

            const [, finalized3, totalShares3, totalAssets3] = await tranche.getEpochInfo(3n);
            expect(finalized3).to.equal(true);
            expect(totalShares3).to.equal(bPendingFinal);

            // Reconstruct virtual NAV at finalization timestamp:
            // totalAssets(t) = (balance - streamAmount) + floor(streamAmount * elapsed / duration)
            const dur = BigInt(streamEnd) - BigInt(streamStart);

            let elapsed: bigint;
            if (finalizeTs <= BigInt(streamStart)) {
                elapsed = 0n;
            } else if (finalizeTs >= BigInt(streamEnd)) {
                elapsed = dur;
            } else {
                elapsed = finalizeTs - BigInt(streamStart);
            }

            const accrued = dur === 0n ? 0n : (streamAmount * elapsed) / dur;
            const navAtFinalize = balanceAtFinalize - (streamAmount - accrued);

            // ERC4626 convertToAssets(shares) uses shares * totalAssets / totalSupply (floor)
            const expectedAssets3 = (bPendingFinal * navAtFinalize) / supplyBeforeFinal;
            const diff =
                totalAssets3 > expectedAssets3
                    ? totalAssets3 - expectedAssets3
                    : expectedAssets3 - totalAssets3;
            expect(diff).to.be.lte(1n);

            // Bob claims epoch 3 and receives exactly the finalized assets for that epoch
            const bBalBefore = await mzusd.balanceOf(bob.address);
            await (await tranche.connect(bob).claim(bob.address, 3n)).wait();
            expect(await mzusd.balanceOf(bob.address)).to.equal(bBalBefore + totalAssets3);
        });
    });
    describe("Validation and guards", () => {
        it("Should revert NotFinalized when user has pending shares but epoch is not finalized", async () => {
            const depositUSDC = to6(100n);
            const expectedMZ = to18(100n);

            // Alice deposits to get tranche shares
            const {shares: aliceShares} = await mintAndDepositIntoTranche(
                alice,
                depositUSDC,
                alice.address
            );
            expect(aliceShares).to.equal(expectedMZ * (await shareScaleFor(tranche)));

            const epochAtRequest = await vault.currentEpochId();
            expect(epochAtRequest).to.equal(1n);

            // Alice requests withdrawal (creates pending under umbrella)
            await (await tranche.connect(alice).requestWithdrawal(aliceShares)).wait();
            const targetEpoch = epochAtRequest; // delay = 0 in this suite setup

            // Epoch is NOT finalized yet -> should revert NotFinalized (not NothingToClaim)
            await expect(
                tranche.connect(alice).claim(alice.address, targetEpoch)
            ).to.be.revertedWithCustomError(tranche, "NotFinalized");
        });
        it("Should revert EpochNotPassed when current vault epoch has not advanced", async () => {
            const depositUSDC = to6(50n);

            // Create some pending shares for epoch 1
            const {shares: aliceShares} = await mintAndDepositIntoTranche(
                alice,
                depositUSDC,
                alice.address
            );
            const epochAtRequest = await vault.currentEpochId();
            expect(epochAtRequest).to.equal(1n);

            await (await tranche.connect(alice).requestWithdrawal(aliceShares)).wait();

            // Cannot finalize epoch 1 while currentEpochId = 1
            await expect(
                tranche.connect(deployer).finalizeEpoch(epochAtRequest)
            ).to.be.revertedWithCustomError(tranche, "EpochNotPassed");
        });
        it("Notify yield guards (ZeroYieldPassed, YieldStreamIsActive)", async () => {
            const vaultSigner = await imp(vault.target as string);

            await expect(
                tranche.connect(vaultSigner).notifyYield(0n)
            ).to.be.revertedWithCustomError(tranche, "ZeroYieldPassed");

            // Start a stream with a small yield amount (ensure tranche balance has the tokens)
            const yieldAmt = to18(1n);
            await (await mzusd.connect(vaultSigner).mint(tranche.target, yieldAmt)).wait();

            await (await tranche.connect(vaultSigner).notifyYield(yieldAmt)).wait();

            // 3) While stream is active, re-notifying should revert YieldStreamIsActive
            await expect(
                tranche.connect(vaultSigner).notifyYield(yieldAmt)
            ).to.be.revertedWithCustomError(tranche, "YieldStreamIsActive");
        });
        it("Reverts when unstake delay exceeds max", async () => {
            const maxDelay = await tranche.MAX_UNSTAKE_DELAY_EPOCHS();
            await expect(
                tranche.connect(deployer).setUnstakeDelayEpochs(maxDelay + 1n)
            ).to.be.revertedWithCustomError(tranche, "UnstakeDelayTooLarge");
        });
        it("Reverts when unstake delay is set to zero in umbrella mode", async () => {
            await expect(
                tranche.connect(deployer).setUnstakeDelayEpochs(0n)
            ).to.be.revertedWithCustomError(tranche, "UnstakeDelayZero");
        });
        it("Should revert NothingToFinalize when epoch passed but umbrella is empty", async () => {
            const DAY = 24 * 60 * 60;

            await mintAndDepositIntoTranche(alice, to6(5n), alice.address);

            expect(await vault.currentEpochId()).to.equal(1n);
            expect(await tranche.umbrellaSharesByEpoch(1n)).to.equal(0n);

            await time.increase(DAY);
            await (await vault.connect(navOracleSigner).distributeYield(to6(1n))).wait();
            expect(await vault.currentEpochId()).to.equal(2n);

            await expect(tranche.connect(deployer).finalizeEpoch(1n)).to.be.revertedWithCustomError(
                tranche,
                "NothingToFinalize"
            );
        });

        it("maxDeposit returns type(uint256).max when deposit limits are disabled", async () => {
            expect(await tranche.depositLimitEnabled()).to.equal(false);
            expect(await tranche.maxDeposit(alice.address)).to.equal(ethers.MaxUint256);
        });

        it("maxMint returns type(uint256).max when deposit limits are disabled", async () => {
            expect(await tranche.depositLimitEnabled()).to.equal(false);
            expect(await tranche.maxMint(alice.address)).to.equal(ethers.MaxUint256);
        });

        it("maxDeposit reflects the effective deposit limit", async () => {
            await mintMZUSDFor(alice, to6(200n));

            const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
            const setDepositLimitsSel = tranche.interface.getFunction("setDepositLimits").selector;
            const setDepositLimitEnabledSel =
                tranche.interface.getFunction("setDepositLimitEnabled").selector;
            await accessManager.setTargetFunctionRole(
                tranche.target,
                [setDepositLimitsSel, setDepositLimitEnabledSel],
                ADMIN_ROLE
            );

            // Set cap = 100 MZUSD, tvlBps = 100%
            const cap = to18(100n);
            await tranche.connect(deployer).setDepositLimits(cap, 10_000n);
            await tranche.connect(deployer).setDepositLimitEnabled(true);

            // No deposits yet → full cap available
            expect(await tranche.maxDeposit(alice.address)).to.equal(cap);

            // Alice deposits 60 MZUSD → 40 remaining
            const deposit1 = to18(60n);
            await mzusd.connect(alice).approve(tranche.target, deposit1);
            await tranche.connect(alice).deposit(deposit1, alice.address);

            expect(await tranche.maxDeposit(alice.address)).to.equal(cap - deposit1);
        });

        it("maxMint converts the deposit limit to shares", async () => {
            await mintMZUSDFor(alice, to6(200n));

            const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
            const setDepositLimitsSel = tranche.interface.getFunction("setDepositLimits").selector;
            const setDepositLimitEnabledSel =
                tranche.interface.getFunction("setDepositLimitEnabled").selector;
            await accessManager.setTargetFunctionRole(
                tranche.target,
                [setDepositLimitsSel, setDepositLimitEnabledSel],
                ADMIN_ROLE
            );

            const cap = to18(100n);
            await tranche.connect(deployer).setDepositLimits(cap, 10_000n);
            await tranche.connect(deployer).setDepositLimitEnabled(true);

            const expectedShares = await tranche.previewDeposit(cap);
            expect(await tranche.maxMint(alice.address)).to.equal(expectedShares);
        });

        it("maxDeposit returns 0 when deposits are paused", async () => {
            await pauseManager.connect(deployer).pauseGlobal(PauseCategory.DEPOSITS);
            expect(await tranche.maxDeposit(alice.address)).to.equal(0n);
        });

        it("maxMint returns 0 when deposits are paused", async () => {
            await pauseManager.connect(deployer).pauseGlobal(PauseCategory.DEPOSITS);
            expect(await tranche.maxMint(alice.address)).to.equal(0n);
        });
    });
});
