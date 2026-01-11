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

import {Vault, ReservoirUSDC, MZUSD, IERC20, PolJuniorTranche} from "../typechain-types";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0xffA69C0080582098aF595156240214b742735a5e";

const VAULT_ROLE = 2n;
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

    let accessManager: any;
    let usdc: IERC20;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;

    let pol: PolJuniorTranche;

    let vaultAddr: string;
    let mzusdAddr: string;
    let polAddr: string;

    before(async () => {
        [deployer, alice, bob] = await ethers.getSigners();

        usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
        upgrades.silenceWarnings();
        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

        const AccessManagerFactory = await ethers.getContractFactory("AccessManager", deployer);
        accessManager = await AccessManagerFactory.deploy(deployer.address);
        await accessManager.waitForDeployment();

        const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
        mzusd = (await upgrades.deployProxy(MZUSDFactory, [accessManager.target, 0], {
            kind: "uups",
            initializer: "initialize",
            unsafeAllow: ["constructor", "state-variable-immutable"],
            constructorArgs: [MAINNET_USDC],
        })) as unknown as MZUSD;
        mzusdAddr = await mzusd.getAddress();

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
        vaultAddr = await vault.getAddress();

        // Deploy POL tranche
        const PolFactory = await ethers.getContractFactory("PolJuniorTranche", deployer);
        pol = (await upgrades.deployProxy(
            PolFactory,
            [mzusd.target, "POL Junior Tranche", "pJLT", accessManager.target, bob.address],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as PolJuniorTranche;
        polAddr = await pol.getAddress();

        // Roles setup
        const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();

        // POL tranche: deposit/mint should be callable by everyone (PUBLIC_ROLE)
        const polDepositSel = pol.interface.getFunction("deposit").selector;
        await accessManager.setTargetFunctionRole(polAddr, [polDepositSel], PUBLIC_ROLE);

        // POL tranche: withdraw/redeem should be ADMIN only
        const polWithdrawSel = pol.interface.getFunction("withdraw").selector;
        const polRedeemSel = pol.interface.getFunction("redeem").selector;
        await accessManager.setTargetFunctionRole(
            polAddr,
            [polWithdrawSel, polRedeemSel],
            ADMIN_ROLE
        );

        // public: MZUSD deposit/requestWithdrawal
        const depSel = mzusd.interface.getFunction("deposit").selector;
        const reqSel = mzusd.interface.getFunction("requestWithdrawal").selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [depSel, reqSel], PUBLIC_ROLE);

        // admin: MZUSD.setVault
        const setVaultSel = mzusd.interface.getFunction("setVault").selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [setVaultSel], ADMIN_ROLE);

        // admin: vault distribute + tranche management + epoch config
        const distributeSel = vault.interface.getFunction("distributeYield").selector;
        const addTrancheSel = vault.interface.getFunction("addTranche").selector;
        const updateTrancheSel = vault.interface.getFunction("updateTranche").selector;
        const setEpochConfigSel = vault.interface.getFunction("setEpochConfig").selector;
        await accessManager.setTargetFunctionRole(
            vaultAddr,
            [distributeSel, addTrancheSel, updateTrancheSel, setEpochConfigSel],
            ADMIN_ROLE
        );

        // vault role: MZUSD.mint
        const mintSel = mzusd.interface.getFunction("mint").selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [mintSel], VAULT_ROLE);
        await accessManager.grantRole(VAULT_ROLE, vaultAddr, 0);

        // vault role: pol.notifyYield
        const notifySel = pol.interface.getFunction("notifyYield").selector;
        await accessManager.setTargetFunctionRole(polAddr, [notifySel], VAULT_ROLE);

        // wire
        await mzusd.setVault(vaultAddr);

        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
        const whale = await imp(USDC_WHALE);
        await usdc.connect(whale).transfer(user.address, usdcAmount6);
        await usdc.connect(user).approve(mzusdAddr, usdcAmount6);
        await (await mzusd.connect(user).deposit(usdcAmount6)).wait();
        return await mzusd.balanceOf(user.address);
    }

    async function depositMZInto(user: any, tranche: any, mzAmount18: bigint) {
        const addr = await tranche.getAddress();
        await mzusd.connect(user).approve(addr, mzAmount18);
        await (await tranche.connect(user).deposit(mzAmount18, user.address)).wait();
    }

    it("Forwards yield to payout (no streaming) and withdraw is instant", async () => {
        // Register only POL tranche to make allocation deterministic (100% to POL)
        await vault.addTranche({tranche: polAddr, weightBps: 10_000, enabled: true});

        // Deposit principal by Alice (PUBLIC deposit should work)
        const alicePrincipal = await mintMZUSDFor(alice, to6(1n));
        await depositMZInto(alice, pol, alicePrincipal);

        // Deposit principal by Admin (so that admin can later withdraw without allowance issues)
        const adminPrincipal = await mintMZUSDFor(deployer, to6(100n));
        await depositMZInto(deployer, pol, adminPrincipal);

        const withdrawAmt = to18(40n);
        // Withdraw is restricted to admin: Alice cannot withdraw
        await expect(pol.connect(alice).withdraw(withdrawAmt, alice.address, alice.address)).to.be
            .reverted;

        // Admin can withdraw its own position
        const adminBalBefore = await mzusd.balanceOf(deployer.address);
        await (
            await pol.connect(deployer).withdraw(withdrawAmt, deployer.address, deployer.address)
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
