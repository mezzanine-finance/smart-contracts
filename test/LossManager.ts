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

import {Vault, ReservoirUSDC, MZUSD, IERC20, Tranche, LossManager} from "../typechain-types";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0x38AAEF3782910bdd9eA3566C839788Af6FF9B200";

const VAULT_ROLE = 2n;
const LOSS_MANAGER_ROLE = 3n;

const to6 = (v: string | number | bigint) => parseUnits(v.toString(), 6);
const to18 = (v: string | number | bigint) => parseUnits(v.toString(), 18);

async function imp(addr: string) {
    await setBalance(addr, to18(10)); // ETH for gas
    await impersonateAccount(addr);
    return ethers.getSigner(addr);
}

describe.only("LossManager", () => {
    let snapshot: SnapshotRestorer;

    let deployer: any;
    let alice: any;
    let bob: any;
    let carol: any;

    let accessManager: any;
    let usdc: IERC20;

    let mzusd: MZUSD;
    let reservoir: ReservoirUSDC;
    let vault: Vault;

    let junior: Tranche;
    let mezzanine: Tranche;
    let senior: Tranche;

    let vaultAddr: string;
    let mzusdAddr: string;
    let juniorAddr: string;
    let mezzanineAddr: string;
    let seniorAddr: string;
    let lossManagerAddr: string;

    let lossManager: LossManager;

    const DAY = 24 * 60 * 60;

    before(async () => {
        [deployer, alice, bob, carol] = await ethers.getSigners();

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

        const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);

        junior = (await upgrades.deployProxy(
            TrancheFactory,
            [
                mzusd.target,
                vault.target,
                1,
                0,
                "Junior Tranche",
                "JLT",
                accessManager.target,
                false,
                ethers.ZeroAddress,
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as Tranche;

        mezzanine = (await upgrades.deployProxy(
            TrancheFactory,
            [
                mzusd.target,
                vault.target,
                2,
                0,
                "Mezzanine Tranche",
                "MLT",
                accessManager.target,
                false,
                ethers.ZeroAddress,
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as Tranche;

        senior = (await upgrades.deployProxy(
            TrancheFactory,
            [
                mzusd.target,
                vault.target,
                3,
                0,
                "Senior Tranche",
                "sMZUSD",
                accessManager.target,
                false,
                ethers.ZeroAddress,
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as Tranche;

        juniorAddr = await junior.getAddress();
        mezzanineAddr = await mezzanine.getAddress();
        seniorAddr = await senior.getAddress();

        // Deploy LossManager
        const LossManagerFactory = await ethers.getContractFactory("LossManager", deployer);
        lossManager = (await upgrades.deployProxy(
            LossManagerFactory,
            [
                accessManager.target,
                mzusdAddr,
                [juniorAddr, mezzanineAddr, seniorAddr],
                0, // maxLossPerTxUSDC (0 = no limit)
            ],
            {kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"]}
        )) as unknown as LossManager;
        lossManagerAddr = await lossManager.getAddress();

        // Roles setup
        const PUBLIC_ROLE = await accessManager.PUBLIC_ROLE();
        const ADMIN_ROLE = await accessManager.ADMIN_ROLE();

        // public: MZUSD deposit/requestWithdrawal
        const depSel = mzusd.interface.getFunction("deposit")!.selector;
        const reqSel = mzusd.interface.getFunction("requestWithdrawal")!.selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [depSel, reqSel], PUBLIC_ROLE);

        // admin: MZUSD.setVault
        const setVaultSel = mzusd.interface.getFunction("setVault")!.selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [setVaultSel], ADMIN_ROLE);

        // admin: vault distribute + tranche management + epoch config (for integration test)
        const distributeSel = vault.interface.getFunction("distributeYield")!.selector;
        const addTrancheSel = vault.interface.getFunction("addTranche")!.selector;
        const updateTrancheSel = vault.interface.getFunction("updateTranche")!.selector;
        const setEpochConfigSel = vault.interface.getFunction("setEpochConfig")!.selector;
        await accessManager.setTargetFunctionRole(
            vaultAddr,
            [distributeSel, addTrancheSel, updateTrancheSel, setEpochConfigSel],
            ADMIN_ROLE
        );

        // LossManager admin functions
        const applyLossSel = lossManager.interface.getFunction("applyLoss")!.selector;
        const setOrderSel = lossManager.interface.getFunction("setTrancheOrder")!.selector;
        const setMaxSel = lossManager.interface.getFunction("setMaxLossPerTxUSDC")!.selector;
        await accessManager.setTargetFunctionRole(
            lossManagerAddr,
            [applyLossSel, setOrderSel, setMaxSel],
            ADMIN_ROLE
        );

        // vault role: MZUSD.mint
        const mintSel = mzusd.interface.getFunction("mint")!.selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [mintSel], VAULT_ROLE);
        await accessManager.grantRole(VAULT_ROLE, vaultAddr, 0);

        // loss manager role: MZUSD.burn
        const burnSel = mzusd.interface.getFunction("burn")!.selector;
        await accessManager.setTargetFunctionRole(mzusdAddr, [burnSel], LOSS_MANAGER_ROLE);
        await accessManager.grantRole(LOSS_MANAGER_ROLE, lossManagerAddr, 0);

        // vault role: tranche.notifyYield
        const notifySel = junior.interface.getFunction("notifyYield")!.selector;
        await accessManager.setTargetFunctionRole(juniorAddr, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(mezzanineAddr, [notifySel], VAULT_ROLE);
        await accessManager.setTargetFunctionRole(seniorAddr, [notifySel], VAULT_ROLE);

        // wire and register
        await mzusd.setVault(vaultAddr);

        await vault.addTranche({tranche: juniorAddr, weightBps: 2000, enabled: true});
        await vault.addTranche({tranche: mezzanineAddr, weightBps: 3000, enabled: true});
        await vault.addTranche({tranche: seniorAddr, weightBps: 5000, enabled: true});

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

    async function depositMZIntoTranche(user: any, tranche: Tranche, mzAmount18: bigint) {
        const trancheAddr = await tranche.getAddress();
        await mzusd.connect(user).approve(trancheAddr, mzAmount18);
        await (await tranche.connect(user).deposit(mzAmount18, user.address)).wait();
    }

    function parseLossApplied(receipt: any) {
        const logs = receipt.logs ?? [];
        for (const l of logs) {
            try {
                const parsed = lossManager.interface.parseLog(l);
                if (parsed?.name === "LossApplied") return parsed;
            } catch {}
        }
        return null;
    }

    it("Reorder tranches repeatedly (applyLoss always burns correctly in the specified order)", async () => {
        // Big buffers so we can burn many times
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5000n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(5000n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(5000n)));

        // permutations
        const perms: string[][] = [
            [juniorAddr, mezzanineAddr, seniorAddr],
            [juniorAddr, seniorAddr, mezzanineAddr],
            [mezzanineAddr, juniorAddr, seniorAddr],
            [mezzanineAddr, seniorAddr, juniorAddr],
            [seniorAddr, juniorAddr, mezzanineAddr],
            [seniorAddr, mezzanineAddr, juniorAddr],
        ];

        // track expected balances
        const expected: Record<string, bigint> = {};
        expected[juniorAddr] = await mzusd.balanceOf(juniorAddr);
        expected[mezzanineAddr] = await mzusd.balanceOf(mezzanineAddr);
        expected[seniorAddr] = await mzusd.balanceOf(seniorAddr);

        const burnStep = to18(1n); // applyLoss(1 USDC) burns 1e18 mzUSD
        for (let i = 0; i < 24; i++) {
            const order: string[] = perms[i % perms.length];

            const tx1 = await lossManager.connect(deployer).setTrancheOrder(order);
            await tx1.wait();

            const tx2 = await lossManager.connect(deployer).applyLoss(to6(1n));
            const receipt2 = await tx2.wait();

            // expected burn only from first tranche (they all have enough TVL)
            expected[order[0]] -= burnStep;

            expect(await mzusd.balanceOf(juniorAddr)).to.equal(expected[juniorAddr]);
            expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(expected[mezzanineAddr]);
            expect(await mzusd.balanceOf(seniorAddr)).to.equal(expected[seniorAddr]);

            // Event should reflect the current order and cuts
            const parsed = parseLossApplied(receipt2);
            expect(parsed).to.not.equal(null);

            const usdcLoss = parsed!.args.usdcLoss as bigint;
            const lossMZ = parsed!.args.lossMZ as bigint;
            const tranchesArr = parsed!.args.tranches as string[];
            const cuts = parsed!.args.cutsMZ as bigint[];

            expect(usdcLoss).to.equal(to6(1n));
            expect(lossMZ).to.equal(to18(1n));
            expect(tranchesArr).to.deep.equal(order);
            expect(cuts.length).to.equal(3);
            expect(cuts[0]).to.equal(to18(1n));
            expect(cuts[1]).to.equal(0n);
            expect(cuts[2]).to.equal(0n);
        }
    });

    it("Should burn correctly (burns across tranches by order, and after order change burns by new order)", async () => {
        // Smaller amounts to force multi-tranche burning
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(5n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(7n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(9n)));

        // Order: [junior, mezz, senior]
        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrder([juniorAddr, mezzanineAddr, seniorAddr])
        ).wait();

        const j0 = await mzusd.balanceOf(juniorAddr);
        const m0 = await mzusd.balanceOf(mezzanineAddr);
        const s0 = await mzusd.balanceOf(seniorAddr);

        // Apply loss = 10 USDC -> burn 10e18: junior(5) + mezz(5)
        await (await lossManager.connect(deployer).applyLoss(to6(10n))).wait();

        expect(await mzusd.balanceOf(juniorAddr)).to.equal(j0 - to18(5n));
        expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(m0 - to18(5n));
        expect(await mzusd.balanceOf(seniorAddr)).to.equal(s0);

        // Change order: [senior, mezz, junior]
        await (
            await lossManager
                .connect(deployer)
                .setTrancheOrder([seniorAddr, mezzanineAddr, juniorAddr])
        ).wait();

        const j1 = await mzusd.balanceOf(juniorAddr);
        const m1 = await mzusd.balanceOf(mezzanineAddr);
        const s1 = await mzusd.balanceOf(seniorAddr);

        // Apply loss = 11 USDC -> burn 11e18: senior burns 9, remaining 2 burns from mezz (mezz has 2 left after the first loss)
        await (await lossManager.connect(deployer).applyLoss(to6(11n))).wait();

        expect(await mzusd.balanceOf(seniorAddr)).to.equal(s1 - to18(9n));
        expect(await mzusd.balanceOf(mezzanineAddr)).to.equal(m1 - to18(2n));
        expect(await mzusd.balanceOf(juniorAddr)).to.equal(j1);
    });

    it("Integration (deposits + vault distributeYield (streaming) + applyLoss during active stream)", async () => {
        // 1) Deposit principal into each tranche (100 each)
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));
        await depositMZIntoTranche(bob, mezzanine, await mintMZUSDFor(bob, to6(100n)));
        await depositMZIntoTranche(carol, senior, await mintMZUSDFor(carol, to6(100n)));

        // 2) Advance epoch and distribute yield (starts streaming on each tranche)
        await time.increase(DAY);
        const reported = to6(30n); // 30 MZUSD total (1:1)
        await (await vault.connect(deployer).distributeYield(reported)).wait();

        // At t=0 of stream: totalAssets should still be equal to principal (yield is fully unaccrued)
        expect(await junior.totalAssets()).to.equal(to18(100n));
        expect(await mezzanine.totalAssets()).to.equal(to18(100n));
        expect(await senior.totalAssets()).to.equal(to18(100n));

        // 3) Apply loss while stream is active.
        // Order defaults: [junior, mezzanine, senior]
        // Loss = 180 -> burns junior(100 + 1s accrued) + mezz(remaining), leaves senior untouched
        const jBalBefore = await mzusd.balanceOf(juniorAddr);
        const mBalBefore = await mzusd.balanceOf(mezzanineAddr);
        const sBalBefore = await mzusd.balanceOf(seniorAddr);

        // Hardhat mines a new block for the next tx, which would advance timestamp by ~1s and accrue a tiny bit of yield
        // execute applyLoss at streamStart + 1 to have deterministic 1-second accrual
        const streamStart = await junior.yieldStreamStart();
        await time.setNextBlockTimestamp(Number(streamStart + 1n));

        const lossMZ = to18(180n);
        const juniorYield = await junior.yieldStreamingAmount();
        const accruedJunior1s = (juniorYield * 1n) / BigInt(DAY);

        // At +1s, junior virtual NAV = principal + accrued(1s). LossManager burns up to tvl
        const expectedJuniorBurn = to18(100n) + accruedJunior1s;
        const remainingAfterJunior = lossMZ - expectedJuniorBurn;

        await (await lossManager.connect(deployer).applyLoss(to6(180n))).wait();

        const jBalAfter = await mzusd.balanceOf(juniorAddr);
        const mBalAfter = await mzusd.balanceOf(mezzanineAddr);
        const sBalAfter = await mzusd.balanceOf(seniorAddr);

        expect(jBalBefore - jBalAfter).to.equal(expectedJuniorBurn);
        expect(mBalBefore - mBalAfter).to.equal(remainingAfterJunior);
        expect(sBalAfter).to.equal(sBalBefore);

        // Immediately after loss, junior virtual NAV should become 0 (because balance = unaccrued yield)
        expect(await junior.totalAssets()).to.equal(0n);

        // 4) As time moves forward, unaccrued decreases and virtual NAV grows again (yield accrues)
        await time.increase(DAY / 2);

        // Junior should now have some accrued yield reflected as virtual NAV (>0)
        expect(await junior.totalAssets()).to.be.gt(0n);

        // importantly - totalAssets should never underflow/revert (guarded)
        // This asserts system stays coherent even with loss during streaming
        expect(await mezzanine.totalAssets()).to.be.gt(0n);
        expect(await senior.totalAssets()).to.be.gt(0n);
    });

    it("Revert InsufficientCover if total cover is not enough", async () => {
        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(10n))); // only 10 total
        await expect(
            lossManager.connect(deployer).applyLoss(to6(11n))
        ).to.be.revertedWithCustomError(lossManager, "InsufficientCover");
    });

    it("Reverts in setTrancheOrder + applyLoss zero", async () => {
        await expect(
            lossManager.connect(deployer).setTrancheOrder([])
        ).to.be.revertedWithCustomError(lossManager, "ZeroLength");

        await expect(
            lossManager.connect(deployer).setTrancheOrder([ethers.ZeroAddress])
        ).to.be.revertedWithCustomError(lossManager, "ZeroAddress");

        await expect(lossManager.connect(deployer).applyLoss(0)).to.be.revertedWithCustomError(
            lossManager,
            "ZeroAmount"
        );
    });

    it("Enforces maxLossPerTxUSDC", async () => {
        await (await lossManager.connect(deployer).setMaxLossPerTxUSDC(to6(5n))).wait();

        await depositMZIntoTranche(alice, junior, await mintMZUSDFor(alice, to6(100n)));

        await expect(
            lossManager.connect(deployer).applyLoss(to6(6n))
        ).to.be.revertedWithCustomError(lossManager, "LimitExceeded");
    });
});
