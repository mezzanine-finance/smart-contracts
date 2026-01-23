import {expect} from "chai";
import {ethers, upgrades, network} from "hardhat";
import {parseUnits, toBigInt} from "ethers";
import {
    impersonateAccount,
    setBalance,
    takeSnapshot,
    time,
} from "@nomicfoundation/hardhat-network-helpers";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

import {
    Vault,
    ReservoirUSDC,
    MZUSD,
    IERC20,
    PolJuniorTranche,
    PauseManager,
} from "../typechain-types";
import {PauseCategory, grantPausePermissions} from "./helpers/pause";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

const LOSS_MANAGER_ROLE = 3n;

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

async function imp(addr: string) {
    await setBalance(addr, to18(10)); // ETH for gas
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe("PolJuniorTranche", () => {
    const DAY = 24 * 60 * 60;

    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let users: any[];

    let whale: any;

    let accessManager: any;
    let pauseManager: PauseManager;
    let usdc: IERC20;
    let usdcTotalSupply: bigint;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;

    let pol: PolJuniorTranche;

    let vaultAddr: string;
    let mzusdAddr: string;
    let polAddr: string;

    before(async () => {
        const signers = await ethers.getSigners();
        [deployer, alice, bob, ...users] = signers;
        // extra accounts for stress tests (keep it bounded for runtime)
        users = users.slice(0, 12);

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
        usdcTotalSupply = await usdc.totalSupply();
        // Impersonate once (faster than re-impersonating per mint)
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

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(
            VaultFactory,
            [accessManager.target, pauseManager.target, 0, bob.address, 0, alice.address],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC, reservoir.target],
            }
        )) as unknown as Vault;
        vaultAddr = await vault.getAddress();

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(
            MZUSDFactory,
            [accessManager.target, pauseManager.target, usdcTotalSupply],
            {
                kind: "uups",
                initializer: "initialize",
                unsafeAllow: ["constructor", "state-variable-immutable"],
                constructorArgs: [MAINNET_USDC, vault.target],
            }
        )) as unknown as MZUSD;
        mzusdAddr = await mzusd.getAddress();

        // Deploy POL tranche
        const PolFactory = await ethers.getContractFactory("PolJuniorTranche", deployer);
        pol = (await upgrades.deployProxy(
            PolFactory,
            [
                mzusd.target,
                vault.target,
                "POL Junior Tranche",
                "pJLT",
                accessManager.target,
                pauseManager.target,
                bob.address,
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as PolJuniorTranche;
        polAddr = await pol.getAddress();

        // Roles setup
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // POL tranche: withdraw/redeem should be ADMIN only
        const polWithdrawSel = pol.interface.getFunction("withdraw").selector;
        const polRedeemSel = pol.interface.getFunction("redeem").selector;
        await accessManager.setTargetFunctionRole(
            polAddr,
            [polWithdrawSel, polRedeemSel],
            ADMIN_ROLE
        );

        // POL tranche: admin-only management endpoints
        const polSetPayoutSel = pol.interface.getFunction("setPolPayout").selector;
        await accessManager.setTargetFunctionRole(polAddr, [polSetPayoutSel], ADMIN_ROLE);

        // admin: vault distribute + tranche management + epoch config
        const setMZUSDSel = vault.interface.getFunction("setMZUSD").selector;
        const distributeSel = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSel = vault.interface.getFunction("addTranche").selector;
        const updateTrancheSel = vault.interface.getFunction("updateTranche").selector;
        const setEpochConfigSel = vault.interface.getFunction("setEpochConfig").selector;
        const setLossManagerSel = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSel = vault.interface.getFunction("setNavOracle").selector;
        await accessManager.setTargetFunctionRole(
            vaultAddr,
            [
                setMZUSDSel,
                distributeSel,
                addTrancheSel,
                updateTrancheSel,
                setEpochConfigSel,
                setLossManagerSel,
                setNavOracleSel,
            ],
            ADMIN_ROLE
        );

        // wire
        await vault.setMZUSD(mzusdAddr);
        await vault.setLossManager(deployer.address);
        await vault.setNavOracle(deployer.address);

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        // whale is impersonated once in before for speed
        if ((whale ??= null)) {
            whale = await imp(USDC_WHALE);
        }
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusdAddr, usdcAmount6);
        await (await mzusd.connect(user).deposit(usdcAmount6)).wait();
        return await mzusd.balanceOf(user.address);
    }

    async function depositMZInto(user: any, tranche: any, mzAmount18: bigint): Promise<bigint> {
        const addr = await tranche.getAddress();
        const sharesBefore = await tranche.balanceOf(user.address);
        await mzusd.connect(user).approve(addr, mzAmount18);
        await (await tranche.connect(user).deposit(mzAmount18, user.address)).wait();
        const sharesAfter = await tranche.balanceOf(user.address);
        return toBigInt(sharesAfter - sharesBefore);
    }

    async function assertPolInvariants(holders: any[]) {
        const assets = await pol.totalAssets();
        expect(await mzusd.balanceOf(polAddr)).to.equal(assets);

        const supply = await pol.totalSupply();
        expect(await pol.convertToAssets(supply)).to.equal(assets);

        let sumShares = 0n;
        for (const h of holders) {
            sumShares += await pol.balanceOf(h.address);
        }
        expect(sumShares).to.equal(supply);
    }

    describe("Pause guards", () => {
        it("Pauses all guarded PolJuniorTranche functions", async () => {
            const vaultSigner = await imp(vaultAddr);

            await pauseManager.pauseGlobal(PauseCategory.DEPOSITS);
            await expect(pol.connect(alice).deposit(1n, alice.address))
                .to.be.revertedWithCustomError(pol, "CategoryPaused")
                .withArgs(PauseCategory.DEPOSITS);
            await expect(pol.connect(alice).mint(1n, alice.address))
                .to.be.revertedWithCustomError(pol, "CategoryPaused")
                .withArgs(PauseCategory.DEPOSITS);
            await pauseManager.unpauseGlobal(PauseCategory.DEPOSITS);

            await pauseManager.pauseGlobal(PauseCategory.TRANSFERS);
            await expect(pol.connect(alice).transfer(bob.address, 1n))
                .to.be.revertedWithCustomError(pol, "CategoryPaused")
                .withArgs(PauseCategory.TRANSFERS);
            await expect(pol.connect(alice).approve(bob.address, 1n))
                .to.be.revertedWithCustomError(pol, "CategoryPaused")
                .withArgs(PauseCategory.TRANSFERS);
            await expect(pol.connect(alice).transferFrom(alice.address, bob.address, 1n))
                .to.be.revertedWithCustomError(pol, "CategoryPaused")
                .withArgs(PauseCategory.TRANSFERS);
            await pauseManager.unpauseGlobal(PauseCategory.TRANSFERS);

            await pauseManager.pauseGlobal(PauseCategory.WITHDRAWALS);
            await expect(pol.connect(deployer).withdraw(1n, deployer.address, deployer.address))
                .to.be.revertedWithCustomError(pol, "CategoryPaused")
                .withArgs(PauseCategory.WITHDRAWALS);
            await expect(pol.connect(deployer).redeem(1n, deployer.address, deployer.address))
                .to.be.revertedWithCustomError(pol, "CategoryPaused")
                .withArgs(PauseCategory.WITHDRAWALS);
            await pauseManager.unpauseGlobal(PauseCategory.WITHDRAWALS);

            await pauseManager.pauseGlobal(PauseCategory.PROTOCOL);
            await expect(pol.connect(vaultSigner).notifyYield(1n))
                .to.be.revertedWithCustomError(pol, "CategoryPaused")
                .withArgs(PauseCategory.PROTOCOL);
            await pauseManager.unpauseGlobal(PauseCategory.PROTOCOL);

            await pauseManager.pauseGlobal(PauseCategory.ADMIN);
            await expect(pol.connect(deployer).setPolPayout(alice.address))
                .to.be.revertedWithCustomError(pol, "CategoryPaused")
                .withArgs(PauseCategory.ADMIN);
        });
    });

    describe("Yield forwarding", () => {
        it("Forwards yield to payout (no streaming) and withdraw is instant", async () => {
            // Register only POL tranche to make allocation deterministic (100% to POL)
            await vault.addTranche({tranche: polAddr, weight: 10_000, enabled: true});

            // Deposit principal by Alice (PUBLIC deposit should work)
            const alicePrincipal = await mintMZUSDFor(alice, to6(1n));
            await depositMZInto(alice, pol, alicePrincipal);

            // Deposit principal by Admin (so that admin can later withdraw without allowance issues)
            const adminPrincipal = await mintMZUSDFor(deployer, to6(100n));
            await depositMZInto(deployer, pol, adminPrincipal);

            const withdrawAmt = to18(40n);
            // Withdraw is restricted to admin: Alice cannot withdraw
            await expect(pol.connect(alice).withdraw(withdrawAmt, alice.address, alice.address)).to
                .be.reverted;

            // Admin can withdraw its own position
            const adminBalBefore = await mzusd.balanceOf(deployer.address);
            await (
                await pol
                    .connect(deployer)
                    .withdraw(withdrawAmt, deployer.address, deployer.address)
            ).wait();
            const adminBalAfter = await mzusd.balanceOf(deployer.address);
            expect(adminBalAfter - adminBalBefore).to.equal(withdrawAmt);

            // Distribute yield -> should be forwarded to bob (payout)
            const payoutBefore = await mzusd.balanceOf(bob.address);

            await time.increase(DAY);
            const reported = to6(20n); // 20 USDC -> 20e18 MZUSD
            await (await vault.connect(deployer).distributeYield(reported)).wait();

            const payoutAfter = await mzusd.balanceOf(bob.address);
            expect(payoutAfter - payoutBefore).to.equal(to18(20n));

            // POL tranche should not retain yield, only remaining principal stays
            const totalPrincipal = alicePrincipal + adminPrincipal;
            const expectedPrincipalLeft = totalPrincipal - withdrawAmt;
            expect(await mzusd.balanceOf(polAddr)).to.equal(expectedPrincipalLeft);
            expect(await pol.totalAssets()).to.equal(expectedPrincipalLeft);
        });
    });

    describe("ERC20 and admin flows", () => {
        it("Mints, transfers, redeems, and updates payout", async () => {
            const mintUSDC = to6(25n);
            const minted = await mintMZUSDFor(alice, mintUSDC);

            const shares = to18(10n);
            const assetsRequired = await pol.previewMint(shares);
            expect(assetsRequired).to.be.lte(minted);

            await mzusd.connect(alice).approve(polAddr, assetsRequired);
            await (await pol.connect(alice).mint(shares, alice.address)).wait();

            await (await pol.connect(alice).transfer(bob.address, shares / 2n)).wait();

            await (await pol.connect(alice).approve(deployer.address, shares / 2n)).wait();
            await (
                await pol.connect(deployer).transferFrom(alice.address, bob.address, shares / 2n)
            ).wait();

            const bobShares = await pol.balanceOf(bob.address);
            await (await pol.connect(bob).approve(deployer.address, bobShares)).wait();

            const bobBefore = await mzusd.balanceOf(bob.address);
            await (await pol.connect(deployer).redeem(bobShares, bob.address, bob.address)).wait();
            const bobAfter = await mzusd.balanceOf(bob.address);

            expect(bobAfter - bobBefore).to.equal(bobShares);

            await expect(pol.connect(deployer).setPolPayout(alice.address))
                .to.emit(pol, "PolPayoutUpdated")
                .withArgs(alice.address);
        });
    });

    describe("Multi-user flows", () => {
        it("Many users deposit, admin withdraws across owners", async () => {
            await vault.addTranche({tranche: polAddr, weight: 10_000, enabled: true});

            const participants = [alice, ...users.slice(0, 8)];

            // Deposit varying sizes
            let totalDeposited = 0n;
            for (let i = 0; i < participants.length; i++) {
                const u = participants[i];
                const usdcAmt = to6(BigInt((i + 1) * 5)); // 5,10,15,... USDC
                const mzAmt = await mintMZUSDFor(u, usdcAmt);
                totalDeposited += mzAmt;

                const shares = await depositMZInto(u, pol, mzAmt);
                expect(shares).to.equal(mzAmt);

                // Let admin operate on behalf of the owner (ERC4626 allowance path)
                await (await pol.connect(u).approve(deployer.address, shares)).wait();
            }

            expect(await pol.totalAssets()).to.equal(totalDeposited);
            await assertPolInvariants(participants);

            // Admin withdraws half from each owner to the owner as receiver
            let totalWithdrawn = 0n;
            for (const u of participants) {
                const sharesBal = await pol.balanceOf(u.address);
                const assetsToWithdraw = sharesBal / 2n;
                if (assetsToWithdraw === 0n) continue;

                const mzBefore = await mzusd.balanceOf(u.address);
                await (
                    await pol.connect(deployer).withdraw(assetsToWithdraw, u.address, u.address)
                ).wait();
                const mzAfter = await mzusd.balanceOf(u.address);
                expect(mzAfter - mzBefore).to.equal(assetsToWithdraw);

                totalWithdrawn += assetsToWithdraw;
            }

            const expectedLeft = totalDeposited - totalWithdrawn;
            expect(await pol.totalAssets()).to.equal(expectedLeft);
            await assertPolInvariants(participants);

            // Distribute yield multiple times: payout increases, tranche accounting stays on principal only
            const payoutBefore = await mzusd.balanceOf(bob.address);
            await time.increase(DAY);
            await (await vault.connect(deployer).distributeYield(to6(7n))).wait();

            // Vault enforces one distribution per epoch window.
            await time.increase(DAY);
            await (await vault.connect(deployer).distributeYield(to6(13n))).wait();
            const payoutAfter = await mzusd.balanceOf(bob.address);
            expect(payoutAfter - payoutBefore).to.equal(to18(20n));

            // Tranche retains only principal
            expect(await pol.totalAssets()).to.equal(expectedLeft);
            expect(await mzusd.balanceOf(polAddr)).to.equal(expectedLeft);
        });

        it("Repeated deposit/withdraw roundtrips", async () => {
            await vault.addTranche({tranche: polAddr, weight: 10_000, enabled: true});

            await mintMZUSDFor(alice, to6(200n));
            const startBal = await mzusd.balanceOf(alice.address);

            // Allow admin to withdraw on behalf of alice for the whole test.
            await (await pol.connect(alice).approve(deployer.address, ethers.MaxUint256)).wait();

            for (let i = 0; i < 25; i++) {
                const amt = to18(BigInt((i % 5) + 1)); // 1-5 MZUSD

                const aliceBefore = await mzusd.balanceOf(alice.address);
                const shares = await depositMZInto(alice, pol, amt);
                expect(shares).to.equal(amt);

                await (
                    await pol.connect(deployer).withdraw(amt, alice.address, alice.address)
                ).wait();
                const aliceAfter = await mzusd.balanceOf(alice.address);
                expect(aliceAfter).to.equal(aliceBefore);
            }

            expect(await pol.totalAssets()).to.equal(0n);
            expect(await pol.totalSupply()).to.equal(0n);
            expect(await mzusd.balanceOf(polAddr)).to.equal(0n);
            expect(await mzusd.balanceOf(alice.address)).to.equal(startBal);
        });
    });
});
