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
import {MZUSD, Vault, ReservoirUSDC, IERC20, MZUSDNettingHelper} from "../typechain-types";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";
const VAULT_WITHDRAW_ROLE = 1n; //change later
const MZUSD_USER_ROLE = 2n;

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
    let vault: Vault;
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

        const ReservoirFactory = await ethers.getContractFactory("ReservoirUSDC", deployer);
        reservoir = await upgrades.deployProxy(ReservoirFactory, [accessManager.target], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [MAINNET_USDC],
        });

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = await upgrades.deployProxy(VaultFactory, [reservoir.target, accessManager.target], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [MAINNET_USDC],
        });

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = await upgrades.deployProxy(
            MZUSDFactory,
            [
                accessManager.target,
                usdcTotalSupply, // _hourlyLimitUSDC (max allowed; configured below in tests)
            ],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC, vault.target],
            }
        );

        const NettingHelperFactory = await ethers.getContractFactory(
            "MZUSDNettingHelper",
            deployer
        );
        nettingHelper = await NettingHelperFactory.deploy();
        await nettingHelper.waitForDeployment();

        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        const setMZUSDSelector = vault.interface.getFunction("setMZUSD").selector;
        await accessManager.setTargetFunctionRole(vault.target, [setMZUSDSelector], ADMIN_ROLE);

        await (await vault.setMZUSD(mzusd.target)).wait();
        await expect(mzusd.setGlobalHourlyRedemptionCap(to6(1_000_000n)))
            .to.emit(mzusd, "GlobalHourlyRedemptionCapUpdated")
            .withArgs(to6(1_000_000n)); // 1 million USDC per hour

        // AccessManager wiring for Vault.withdraw -> MZUSD
        const withdrawSelector = vault.interface.getFunction("withdraw").selector;

        // now vault.withdraw requires VAULT_WITHDRAW_ROLE
        await accessManager.setTargetFunctionRole(
            vault.target,
            [withdrawSelector],
            VAULT_WITHDRAW_ROLE
        );

        // grant VAULT_WITHDRAW_ROLE to MZUSD in AccessManager
        await accessManager.grantRole(
            VAULT_WITHDRAW_ROLE,
            mzusd.target,
            0 // executionDelay
        );

        // AccessManager wiring for MZUSD user-facing restricted functions
        const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();
        const depositSelector = mzusd.interface.getFunction("deposit").selector;
        const requestWithdrawalSelector = mzusd.interface.getFunction("requestWithdrawal").selector;
        const approveSelector = mzusd.interface.getFunction("approve").selector;
        const transferSelector = mzusd.interface.getFunction("transfer").selector;
        const transferFromSelector = mzusd.interface.getFunction("transferFrom").selector;

        // Assign USER role for deposit / requestWithdrawal
        await accessManager.setTargetFunctionRole(
            mzusd.target,
            [depositSelector, requestWithdrawalSelector],
            MZUSD_USER_ROLE
        );
        await accessManager.setTargetFunctionRole(
            mzusd.target,
            [approveSelector, transferSelector, transferFromSelector],
            PUBLIC_ROLE
        );

        // Grant MZUSD_USER_ROLE to all actors that call deposit/requestWithdrawal in tests
        const userRoleGrantees = [
            deployer.address,
            alice.address,
            bob.address,
            charlie.address,
            dave.address,
            nettingHelper.target,
        ];

        for (const grantee of userRoleGrantees) {
            await accessManager.grantRole(MZUSD_USER_ROLE, grantee, 0);
        }

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    it("Should deposit USDC and receive MZUSD", async () => {
        const expectedMZAmount = to18(133n);
        const depositAmountUSDC = to6(133n);

        const whaleUSDCBefore = await usdc.balanceOf(USDC_WHALE);
        expect(whaleUSDCBefore).to.be.gt(depositAmountUSDC, "Not enough USDC balance in the whale");

        await usdc.connect(whale).transfer(alice.address, depositAmountUSDC);

        const aliceUSDCBefore = await usdc.balanceOf(alice.address);
        const vaultUSDCBefore = await usdc.balanceOf(vault.target);
        const aliceMZBefore = await mzusd.balanceOf(alice.address);

        expect(aliceUSDCBefore).to.equal(depositAmountUSDC);
        expect(aliceMZBefore).to.equal(0n);

        // Deposit by Alice
        await usdc.connect(alice).approve(mzusd.target, depositAmountUSDC);
        const tx = await mzusd.connect(alice).deposit(depositAmountUSDC);
        await tx.wait();

        await expect(tx)
            .to.emit(mzusd, "Deposit")
            .withArgs(alice.address, depositAmountUSDC, expectedMZAmount);

        const aliceUSDCAfter = await usdc.balanceOf(alice.address);
        const vaultUSDCAfter = await usdc.balanceOf(vault.target);
        const aliceMZAfter = await mzusd.balanceOf(alice.address);

        // Alice's USDC were spent
        expect(aliceUSDCAfter).to.equal(0n);

        // Vault received the USDC
        expect(vaultUSDCAfter - vaultUSDCBefore).to.equal(depositAmountUSDC);

        // Alice received MZUSD 1:1 to USDC in 18 decimals.
        expect(aliceMZAfter - aliceMZBefore).to.equal(expectedMZAmount);
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

        expect(aliceUSDCAfterDeposit).to.equal(0n);
        expect(aliceMZAfterDeposit).to.equal(expectedMZAmount);
        expect(vaultUSDCAfterDeposit - vaultUSDCBefore).to.equal(depositAmountUSDC);

        await expect(mzusd.connect(alice).requestWithdrawal(0n))
            .to.be.revertedWithCustomError(mzusd, "TooSmallWithdrawalAmount")
            .withArgs(0n, 0n);

        // Request withdrawal of full MZ balance
        const tx = await mzusd.connect(alice).requestWithdrawal(aliceMZAfterDeposit);
        await tx.wait();

        await expect(tx)
            .to.emit(mzusd, "Withdrawal")
            .withArgs(alice.address, aliceMZAfterDeposit, depositAmountUSDC);

        await expect(tx)
            .to.emit(vault, "WithdrawnUSDCFromVault")
            .withArgs(alice.address, depositAmountUSDC);

        const aliceUSDCAfterWithdraw = await usdc.balanceOf(alice.address);
        const aliceMZAfterWithdraw = await mzusd.balanceOf(alice.address);
        const vaultUSDCAfterWithdraw = await usdc.balanceOf(vault.target);

        // Alice got her USDC back and burned all MZUSD
        expect(aliceMZAfterWithdraw).to.equal(0n);
        expect(aliceUSDCAfterWithdraw).to.equal(depositAmountUSDC);

        // Vault lost exactly the withdrawn amount
        expect(vaultUSDCAfterDeposit - vaultUSDCAfterWithdraw).to.equal(depositAmountUSDC);
    });

    it("Should cap global hourly redemption at USDC total supply", async () => {
        await expect(mzusd.setGlobalHourlyRedemptionCap(usdcTotalSupply))
            .to.emit(mzusd, "GlobalHourlyRedemptionCapUpdated")
            .withArgs(usdcTotalSupply);

        await expect(mzusd.setGlobalHourlyRedemptionCap(usdcTotalSupply + 1n))
            .to.be.revertedWithCustomError(mzusd, "CapExceedsTotalSupply")
            .withArgs(usdcTotalSupply + 1n, usdcTotalSupply);
    });

    it("Should enforce the global hourly redemption cap", async () => {
        // Set a small hourly cap: 150 USDC
        const capUSDC = to6(150n);
        await mzusd.setGlobalHourlyRedemptionCap(capUSDC);

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
            .withArgs(alice.address, firstWithdrawMZ, firstWithdrawUSDC);

        // Second withdrawal in the same hour: 60 USDC -> should exceed the 150 USDC cap
        const secondWithdrawMZ = to18(60n);

        await expect(
            mzusd.connect(alice).requestWithdrawal(secondWithdrawMZ)
        ).to.be.revertedWithCustomError(mzusd, "GlobalHourlyCapExceeded");

        // Move time forward by 1 hour to reset the rolling window
        await time.increase(3600);

        // Now the same withdrawal should succeed
        const tx2 = await mzusd.connect(alice).requestWithdrawal(secondWithdrawMZ);
        await tx2.wait();

        await expect(tx2)
            .to.emit(mzusd, "Withdrawal")
            .withArgs(alice.address, secondWithdrawMZ, to6(60n));
    });

    it("Should handle complex flows with multiple users and helper netting patterns", async () => {
        // Hourly cap: 500 USDC
        const capUSDC = to6(500n);
        await mzusd.setGlobalHourlyRedemptionCap(capUSDC);

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

        let [remainingCap] = await mzusd.getRemainingGlobalHourlyCap();
        expect(remainingCap).to.equal(capUSDC, "Deposit should not consume the hourly cap");

        //2. Alice withdraws 150 MZUSD -> 150 USDC (pure outflow)

        const aliceWithdraw1MZ = to18(150n);
        const txA1 = await mzusd.connect(alice).requestWithdrawal(aliceWithdraw1MZ);
        await txA1.wait();

        [remainingCap] = await mzusd.getRemainingGlobalHourlyCap();
        expect(capUSDC - remainingCap).to.equal(
            to6(150n),
            "Alice first withdrawal should consume 150 USDC of the cap"
        );

        //3. Bob deposits 300 USDC (no cap usage)

        await usdc.connect(bob).approve(mzusd.target, bobUSDC);
        await mzusd.connect(bob).deposit(bobUSDC);

        [remainingCap] = await mzusd.getRemainingGlobalHourlyCap();
        expect(capUSDC - remainingCap).to.equal(to6(150n), "Bob deposit should not touch the cap");

        //4. Bob withdraws 70 MZUSD -> 70 USDC

        const bobWithdraw1MZ = to18(70n);
        const txB1 = await mzusd.connect(bob).requestWithdrawal(bobWithdraw1MZ);
        await txB1.wait();

        [remainingCap] = await mzusd.getRemainingGlobalHourlyCap();
        // total used so far: 150 (Alice) + 70 (Bob) = 220
        expect(capUSDC - remainingCap).to.equal(
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

        [remainingCap] = await mzusd.getRemainingGlobalHourlyCap();
        // total used now: 220 + 60 = 280
        expect(capUSDC - remainingCap).to.equal(
            to6(280n),
            "W->D pattern should add 60 USDC to the cap"
        );

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

        [remainingCap] = await mzusd.getRemainingGlobalHourlyCap();
        // total used now: 280 + 60 = 340
        expect(capUSDC - remainingCap).to.equal(
            to6(340n),
            "W->D->W pattern should add another 60 USDC to the cap"
        );

        //7. Alice withdraws another 150 MZUSD -> 150 USDC

        const aliceWithdraw2MZ = to18(150n);
        const txA2 = await mzusd.connect(alice).requestWithdrawal(aliceWithdraw2MZ);
        await txA2.wait();

        [remainingCap] = await mzusd.getRemainingGlobalHourlyCap();
        // total used: 340 + 150 = 490
        expect(capUSDC - remainingCap).to.equal(
            to6(490n),
            "Second Alice withdrawal should bring total usage to 490 USDC"
        );

        // Extra helper atomic netting: TX7.5
        // deposit 100 USDC and withdraw 90 MZUSD in a single tx.
        // In USDC terms:
        //   deposit = 100
        //   usdcOut = 90
        //   txDeposited (100) >= usdcOut (90) -> _applyAtomicNetting returns 0
        // So this tx MUST NOT consume any additional hourly cap.

        const helperNetDepositUSDC = to6(100n);
        const helperNetWithdrawMZ = to18(90n);

        // top up helper just in case
        await usdc.connect(whale).transfer(nettingHelper.target, helperNetDepositUSDC);

        const [capBeforeNetting] = await mzusd.getRemainingGlobalHourlyCap();

        const txHN = await nettingHelper
            .connect(deployer)
            .depositAndWithdraw(
                mzusd.target,
                usdc.target,
                helperNetDepositUSDC,
                helperNetWithdrawMZ
            );
        await txHN.wait();

        const [capAfterNetting] = await mzusd.getRemainingGlobalHourlyCap();
        expect(capAfterNetting).to.equal(
            capBeforeNetting,
            "Atomic D>W netting (depositAndWithdraw) should not consume the cap"
        );

        //8. Bob tries to withdraw 20 MZUSD -> 20 USDC
        // 490 + 20 > 500 =>
        // must revert on GlobalHourlyCapExceeded

        const bobWithdraw2MZ = to18(20n);
        await expect(
            mzusd.connect(bob).requestWithdrawal(bobWithdraw2MZ)
        ).to.be.revertedWithCustomError(mzusd, "GlobalHourlyCapExceeded");
    });

    it("Should revert with InsufficientLiquidity when Vault does not have enough USDC", async () => {
        const depositAmountUSDC = to6(50n);

        // Fund Alice and deposit into MZUSD (USDC goes to Vault)
        await fundAndDepositForAlice(depositAmountUSDC);

        // Empty the Vault's USDC by transferring it out to Bob
        const vaultSigner = await imp(vault.target);
        const vaultBalance = await usdc.balanceOf(vault.target);
        expect(vaultBalance).to.equal(depositAmountUSDC);

        await usdc.connect(vaultSigner).transfer(bob.address, vaultBalance);

        const vaultBalanceAfter = await usdc.balanceOf(vault.target);
        expect(vaultBalanceAfter).to.equal(0n);
        // Now Alice tries to withdraw her 50 MZUSD -> 50 USDC
        await expect(mzusd.connect(alice).requestWithdrawal(to18(50n))).to.be.reverted;
    });

    it("Should correctly compute remaining global hourly cap and preview functions", async () => {
        // 1) cap = USDC total supply -> max allowed
        await mzusd.setGlobalHourlyRedemptionCap(usdcTotalSupply);

        let [remaining, windowStart] = await mzusd.getRemainingGlobalHourlyCap();
        const storedWindowStart = await mzusd.windowStartTimestamp();

        expect(remaining).to.equal(usdcTotalSupply);
        expect(windowStart).to.equal(storedWindowStart);

        // 2) cap > 0, window is active, usage < cap and = cap
        const capUSDC = to6(150n);
        await mzusd.setGlobalHourlyRedemptionCap(capUSDC);

        const depositAmountUSDC = to6(200n);

        await fundAndDepositForAlice(depositAmountUSDC);

        // First withdrawal: 40 USDC
        const w1MZ = to18(40n);
        await mzusd.connect(alice).requestWithdrawal(w1MZ);

        [remaining, windowStart] = await mzusd.getRemainingGlobalHourlyCap();
        expect(remaining).to.equal(capUSDC - to6(40n));
        expect(windowStart).to.equal(await mzusd.windowStartTimestamp());

        // Second withdrawal: 110 USDC -> should reach the cap because 40 + 110 = 150
        const w2MZ = to18(110n);
        await mzusd.connect(alice).requestWithdrawal(w2MZ);

        [remaining, windowStart] = await mzusd.getRemainingGlobalHourlyCap();
        expect(remaining).to.equal(0n);
        expect(windowStart).to.equal(await mzusd.windowStartTimestamp());

        // 3) Move time forward by 1 hour + 1 second, new window, full cap
        await time.increase(3601);

        const latestTs = await time.latest();
        [remaining, windowStart] = await mzusd.getRemainingGlobalHourlyCap();

        expect(remaining).to.equal(capUSDC);
        expect(windowStart).to.equal(BigInt(latestTs));

        // Preview helpers

        // calculateDeposit: 123 USDC -> 123 MZUSD in 18 decimals
        const previewMint = await mzusd.calculateDeposit(to6(123n));
        expect(previewMint).to.equal(to18(123n));

        // previewWithdrawalFlat: amountMZ with dust
        const amountMZ = to18(10n) + 123n; // 10 USDC + 123 dust
        const [, , , usdcOut, unconvertedMZ] = await mzusd
            .connect(alice)
            .previewWithdrawalFlat(amountMZ);

        expect(usdcOut).to.equal(to6(10n)); // 10 USDC
        expect(unconvertedMZ).to.equal(123n);

        // decimals check
        const decimals = await mzusd.decimals();
        expect(decimals).to.equal(18);
    });

    it("Should correctly preview withdrawal flat data including cap and liquidity", async () => {
        // Set a finite hourly cap so we can observe usage
        const capUSDC = to6(150n);
        await mzusd.setGlobalHourlyRedemptionCap(capUSDC);

        // Fund Alice and deposit 200 USDC -> 200 MZUSD
        const depositAmountUSDC = to6(200n);
        await fundAndDepositForAlice(depositAmountUSDC);

        const aliceMZAfterDeposit = await mzusd.balanceOf(alice.address);
        expect(aliceMZAfterDeposit).to.equal(to18(200n));

        // First real withdrawal: 60 USDC (consumes part of cap)
        const firstWithdrawMZ = to18(60n);
        await mzusd.connect(alice).requestWithdrawal(firstWithdrawMZ);

        // After this withdrawal, cap usage should be 60 USDC
        const [remainingCapAfterFirst] = await mzusd.getRemainingGlobalHourlyCap();
        expect(capUSDC - remainingCapAfterFirst).to.equal(to6(60n));

        // Now preview withdrawing 100 USDC + small dust
        const previewAmountMZ = to18(100n) + 123n; // 100 USDC equivalent + 123 dust

        const [
            requestedMZ,
            userBalanceMZ,
            hasEnoughMZ,
            usdcOut,
            unconvertedMZ,
            vaultLiquidityUSDC,
            hasSufficientLiquidity,
            globalCapUSDC,
            windowStart,
            windowEnd,
            windowUsedUSDC_,
            windowRemainingUSDC,
            isGlobalCapZero,
            wouldExceedGlobalCap,
        ] = await mzusd.connect(alice).previewWithdrawalFlat(previewAmountMZ);

        const aliceMZCurrent = await mzusd.balanceOf(alice.address);
        const vaultUSDCBalance = await usdc.balanceOf(vault.target);
        const redemptionDuration = await mzusd.redemptionWindowDuration();

        // Basic fields (requestedMZ is the burnable amount, dust trimmed)
        expect(requestedMZ).to.equal(to18(100n));
        expect(userBalanceMZ).to.equal(aliceMZCurrent);
        expect(hasEnoughMZ).to.equal(true);

        // Conversion and dust
        expect(usdcOut).to.equal(to6(100n));
        expect(unconvertedMZ).to.equal(123n);

        // Vault liquidity and liquidity flag
        expect(vaultLiquidityUSDC).to.equal(vaultUSDCBalance);
        expect(hasSufficientLiquidity).to.equal(true);

        // Global cap fields
        expect(globalCapUSDC).to.equal(capUSDC);
        expect(isGlobalCapZero).to.equal(false);

        // Cap usage and remaining window
        const expectedUsedUSDC = to6(60n);
        const expectedRemainingUSDC = capUSDC - expectedUsedUSDC;
        expect(windowRemainingUSDC).to.equal(expectedRemainingUSDC);
        expect(windowUsedUSDC_).to.equal(expectedUsedUSDC);

        // Window start/end relationship
        expect(windowEnd).to.equal(windowStart + redemptionDuration);

        // Since 100 USDC > remaining 90 USDC, this preview should report exceeding the cap
        expect(wouldExceedGlobalCap).to.equal(true);

        // Now switch to the max allowed cap and check the view adapts
        await mzusd.setGlobalHourlyRedemptionCap(usdcTotalSupply);

        const [
            ,
            ,
            ,
            usdcOut2,
            unconvertedMZ2,
            vaultLiquidityUSDC2,
            hasSufficientLiquidity2,
            globalCapUSDC2,
            windowStart2,
            windowEnd2,
            windowUsedUSDC2,
            windowRemainingUSDC2,
            isGlobalCapZero2,
            wouldExceedGlobalCap2,
        ] = await mzusd.connect(alice).previewWithdrawalFlat(previewAmountMZ);

        // Core conversion stays the same
        expect(usdcOut2).to.equal(usdcOut);
        expect(unconvertedMZ2).to.equal(unconvertedMZ);
        expect(vaultLiquidityUSDC2).to.equal(vaultLiquidityUSDC);
        expect(hasSufficientLiquidity2).to.equal(true);

        // Cap is now at the maximum allowed
        expect(globalCapUSDC2).to.equal(usdcTotalSupply);
        expect(isGlobalCapZero2).to.equal(false);

        // Remaining cap is total supply minus whatever has already been used in the current window
        expect(windowRemainingUSDC2).to.equal(usdcTotalSupply - expectedUsedUSDC);
        expect(windowUsedUSDC2).to.equal(expectedUsedUSDC);

        // Window timing relationship still holds
        expect(windowEnd2).to.equal(windowStart2 + redemptionDuration);

        // With max cap, preview should never flag exceeding the cap
        expect(wouldExceedGlobalCap2).to.equal(false);
    });

    it("Should allow deposits and withdrawals when hourly cap is effectively unlimited", async () => {
        // Effectively disable cap by setting it to total supply (no practical limit)
        await mzusd.setGlobalHourlyRedemptionCap(usdcTotalSupply);

        const depositAmountUSDC = to6(300n); // 300 USDC

        // Fund Alice and deposit into MZUSD
        await fundAndDepositForAlice(depositAmountUSDC);

        const aliceMZ = await mzusd.balanceOf(alice.address);
        expect(aliceMZ).to.equal(to18(300n));

        // Getter should report max remaining cap when cap is effectively disabled
        const [remainingBefore] = await mzusd.getRemainingGlobalHourlyCap();
        expect(remainingBefore).to.equal(usdcTotalSupply);

        const firstWithdrawMZ = to18(200n); // 200 USDC
        const secondWithdrawMZ = to18(100n); // 100 USDC

        await mzusd.connect(alice).requestWithdrawal(firstWithdrawMZ);
        await mzusd.connect(alice).requestWithdrawal(secondWithdrawMZ);

        const aliceMZAfter = await mzusd.balanceOf(alice.address);
        const aliceUSDCAfter = await usdc.balanceOf(alice.address);

        expect(aliceMZAfter).to.equal(0n);
        expect(aliceUSDCAfter).to.equal(depositAmountUSDC);

        const [remainingAfter] = await mzusd.getRemainingGlobalHourlyCap();
        expect(remainingAfter).to.equal(usdcTotalSupply - depositAmountUSDC);
    });

    it("Should validate redemption window duration updates and reject zero", async () => {
        // Zero duration is not allowed
        await expect(mzusd.setRedemptionWindowDuration(0)).to.be.revertedWithCustomError(
            mzusd,
            "ZeroDuration"
        );

        // Update to 2 hours and check storage + event
        const newDuration = 2 * 60 * 60; // 2 hours

        await expect(mzusd.setRedemptionWindowDuration(newDuration))
            .to.emit(mzusd, "RedemptionWindowDurationUpdated")
            .withArgs(newDuration);

        const storedDuration = await mzusd.redemptionWindowDuration();
        expect(storedDuration).to.equal(newDuration);
    });

    it("Should reset window usage when shortening redemption duration past current window", async () => {
        // Set a finite cap to observe remaining/used values
        const capUSDC = to6(200n);
        await mzusd.setGlobalHourlyRedemptionCap(capUSDC);

        // Alice deposits 200 USDC -> 200 MZUSD
        const depositAmountUSDC = to6(200n);
        await fundAndDepositForAlice(depositAmountUSDC);

        // Alice withdraws 80 USDC -> consumes part of the cap
        const withdrawMZ = to18(80n);
        await mzusd.connect(alice).requestWithdrawal(withdrawMZ);

        // Capture window state after withdrawal
        const [remainingBefore] = await mzusd.getRemainingGlobalHourlyCap();
        const usedBefore = capUSDC - remainingBefore;
        const windowStartBefore = await mzusd.windowStartTimestamp();
        const durationBefore = await mzusd.redemptionWindowDuration();

        expect(usedBefore).to.equal(to6(80n));
        expect(durationBefore).to.equal(60 * 60); // initial 1h window

        // Increase window duration to 2h - this should NOT reset window
        const longerDuration = 2 * 60 * 60;
        await mzusd.setRedemptionWindowDuration(longerDuration);

        const windowStartLong = await mzusd.windowStartTimestamp();
        const usedLong = await mzusd.windowUsedUSDC();
        const storedDurationLong = await mzusd.redemptionWindowDuration();

        expect(storedDurationLong).to.equal(longerDuration);
        expect(windowStartLong).to.equal(windowStartBefore);
        expect(usedLong).to.equal(usedBefore);

        // Move time forward so that the current window is older than the shorter duration
        await time.increase(2000); // > 10 minutes (600s) which we will set next

        // Shorten duration to 10 minutes; since the window is already older than that,
        // the setter should reset window start and usage.
        const shorterDuration = 10 * 60; // 10 minutes
        await mzusd.setRedemptionWindowDuration(shorterDuration);

        const storedDurationShort = await mzusd.redemptionWindowDuration();
        const windowStartAfter = await mzusd.windowStartTimestamp();
        const usedAfter = await mzusd.windowUsedUSDC();
        const [remainingAfter] = await mzusd.getRemainingGlobalHourlyCap();

        expect(storedDurationShort).to.equal(shorterDuration);

        const latestTs = await time.latest();
        expect(windowStartAfter).to.equal(BigInt(latestTs));

        expect(usedAfter).to.equal(0n);
        expect(remainingAfter).to.equal(capUSDC);
    });

    it("Should keep previewWithdrawalFlat aligned with cap getter and window duration", async () => {
        // 1) Set a finite cap and consume part of it
        const capUSDC = to6(200n);
        await mzusd.setGlobalHourlyRedemptionCap(capUSDC);

        // Alice deposits 200 USDC -> 200 MZUSD
        const depositAmountUSDC = to6(200n);
        await fundAndDepositForAlice(depositAmountUSDC);

        // Alice withdraws 80 USDC -> consumes part of the cap
        const withdrawMZ = to18(80n);
        await mzusd.connect(alice).requestWithdrawal(withdrawMZ);

        // Check state via small getter
        const [remainingBefore, windowStartBefore] = await mzusd.getRemainingGlobalHourlyCap();
        const usedBefore = capUSDC - remainingBefore;
        const durationBefore = await mzusd.redemptionWindowDuration();

        expect(usedBefore).to.equal(to6(80n));
        expect(durationBefore).to.equal(60 * 60); // default 1h window

        // 2) Big getter: preview for 150 USDC (more than remaining = 120)
        const previewAmountMZ = to18(150n);

        const [
            ,
            ,
            ,
            usdcOut1,
            ,
            ,
            ,
            globalCapUSDC1,
            windowStartPrev1,
            windowEndPrev1,
            windowUsedUSDC1,
            windowRemainingUSDC1,
            isGlobalCapZero1,
            wouldExceedGlobalCap1,
        ] = await mzusd.connect(alice).previewWithdrawalFlat(previewAmountMZ);

        // Conversion
        expect(usdcOut1).to.equal(to6(150n));

        // Cup and zero flag
        expect(globalCapUSDC1).to.equal(capUSDC);
        expect(isGlobalCapZero1).to.equal(false);

        expect(windowRemainingUSDC1).to.equal(remainingBefore);
        expect(windowUsedUSDC1).to.equal(usedBefore);
        expect(windowStartPrev1).to.equal(windowStartBefore);
        expect(windowEndPrev1).to.equal(windowStartPrev1 + durationBefore);

        // 150 > 200 - 80 = 120 -> true
        expect(wouldExceedGlobalCap1).to.equal(true);

        // 3) Make the window old and shortening the duration
        await time.increase(2000); // > 10 minutes
        const shorterDuration = 10 * 60; // 10 min

        await mzusd.setRedemptionWindowDuration(shorterDuration);

        const storedDurationShort = await mzusd.redemptionWindowDuration();
        expect(storedDurationShort).to.equal(shorterDuration);

        // Small getter should see a NEW window with full cap
        const [remainingAfter, windowStartAfter] = await mzusd.getRemainingGlobalHourlyCap();
        expect(remainingAfter).to.equal(capUSDC);

        // 4) Big getter again with the same amount
        const [
            ,
            ,
            ,
            usdcOut2,
            ,
            ,
            ,
            globalCapUSDC2,
            windowStartPrev2,
            windowEndPrev2,
            windowUsedUSDC2,
            windowRemainingUSDC2,
            isGlobalCapZero2,
            wouldExceedGlobalCap2,
        ] = await mzusd.connect(alice).previewWithdrawalFlat(previewAmountMZ);

        // Conversion stays the same
        expect(usdcOut2).to.equal(usdcOut1);
        expect(globalCapUSDC2).to.equal(capUSDC);
        expect(isGlobalCapZero2).to.equal(false);

        // Now preview should report full remaining and zero used
        // remaining = full cap, used = 0 (view-level)
        expect(windowRemainingUSDC2).to.equal(capUSDC);
        expect(windowUsedUSDC2).to.equal(0n);

        // start/end in big getter must match small getter with new duration
        expect(windowStartPrev2).to.equal(windowStartAfter);
        expect(windowEndPrev2).to.equal(windowStartPrev2 + storedDurationShort);

        // With full cap, 150 no longer exceeds the limit
        expect(wouldExceedGlobalCap2).to.equal(false);
    });

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
            .withArgs(alice.address, to18(10n), to6(10n));

        const aliceMZAfter = await mzusd.balanceOf(alice.address);
        const aliceUSDCAfter = await usdc.balanceOf(alice.address);

        expect(aliceMZAfter).to.equal(0n);
        expect(aliceUSDCAfter).to.equal(depositAmountUSDC);
    });

    it("Should reject zero cap in setter", async () => {
        await expect(mzusd.setGlobalHourlyRedemptionCap(0)).to.be.revertedWithCustomError(
            mzusd,
            "ZeroCap"
        );
    });

    it("Should revert rescueETH for zero receiver", async () => {
        await expect(
            mzusd.connect(deployer).rescueETH("0x0000000000000000000000000000000000000000", 1n)
        ).to.be.revertedWithCustomError(mzusd, "ZeroAddress");
    });
});
