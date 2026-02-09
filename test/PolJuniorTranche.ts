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
    let lossManagerRef: any;
    let navOracleRef: any;
    let navOracleSigner: any;

    before(async () => {
        const signers = await ethers.getSigners();
        [deployer, alice, bob] = signers;

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

        const VaultFactory = await ethers.getContractFactory("Vault", deployer);
        vault = (await upgrades.deployProxy(VaultFactory, [0, bob.address, 0, alice.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [mzusdAddr, reservoir.target],
        })) as unknown as Vault;
        vaultAddr = await vault.getAddress();

        // Deploy POL tranche
        const PolFactory = await ethers.getContractFactory("PolJuniorTranche", deployer);
        pol = (await upgrades.deployProxy(PolFactory, [bob.address], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [vault.target],
        })) as unknown as PolJuniorTranche;
        polAddr = await pol.getAddress();

        const MockLossManagerFactory = await ethers.getContractFactory(
            "MockLossManagerRef",
            deployer
        );
        lossManagerRef = await MockLossManagerFactory.deploy(vaultAddr, mzusdAddr);
        await lossManagerRef.waitForDeployment();
        const MockNavOracleFactory = await ethers.getContractFactory(
            "MockNavOracleAutomationRef",
            deployer
        );
        navOracleRef = await MockNavOracleFactory.deploy(
            vaultAddr,
            lossManagerRef.target,
            mzusdAddr
        );
        await navOracleRef.waitForDeployment();
        navOracleSigner = await imp(navOracleRef.target as string);

        // Roles setup
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
        await grantPausePermissions(accessManager, pauseManager, ADMIN_ROLE);

        // POL tranche: withdraw should be ADMIN only
        const polWithdrawSel = pol.interface.getFunction("withdraw").selector;
        await accessManager.setTargetFunctionRole(polAddr, [polWithdrawSel], ADMIN_ROLE);

        // POL tranche: admin-only management endpoints
        const polSetPayoutSel = pol.interface.getFunction("setPolPayout").selector;
        await accessManager.setTargetFunctionRole(polAddr, [polSetPayoutSel], ADMIN_ROLE);

        // admin: vault distribute + tranche management + epoch config
        const setVaultSel = mzusd.interface.getFunction("setVault").selector;
        const distributeSel = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSel = vault.interface.getFunction("addTranche").selector;
        const updateTrancheSel = vault.interface.getFunction("updateTranche").selector;
        const setEpochConfigSel = vault.interface.getFunction("setEpochConfig").selector;
        const setLossManagerSel = vault.interface.getFunction("setLossManager").selector;
        const setNavOracleSel = vault.interface.getFunction("setNavOracle").selector;
        await accessManager.setTargetFunctionRole(
            vaultAddr,
            [
                distributeSel,
                addTrancheSel,
                updateTrancheSel,
                setEpochConfigSel,
                setLossManagerSel,
                setNavOracleSel,
            ],
            ADMIN_ROLE
        );
        await accessManager.setTargetFunctionRole(mzusdAddr, [setVaultSel], ADMIN_ROLE);

        // wire
        await mzusd.setVault(vaultAddr);
        await vault.setLossManager(lossManagerRef.target);
        await vault.setNavOracle(navOracleRef.target);

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

    async function depositMZInto(user: any, mzAmount18: bigint): Promise<void> {
        await (await mzusd.connect(user).transfer(polAddr, mzAmount18)).wait();
    }

    describe("Pause guards", () => {
        it("Pauses all guarded PolJuniorTranche functions", async () => {
            const vaultSigner = await imp(vaultAddr);

            await pauseManager.pauseGlobal(PauseCategory.WITHDRAWALS);
            await expect(pol.connect(deployer).withdraw(1n, deployer.address))
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

            const adminPrincipal = await mintMZUSDFor(deployer, to6(101n));
            await depositMZInto(deployer, adminPrincipal);

            const withdrawAmt = to18(40n);
            // Withdraw is restricted to admin: Alice cannot withdraw
            await expect(pol.connect(alice).withdraw(withdrawAmt, alice.address)).to.be.reverted;

            // Admin can withdraw
            const adminBalBefore = await mzusd.balanceOf(deployer.address);
            await (await pol.connect(deployer).withdraw(withdrawAmt, deployer.address)).wait();
            const adminBalAfter = await mzusd.balanceOf(deployer.address);
            expect(adminBalAfter - adminBalBefore).to.equal(withdrawAmt);

            // Distribute yield -> should be forwarded to bob (payout)
            const payoutBefore = await mzusd.balanceOf(bob.address);

            await time.increase(DAY);
            const reported = to6(20n); // 20 USDC -> 20e18 MZUSD
            await (await vault.connect(navOracleSigner).distributeYield(reported)).wait();

            const payoutAfter = await mzusd.balanceOf(bob.address);
            expect(payoutAfter - payoutBefore).to.equal(to18(20n));

            // POL tranche should not retain yield, only remaining principal stays
            const expectedPrincipalLeft = adminPrincipal - withdrawAmt;
            expect(await mzusd.balanceOf(polAddr)).to.equal(expectedPrincipalLeft);
            expect(await pol.totalAssets()).to.equal(expectedPrincipalLeft);
        });
    });

    describe("Admin flows", () => {
        it("Deposits, withdraws, and updates payout", async () => {
            const mintUSDC = to6(25n);
            const minted = await mintMZUSDFor(deployer, mintUSDC);

            await depositMZInto(deployer, minted);

            const withdrawAmt = to18(10n);
            const before = await mzusd.balanceOf(bob.address);
            await (await pol.connect(deployer).withdraw(withdrawAmt, bob.address)).wait();
            const after = await mzusd.balanceOf(bob.address);
            expect(after - before).to.equal(withdrawAmt);

            await expect(pol.connect(deployer).setPolPayout(alice.address))
                .to.emit(pol, "PolPayoutUpdated")
                .withArgs(alice.address);
        });

        it("Rejects non-admin withdraw", async () => {
            const minted = await mintMZUSDFor(alice, to6(10n));
            await (await mzusd.connect(alice).transfer(polAddr, minted)).wait();
            await expect(pol.connect(alice).withdraw(to18(1n), alice.address)).to.be.reverted;
        });
    });
});
