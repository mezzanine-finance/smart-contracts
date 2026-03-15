import {expect} from "chai";
import {ethers, upgrades, network} from "hardhat";
import {parseUnits, Signer} from "ethers";
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
    MZUSDNettingHelper,
    PauseManager,
    Allowlist,
    MockSanctionsList,
} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";
const BURNER_ROLE = 5n;

const to6 = (value: string | number | bigint) => parseUnits(value.toString(), 6);
const to18 = (value: string | number | bigint) => parseUnits(value.toString(), 18);

async function imp(addr: any) {
    // Give the whale 10 ETH for gas
    await setBalance(addr, to18(10));
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("MZUSD <-> USDC conversion", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let charlie: any;
    let dave: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let vault: IssuanceVault;
    let sanctionsList: MockSanctionsList;
    let allowlist: Allowlist;
    let mzusd: MZUSD;
    let usdc: IERC20;
    let reservoir: ReservoirUSDC;
    let nettingHelper: any;
    let whale: any;
    let usdcTotalSupply: bigint;

    // Helper functions for Alice funding and deposit
    async function fundAliceWithUSDC(amountUSDC: bigint) {
        await usdc.connect(whale).transfer(alice.address, amountUSDC);
        return whale;
    }

    async function aliceDepositUSDC(amountUSDC: bigint) {
        await usdc.connect(alice).approve(mzusd.target, amountUSDC);
        const tx = await mzusd.connect(alice).deposit(amountUSDC);
        await tx.wait();
    }

    async function fundAndDepositForAlice(amountUSDC: bigint) {
        await fundAliceWithUSDC(amountUSDC);
        await aliceDepositUSDC(amountUSDC);
    }

    before(async () => {
        [deployer, alice, bob, charlie, dave] = await ethers.getSigners();

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
            unsafeAllow: ["constructor"],
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

        const SanctionsListFactory = await ethers.getContractFactory("MockSanctionsList", deployer);
        sanctionsList = await SanctionsListFactory.deploy();
        const AllowlistFactory = await ethers.getContractFactory("Allowlist", deployer);
        allowlist = await upgrades.deployProxy(
            AllowlistFactory,
            [accessManager.target, sanctionsList.target],
            {
                kind: "uups",
                initializer: "initialize",
            }
        );
        await allowlist.addBatch([
            deployer.address,
            alice.address,
            bob.address,
            charlie.address,
            dave.address,
        ]);

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                pauseManager.target,
                allowlist.target,
                usdcTotalSupply, // _limitUSDC (max allowed; configured below in tests)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC],
            }
        );

        const VaultFactory = await ethers.getContractFactory("IssuanceVault", deployer);
        vault = await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, charlie.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusd.target, reservoir.target],
        });

        const NettingHelperFactory = await ethers.getContractFactory(
            "MZUSDNettingHelper",
            deployer
        );
        nettingHelper = await NettingHelperFactory.deploy();
        await nettingHelper.waitForDeployment();
        await allowlist.add(nettingHelper);

        const setVaultSelector = mzusd.interface.getFunction("setVault").selector;
        const burnSelector = mzusd.interface.getFunction("burn").selector;
        await accessManager.setTargetFunctionRole(mzusd.target, [setVaultSelector], ADMIN_ROLE);
        await accessManager.setTargetFunctionRole(mzusd.target, [burnSelector], BURNER_ROLE);
        await accessManager.grantRole(BURNER_ROLE, deployer.address, 0);
        await mzusd.setVault(vault.target);

        await expect(mzusd.setGlobalRedemptionCap(to6(1_000_000n)))
            .to.emit(mzusd, "GlobalRedemptionCapUpdated")
            .withArgs(to6(1_000_000n)); // 1 million USDC per hour

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    describe("Initialization", () => {
        it("Reverts on zero accessManager during initialization", async () => {
            const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
            await expect(
                upgrades.deployProxy(
                    MZUSDFactory,
                    [ethers.ZeroAddress, allowlist.target, pauseManager.target, usdcTotalSupply],
                    {
                        kind: "uups",
                        initializer: "initialize",
                        unsafeAllow: ["constructor", "state-variable-immutable"],
                        constructorArgs: [MAINNET_USDC],
                    }
                )
            ).to.be.revertedWithCustomError(MZUSDFactory, "ZeroAddress");
        });
    });

    describe("Pause guards", () => {
        it("Pauses deposits via PauseManager", async () => {
            await pauseManager.pauseGlobal(PauseCategory.DEPOSITS);
            await expect(mzusd.deposit(to6(1n)))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.DEPOSITS);
        });

        it("Pauses all guarded MZUSD functions", async () => {
            const vaultAddress = await vault.getAddress();
            await setBalance(vaultAddress, to18(1));
            await impersonateAccount(vaultAddress);
            const vaultSigner = await ethers.getSigner(vaultAddress);

            await pauseManager.pauseGlobal(PauseCategory.DEPOSITS);
            await expect(mzusd.deposit(to6(1n)))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.DEPOSITS);
            await pauseManager.unpauseGlobal(PauseCategory.DEPOSITS);

            await pauseManager.pauseGlobal(PauseCategory.WITHDRAWALS);
            await expect(mzusd.requestWithdrawal(1n))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.WITHDRAWALS);
            await pauseManager.unpauseGlobal(PauseCategory.WITHDRAWALS);

            await pauseManager.pauseGlobal(PauseCategory.TRANSFERS);
            await expect(mzusd.transfer(bob.address, 1n))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.TRANSFERS);
            await expect(mzusd.approve(bob.address, 1n))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.TRANSFERS);
            await expect(mzusd.transferFrom(alice.address, bob.address, 1n))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.TRANSFERS);
            await pauseManager.unpauseGlobal(PauseCategory.TRANSFERS);

            await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);
            await expect(mzusd.connect(vaultSigner).mint(deployer.address, 1n))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await expect(mzusd.connect(deployer).burn(1n))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await pauseManager.unpauseGlobal(PauseCategory.PROTOCOL);

            await pauseManager.pauseGlobal(PauseCategory.ADMIN);
            const cap = await mzusd.globalRedemptionCapUSDC();
            await expect(mzusd.setGlobalRedemptionCap(cap + 1n))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            const duration = await mzusd.redemptionWindowDuration();
            await expect(mzusd.setRedemptionWindowDuration(duration + 1n))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
            await expect(mzusd.setWithdrawalFeeBps(1))
                .to.be.revertedWithCustomError(mzusd, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
        });
    });

    describe("Burn access", () => {
        it("Requires burner role and burns caller balance", async () => {
            await accessManager.revokeRole(BURNER_ROLE, deployer.address);
            await expect(mzusd.connect(deployer).burn(1n)).to.be.reverted;
            await accessManager.grantRole(BURNER_ROLE, deployer.address, 0);

            const depositAmountUSDC = to6(5n);
            await usdc.connect(whale).transfer(deployer.address, depositAmountUSDC);
            await usdc.connect(deployer).approve(mzusd.target, depositAmountUSDC);
            await mzusd.connect(deployer).deposit(depositAmountUSDC);

            const burnAmount = await mzusd.balanceOf(deployer.address);
            const supplyBefore = await mzusd.totalSupply();

            await mzusd.connect(deployer).burn(burnAmount);

            const supplyAfter = await mzusd.totalSupply();
            expect(supplyBefore - supplyAfter).to.equal(burnAmount);
            expect(await mzusd.balanceOf(deployer.address)).to.equal(0n);
        });
    });

    describe("Deposits and withdrawals", () => {
        it("Should deposit USDC and receive MZUSD", async () => {
            const expectedMZAmount = to18(133n);
            const depositAmountUSDC = to6(133n);

            const whaleUSDCBefore = await usdc.balanceOf(USDC_WHALE);
            expect(whaleUSDCBefore).to.be.gt(
                depositAmountUSDC,
                "Not enough USDC balance in the whale"
            );

            await usdc.connect(whale).transfer(alice.address, depositAmountUSDC);

            const aliceUSDCBefore = await usdc.balanceOf(alice.address);
            const vaultUSDCBefore = await usdc.balanceOf(vault.target);
            const aliceMZBefore = await mzusd.balanceOf(alice.address);
            const supplyBefore = await mzusd.totalSupply();

            expect(aliceUSDCBefore).to.equal(depositAmountUSDC);
            expect(aliceMZBefore).to.equal(0n);

            // Deposit by Alice
            await usdc.connect(alice).approve(mzusd.target, depositAmountUSDC);
            const tx = await mzusd.connect(alice).deposit(depositAmountUSDC);
            await tx.wait();

            await expect(tx).to.emit(mzusd, "Deposit").withArgs(alice.address, depositAmountUSDC);

            const aliceUSDCAfter = await usdc.balanceOf(alice.address);
            const vaultUSDCAfter = await usdc.balanceOf(vault.target);
            const aliceMZAfter = await mzusd.balanceOf(alice.address);
            const supplyAfter = await mzusd.totalSupply();

            // Alice's USDC were spent
            expect(aliceUSDCAfter).to.equal(0n);

            // IssuanceVault received the USDC
            expect(vaultUSDCAfter - vaultUSDCBefore).to.equal(depositAmountUSDC);

            // Alice received MZUSD 1:1 to USDC in 18 decimals.
            expect(aliceMZAfter - aliceMZBefore).to.equal(expectedMZAmount);
            expect(supplyAfter - supplyBefore).to.equal(expectedMZAmount);
        });

        it("Should burn MZUSD and withdraw USDC back to the user", async () => {
            const depositAmountUSDC = to6(173n);
            const expectedMZAmount = to18(173n);

            // Fund Alice via the whale
            await fundAliceWithUSDC(depositAmountUSDC);

            // Attempt to withdraw without balance
            await expect(mzusd.connect(alice).requestWithdrawal(to18(1n))).to.be.reverted;

            // Sanity checks before deposit
            const aliceUSDCBefore = await usdc.balanceOf(alice.address);
            const aliceMZBefore = await mzusd.balanceOf(alice.address);
            const vaultUSDCBefore = await usdc.balanceOf(vault.target);

            expect(aliceUSDCBefore).to.equal(depositAmountUSDC);
            expect(aliceMZBefore).to.equal(0n);

            // Alice deposits USDC -> receives MZUSD
            await aliceDepositUSDC(depositAmountUSDC);

            const aliceUSDCAfterDeposit = await usdc.balanceOf(alice.address);
            const aliceMZAfterDeposit = await mzusd.balanceOf(alice.address);
            const vaultUSDCAfterDeposit = await usdc.balanceOf(vault.target);
            const supplyAfterDeposit = await mzusd.totalSupply();

            expect(aliceUSDCAfterDeposit).to.equal(0n);
            expect(aliceMZAfterDeposit).to.equal(expectedMZAmount);
            expect(vaultUSDCAfterDeposit - vaultUSDCBefore).to.equal(depositAmountUSDC);
            expect(supplyAfterDeposit).to.equal(expectedMZAmount);

            await expect(mzusd.connect(alice).requestWithdrawal(0n))
                .to.be.revertedWithCustomError(mzusd, "TooSmallWithdrawalAmount")
                .withArgs(0n, 0n);

            // Request withdrawal of full MZ balance
            const tx = await mzusd.connect(alice).requestWithdrawal(aliceMZAfterDeposit);
            await tx.wait();

            await expect(tx)
                .to.emit(mzusd, "Withdrawal")
                .withArgs(alice.address, depositAmountUSDC);

            await expect(tx)
                .to.emit(vault, "WithdrawnUSDCFromVault")
                .withArgs(alice.address, depositAmountUSDC);

            const aliceUSDCAfterWithdraw = await usdc.balanceOf(alice.address);
            const aliceMZAfterWithdraw = await mzusd.balanceOf(alice.address);
            const vaultUSDCAfterWithdraw = await usdc.balanceOf(vault.target);
            const supplyAfterWithdraw = await mzusd.totalSupply();

            // Alice got her USDC back and burned all MZUSD
            expect(aliceMZAfterWithdraw).to.equal(0n);
            expect(aliceUSDCAfterWithdraw).to.equal(depositAmountUSDC);
            expect(supplyAfterWithdraw).to.equal(0n);

            // IssuanceVault lost exactly the withdrawn amount
            expect(vaultUSDCAfterDeposit - vaultUSDCAfterWithdraw).to.equal(depositAmountUSDC);
        });

        it("Direct USDC transfer to MZUSD does not affect deposits or withdrawals", async () => {
            const strayUSDC = to6(12n);
            await usdc.connect(whale).transfer(mzusd.target, strayUSDC);
            const mzUsdcBefore = await usdc.balanceOf(mzusd.target);
            expect(mzUsdcBefore).to.equal(strayUSDC);

            const depositAmountUSDC = to6(25n);
            await fundAndDepositForAlice(depositAmountUSDC);

            const aliceMZ = await mzusd.balanceOf(alice.address);
            await (await mzusd.connect(alice).requestWithdrawal(aliceMZ)).wait();

            const aliceUSDC = await usdc.balanceOf(alice.address);
            expect(aliceUSDC).to.equal(depositAmountUSDC);
            expect(await mzusd.balanceOf(alice.address)).to.equal(0n);

            const mzUsdcAfter = await usdc.balanceOf(mzusd.target);
            expect(mzUsdcAfter).to.equal(mzUsdcBefore);
        });

        it("Should revert with InsufficientLiquidity when IssuanceVault does not have enough USDC", async () => {
            const depositAmountUSDC = to6(50n);

            // Fund Alice and deposit into MZUSD (USDC goes to IssuanceVault)
            await fundAndDepositForAlice(depositAmountUSDC);

            // Empty the IssuanceVault's USDC by transferring it out to Bob
            const vaultSigner = await imp(vault.target);
            const vaultBalance = await usdc.balanceOf(vault.target);
            expect(vaultBalance).to.equal(depositAmountUSDC);

            await usdc.connect(vaultSigner).transfer(bob.address, vaultBalance);

            const vaultBalanceAfter = await usdc.balanceOf(vault.target);
            expect(vaultBalanceAfter).to.equal(0n);
            // Now Alice tries to withdraw her 50 MZUSD -> 50 USDC
            await expect(mzusd.connect(alice).requestWithdrawal(to18(50n))).to.be.reverted;
        });

        describe("Withdrawal edge cases", () => {
            it("Should revert with TooSmallWithdrawalAmount for tiny MZUSD withdrawals", async () => {
                // Ensure Alice has some MZUSD balance
                const depositAmountUSDC = to6(1n); // 1 USDC
                await fundAndDepositForAlice(depositAmountUSDC);

                // Use a withdrawal amount below 1 USDC equivalent (dust only)
                const scale = to18(1n) / to6(1n);
                const tooSmallAmountMZ = scale - 1n;

                // usdcOut will be 0 for this amount, so TooSmallWithdrawalAmount should trigger
                await expect(mzusd.connect(alice).requestWithdrawal(tooSmallAmountMZ))
                    .to.be.revertedWithCustomError(mzusd, "TooSmallWithdrawalAmount")
                    .withArgs(tooSmallAmountMZ, 0n);
            });

            it("Should ignore dust in withdrawal amount and burn only the integral portion", async () => {
                const depositAmountUSDC = to6(10n); // 10 USDC
                await fundAndDepositForAlice(depositAmountUSDC);

                const amountMZ = to18(10n) + 123n; // 10 USDC + dust

                await expect(mzusd.connect(alice).requestWithdrawal(amountMZ))
                    .to.emit(mzusd, "Withdrawal")
                    .withArgs(alice.address, to6(10n));

                const aliceMZAfter = await mzusd.balanceOf(alice.address);
                const aliceUSDCAfter = await usdc.balanceOf(alice.address);

                expect(aliceMZAfter).to.equal(0n);
                expect(aliceUSDCAfter).to.equal(depositAmountUSDC);
            });
        });
    });

    describe("Withdrawal fee", () => {
        it("Charges withdrawal fee and keeps fee amount in IssuanceVault", async () => {
            const feeBps = 500; // 5%
            const depositAmountUSDC = to6(100n);
            const feeAmountUSDC = (depositAmountUSDC * BigInt(feeBps)) / 10_000n;
            const netAmountUSDC = depositAmountUSDC - feeAmountUSDC;

            await expect(mzusd.setWithdrawalFeeBps(feeBps))
                .to.emit(mzusd, "WithdrawalFeeUpdated")
                .withArgs(feeBps);

            await fundAndDepositForAlice(depositAmountUSDC);

            const aliceMZ = await mzusd.balanceOf(alice.address);
            const vaultUSDCBefore = await usdc.balanceOf(vault.target);
            expect(vaultUSDCBefore).to.equal(depositAmountUSDC);

            await expect(mzusd.connect(alice).requestWithdrawal(aliceMZ))
                .to.emit(mzusd, "Withdrawal")
                .withArgs(alice.address, netAmountUSDC);

            expect(await usdc.balanceOf(alice.address)).to.equal(netAmountUSDC);
            expect(await usdc.balanceOf(vault.target)).to.equal(feeAmountUSDC);
            expect(await mzusd.balanceOf(alice.address)).to.equal(0n);
        });

        it("When withdrawal fee is zero, withdrawal returns full gross USDC and keeps no fee in vault", async () => {
            const initialFeeBps = 777; // 7.77%
            const depositAmountUSDC = to6(100n);

            await expect(mzusd.setWithdrawalFeeBps(initialFeeBps))
                .to.emit(mzusd, "WithdrawalFeeUpdated")
                .withArgs(initialFeeBps);

            // Explicitly set fee back to zero to exercise the no-fee path.
            await expect(mzusd.setWithdrawalFeeBps(0))
                .to.emit(mzusd, "WithdrawalFeeUpdated")
                .withArgs(0);

            await fundAndDepositForAlice(depositAmountUSDC);
            const aliceMZ = await mzusd.balanceOf(alice.address);

            await expect(mzusd.connect(alice).requestWithdrawal(aliceMZ))
                .to.emit(mzusd, "Withdrawal")
                .withArgs(alice.address, depositAmountUSDC);

            expect(await usdc.balanceOf(alice.address)).to.equal(depositAmountUSDC);
            expect(await usdc.balanceOf(vault.target)).to.equal(0n);
            expect(await mzusd.balanceOf(alice.address)).to.equal(0n);
        });

        it("Counts gross withdrawal against cap even when fee is enabled", async () => {
            const feeBps = 5000; // 50%
            const capUSDC = to6(100n);
            const depositAmountUSDC = to6(200n);

            await mzusd.setWithdrawalFeeBps(feeBps);
            await mzusd.setGlobalRedemptionCap(capUSDC);
            await fundAndDepositForAlice(depositAmountUSDC);

            await mzusd.connect(alice).requestWithdrawal(to18(100n));

            const [, usedUSDC, remainingUSDC] = await mzusd.getRemainingRedemptionCap();
            expect(usedUSDC).to.equal(capUSDC);
            expect(remainingUSDC).to.equal(0n);

            await expect(mzusd.connect(alice).requestWithdrawal(to18(1n)))
                .to.be.revertedWithCustomError(mzusd, "GlobalRedemptionCapExceeded")
                .withArgs(capUSDC, capUSDC + to6(1n), to6(1n));
        });

        it("Validates withdrawal fee bps bounds and same-value updates", async () => {
            await expect(mzusd.setWithdrawalFeeBps(10_000)).to.be.revertedWithCustomError(
                mzusd,
                "TooBigBps"
            );
            await expect(mzusd.setWithdrawalFeeBps(10_001)).to.be.revertedWithCustomError(
                mzusd,
                "TooBigBps"
            );

            await expect(mzusd.setWithdrawalFeeBps(9_999))
                .to.emit(mzusd, "WithdrawalFeeUpdated")
                .withArgs(9_999);
            await expect(mzusd.setWithdrawalFeeBps(9_999)).to.be.revertedWithCustomError(
                mzusd,
                "SameValue"
            );
        });
    });

    describe("Redemption cap", () => {
        it("Should cap global redemption at USDC total supply", async () => {
            await expect(mzusd.setGlobalRedemptionCap(usdcTotalSupply))
                .to.emit(mzusd, "GlobalRedemptionCapUpdated")
                .withArgs(usdcTotalSupply);

            const overSupply = usdcTotalSupply + 1n;
            await expect(mzusd.setGlobalRedemptionCap(overSupply))
                .to.emit(mzusd, "GlobalRedemptionCapUpdated")
                .withArgs(overSupply);
            expect(await mzusd.globalRedemptionCapUSDC()).to.equal(overSupply);
        });

        it("Should enforce the global redemption cap", async () => {
            // Set a small cap: 150 USDC
            const capUSDC = to6(150n);
            await mzusd.setGlobalRedemptionCap(capUSDC);

            const depositAmountUSDC = to6(200n);

            // Fund Alice and deposit 200 USDC -> 200 MZUSD
            await fundAndDepositForAlice(depositAmountUSDC);

            const aliceMZBalance = await mzusd.balanceOf(alice.address);
            expect(aliceMZBalance).to.equal(to18(200n));

            // First withdrawal: 100 USDC (within cap)
            const firstWithdrawMZ = to18(100n);
            const firstWithdrawUSDC = to6(100n);

            const tx1 = await mzusd.connect(alice).requestWithdrawal(firstWithdrawMZ);
            await tx1.wait();

            await expect(tx1)
                .to.emit(mzusd, "Withdrawal")
                .withArgs(alice.address, firstWithdrawUSDC);

            // Second withdrawal in the same hour: 60 USDC -> should exceed the 150 USDC cap
            const secondWithdrawMZ = to18(60n);

            await expect(
                mzusd.connect(alice).requestWithdrawal(secondWithdrawMZ)
            ).to.be.revertedWithCustomError(mzusd, "GlobalRedemptionCapExceeded");

            // Move time forward by 1 hour to reset the rolling window
            await time.increase(3600);

            // Now the same withdrawal should succeed
            const tx2 = await mzusd.connect(alice).requestWithdrawal(secondWithdrawMZ);
            await tx2.wait();

            await expect(tx2).to.emit(mzusd, "Withdrawal").withArgs(alice.address, to6(60n));
        });

        it("Should handle complex flows with multiple users and helper netting patterns", async () => {
            // Redemption cap: 500 USDC
            const capUSDC = to6(500n);
            await mzusd.setGlobalRedemptionCap(capUSDC);

            // Fund Alice, Bob and helper with USDC
            const aliceUSDC = to6(400n);
            const bobUSDC = to6(300n);
            const helperUSDC = to6(300n);

            await usdc.connect(whale).transfer(alice.address, aliceUSDC);
            await usdc.connect(whale).transfer(bob.address, bobUSDC);
            await usdc.connect(whale).transfer(nettingHelper.target, helperUSDC);

            //1. Alice deposits 400 USDC (no cap usage)

            await usdc.connect(alice).approve(mzusd.target, aliceUSDC);
            await mzusd.connect(alice).deposit(aliceUSDC);

            let [, usedUSDC, remainingCap] = await mzusd.getRemainingRedemptionCap();
            expect(remainingCap).to.equal(capUSDC, "Deposit should not consume the redemption cap");
            expect(usedUSDC).to.equal(0n);

            //2. Alice withdraws 150 MZUSD -> 150 USDC (pure outflow)

            const aliceWithdraw1MZ = to18(150n);
            const txA1 = await mzusd.connect(alice).requestWithdrawal(aliceWithdraw1MZ);
            await txA1.wait();

            [, usedUSDC, remainingCap] = await mzusd.getRemainingRedemptionCap();
            expect(usedUSDC).to.equal(
                to6(150n),
                "Alice first withdrawal should consume 150 USDC of the cap"
            );

            //3. Bob deposits 300 USDC (no cap usage)

            await usdc.connect(bob).approve(mzusd.target, bobUSDC);
            await mzusd.connect(bob).deposit(bobUSDC);

            [, usedUSDC, remainingCap] = await mzusd.getRemainingRedemptionCap();
            expect(usedUSDC).to.equal(to6(150n), "Bob deposit should not touch the cap");

            //4. Bob withdraws 70 MZUSD -> 70 USDC

            const bobWithdraw1MZ = to18(70n);
            const txB1 = await mzusd.connect(bob).requestWithdrawal(bobWithdraw1MZ);
            await txB1.wait();

            [, usedUSDC, remainingCap] = await mzusd.getRemainingRedemptionCap();
            // total used so far: 150 (Alice) + 70 (Bob) = 220
            expect(usedUSDC).to.equal(
                to6(220n),
                "Alice + Bob withdrawals should consume 220 USDC in total"
            );

            //Helper preload: depositOnly 200 USDC -> 200 MZUSD (no cap usage)

            const helperPreDepositUSDC = to6(200n);
            const txHPre = await nettingHelper
                .connect(deployer)
                .depositOnly(mzusd.target, usdc.target, helperPreDepositUSDC);
            await txHPre.wait();
            //5. helper withdrawThenDeposit (W -> D) 60 MZ, 60 USDC

            const helperWTD_MZ = to18(60n);
            const helperWTD_DepUSDC = to6(60n);

            const txH1 = await nettingHelper
                .connect(deployer)
                .withdrawThenDeposit(mzusd.target, usdc.target, helperWTD_MZ, helperWTD_DepUSDC);
            await txH1.wait();

            [, usedUSDC, remainingCap] = await mzusd.getRemainingRedemptionCap();
            // total used now: 220 + 60 = 280
            expect(usedUSDC).to.equal(to6(280n), "W->D pattern should add 60 USDC to the cap");

            //6. helper withdrawDepositWithdraw (W=40, D=50, W=70)
            //
            // In USDC terms:
            //   step1: withdraw 40, txDeposited=0 -> effective1 = 40
            //   step2: deposit 50, txDeposited=50
            //   step3: withdraw 70, txDeposited=50 -> effective2 = 20
            // So this tx adds 40 + 20 = 60 USDC to the cap.

            const w1MZ = to18(40n);
            const depUSDC = to6(50n);
            const w2MZ = to18(70n);

            const txH2 = await nettingHelper
                .connect(deployer)
                .withdrawDepositWithdraw(mzusd.target, usdc.target, w1MZ, depUSDC, w2MZ);
            await txH2.wait();

            [, usedUSDC, remainingCap] = await mzusd.getRemainingRedemptionCap();
            // total used now: 280 + 60 = 340
            expect(usedUSDC).to.equal(
                to6(340n),
                "W->D->W pattern should add another 60 USDC to the cap"
            );

            //7. Alice withdraws another 150 MZUSD -> 150 USDC

            const aliceWithdraw2MZ = to18(150n);
            const txA2 = await mzusd.connect(alice).requestWithdrawal(aliceWithdraw2MZ);
            await txA2.wait();

            [, usedUSDC, remainingCap] = await mzusd.getRemainingRedemptionCap();
            // total used: 340 + 150 = 490
            expect(usedUSDC).to.equal(
                to6(490n),
                "Second Alice withdrawal should bring total usage to 490 USDC"
            );

            // Extra helper atomic netting: TX7.5
            // deposit 100 USDC and withdraw 90 MZUSD in a single tx.
            // In USDC terms:
            //   deposit = 100
            //   usdcOut = 90
            //   txDeposited (100) >= usdcOut (90) -> _applyAtomicNetting returns 0
            // So this tx MUST NOT consume any additional redemption cap.

            const helperNetDepositUSDC = to6(100n);
            const helperNetWithdrawMZ = to18(90n);

            // top up helper just in case
            await usdc.connect(whale).transfer(nettingHelper.target, helperNetDepositUSDC);

            const [, , capBeforeNetting] = await mzusd.getRemainingRedemptionCap();

            const txHN = await nettingHelper
                .connect(deployer)
                .depositAndWithdraw(
                    mzusd.target,
                    usdc.target,
                    helperNetDepositUSDC,
                    helperNetWithdrawMZ
                );
            await txHN.wait();

            const [, , capAfterNetting] = await mzusd.getRemainingRedemptionCap();
            expect(capAfterNetting).to.equal(
                capBeforeNetting,
                "Atomic D>W netting (depositAndWithdraw) should not consume the cap"
            );

            //8. Bob tries to withdraw 20 MZUSD -> 20 USDC
            // 490 + 20 > 500 =>
            // must revert on GlobalRedemptionCapExceeded

            const bobWithdraw2MZ = to18(20n);
            await expect(
                mzusd.connect(bob).requestWithdrawal(bobWithdraw2MZ)
            ).to.be.revertedWithCustomError(mzusd, "GlobalRedemptionCapExceeded");
        });

        it("Should correctly compute remaining global redemption cap and preview functions", async () => {
            // 1) cap = USDC total supply -> max allowed
            await mzusd.setGlobalRedemptionCap(usdcTotalSupply);

            let [cap, used, remaining] = await mzusd.getRemainingRedemptionCap();
            const storedWindowStart = await mzusd.windowStartTimestamp();

            expect(cap).to.equal(usdcTotalSupply);
            expect(used).to.equal(0n);
            expect(remaining).to.equal(usdcTotalSupply);
            expect(storedWindowStart).to.equal(await mzusd.windowStartTimestamp());

            // 2) cap > 0, window is active, usage < cap and = cap
            const capUSDC = to6(150n);
            await mzusd.setGlobalRedemptionCap(capUSDC);

            const depositAmountUSDC = to6(200n);

            await fundAndDepositForAlice(depositAmountUSDC);

            // First withdrawal: 40 USDC
            const w1MZ = to18(40n);
            await mzusd.connect(alice).requestWithdrawal(w1MZ);

            [cap, used, remaining] = await mzusd.getRemainingRedemptionCap();
            expect(remaining).to.equal(capUSDC - to6(40n));
            expect(used).to.equal(to6(40n));

            // Second withdrawal: 110 USDC -> should reach the cap because 40 + 110 = 150
            const w2MZ = to18(110n);
            await mzusd.connect(alice).requestWithdrawal(w2MZ);

            [cap, used, remaining] = await mzusd.getRemainingRedemptionCap();
            expect(remaining).to.equal(0n);
            expect(used).to.equal(capUSDC);

            // 3) Move time forward by 1 hour + 1 second, new window, full cap
            await time.increase(3601);

            const latestTs = await time.latest();
            [cap, used, remaining] = await mzusd.getRemainingRedemptionCap();

            expect(remaining).to.equal(capUSDC);
            expect(used).to.equal(0n);

            const [windowStart] = await mzusd.getRedemptionWindow();
            expect(windowStart).to.equal(BigInt(latestTs));

            // decimals check
            const decimals = await mzusd.decimals();
            expect(decimals).to.equal(18);
        });

        it("Should allow deposits and withdrawals when redemption cap is effectively unlimited", async () => {
            // Effectively disable cap by setting it to total supply (no practical limit)
            await mzusd.setGlobalRedemptionCap(usdcTotalSupply);

            const depositAmountUSDC = to6(300n); // 300 USDC

            // Fund Alice and deposit into MZUSD
            await fundAndDepositForAlice(depositAmountUSDC);

            const aliceMZ = await mzusd.balanceOf(alice.address);
            expect(aliceMZ).to.equal(to18(300n));

            // Getter should report max remaining cap when cap is effectively disabled
            const [, , remainingBefore] = await mzusd.getRemainingRedemptionCap();
            expect(remainingBefore).to.equal(usdcTotalSupply);

            const firstWithdrawMZ = to18(200n); // 200 USDC
            const secondWithdrawMZ = to18(100n); // 100 USDC

            await mzusd.connect(alice).requestWithdrawal(firstWithdrawMZ);
            await mzusd.connect(alice).requestWithdrawal(secondWithdrawMZ);

            const aliceMZAfter = await mzusd.balanceOf(alice.address);
            const aliceUSDCAfter = await usdc.balanceOf(alice.address);

            expect(aliceMZAfter).to.equal(0n);
            expect(aliceUSDCAfter).to.equal(depositAmountUSDC);

            const [, , remainingAfter] = await mzusd.getRemainingRedemptionCap();
            expect(remainingAfter).to.equal(usdcTotalSupply - depositAmountUSDC);
        });

        it("Should reject zero cap in setter", async () => {
            await expect(mzusd.setGlobalRedemptionCap(0)).to.be.revertedWithCustomError(
                mzusd,
                "ZeroCap"
            );
        });
    });

    describe("Redemption window", () => {
        it("Should validate redemption window duration updates and queue changes", async () => {
            // Zero duration is not allowed
            await expect(mzusd.setRedemptionWindowDuration(0)).to.be.revertedWithCustomError(
                mzusd,
                "InvalidRedemptionWindowDuration"
            );

            // Reject values outside bounds
            const tooShort = 30 * 60; // 30 minutes
            await expect(mzusd.setRedemptionWindowDuration(tooShort)).to.be.revertedWithCustomError(
                mzusd,
                "InvalidRedemptionWindowDuration"
            );

            const tooLong = 31 * 24 * 60 * 60; // 31 days
            await expect(mzusd.setRedemptionWindowDuration(tooLong)).to.be.revertedWithCustomError(
                mzusd,
                "InvalidRedemptionWindowDuration"
            );

            // Queue update to 2 hours and check storage + event
            const newDuration = 2 * 60 * 60; // 2 hours

            await expect(mzusd.setRedemptionWindowDuration(newDuration))
                .to.emit(mzusd, "RedemptionWindowDurationQueued")
                .withArgs(newDuration);

            const storedDuration = await mzusd.redemptionWindowDuration();
            const queuedDuration = await mzusd.nextRedemptionWindowDuration();
            expect(storedDuration).to.equal(60 * 60);
            expect(queuedDuration).to.equal(newDuration);
        });

        it("Should apply queued redemption duration on next window", async () => {
            // Set a finite cap to observe remaining/used values
            const capUSDC = to6(200n);
            await mzusd.setGlobalRedemptionCap(capUSDC);

            // Alice deposits 200 USDC -> 200 MZUSD
            const depositAmountUSDC = to6(200n);
            await fundAndDepositForAlice(depositAmountUSDC);

            // Alice withdraws 80 USDC -> consumes part of the cap
            const withdrawMZ = to18(80n);
            await mzusd.connect(alice).requestWithdrawal(withdrawMZ);

            // Capture window state after withdrawal
            const [, , remainingBefore] = await mzusd.getRemainingRedemptionCap();
            const usedBefore = capUSDC - remainingBefore;
            const windowStartBefore = await mzusd.windowStartTimestamp();
            const durationBefore = await mzusd.redemptionWindowDuration();

            expect(usedBefore).to.equal(to6(80n));
            expect(durationBefore).to.equal(60 * 60); // initial 1h window

            // Queue window duration to 2h - this should NOT reset window
            const longerDuration = 2 * 60 * 60;
            await expect(mzusd.setRedemptionWindowDuration(longerDuration))
                .to.emit(mzusd, "RedemptionWindowDurationQueued")
                .withArgs(longerDuration);

            const windowStartLong = await mzusd.windowStartTimestamp();
            const usedLong = await mzusd.windowUsedUSDC();
            const storedDurationLong = await mzusd.redemptionWindowDuration();
            const queuedDuration = await mzusd.nextRedemptionWindowDuration();

            expect(storedDurationLong).to.equal(durationBefore);
            expect(windowStartLong).to.equal(windowStartBefore);
            expect(usedLong).to.equal(usedBefore);
            expect(queuedDuration).to.equal(longerDuration);

            // Move time forward so the current window expires
            await time.increase(3601);

            // Next withdrawal should roll the window and apply the queued duration
            const secondWithdrawMZ = to18(10n);
            await expect(mzusd.connect(alice).requestWithdrawal(secondWithdrawMZ))
                .to.emit(mzusd, "RedemptionWindowDurationUpdated")
                .withArgs(longerDuration);

            const storedDurationAfter = await mzusd.redemptionWindowDuration();
            const windowStartAfter = await mzusd.windowStartTimestamp();
            const usedAfter = await mzusd.windowUsedUSDC();
            const [, , remainingAfter] = await mzusd.getRemainingRedemptionCap();

            expect(storedDurationAfter).to.equal(longerDuration);
            expect(await mzusd.nextRedemptionWindowDuration()).to.equal(0); // Pending was reset

            const latestTs = await time.latest();
            expect(windowStartAfter).to.equal(BigInt(latestTs));

            expect(usedAfter).to.equal(to6(10n));
            expect(remainingAfter).to.equal(capUSDC - to6(10n));
        });

        it("getRedemptionWindow reflects pending duration after window expiry", async () => {
            const newDuration = 2 * 60 * 60;
            await mzusd.setRedemptionWindowDuration(newDuration);

            await time.increase(3601);

            const [windowStart, windowEnd, duration] = await mzusd.getRedemptionWindow();
            expect(duration).to.equal(newDuration);
            expect(windowEnd).to.equal(windowStart + BigInt(newDuration));
        });
    });
});
