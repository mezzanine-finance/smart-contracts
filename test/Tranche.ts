import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { parseUnits } from "ethers";
import {
  impersonateAccount,
  setBalance,
  takeSnapshot,
  time,
} from "@nomicfoundation/hardhat-network-helpers";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

import {
  MZUSD,
  Vault,
  ReservoirUSDC,
  IERC20,
  Tranche,
} from "../typechain-types";

// Mainnet USDC constants
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_WHALE = "0x38AAEF3782910bdd9eA3566C839788Af6FF9B200";
const VAULT_ROLE = 2n;

const to6 = (value: string | number | bigint) =>
  parseUnits(value.toString(), 6);
const to18 = (value: string | number | bigint) =>
  parseUnits(value.toString(), 18);

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

  let accessManager: any;
  let vault: Vault;
  let mzusd: MZUSD;
  let usdc: IERC20;
  let reservoir: ReservoirUSDC;
  let tranche: Tranche;

  before(async () => {
    [deployer, alice, bob] = await ethers.getSigners();

    usdc = await ethers.getContractAt("IERC20", MAINNET_USDC, deployer);
    upgrades.silenceWarnings();

    await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);

    const AccessManagerFactory = await ethers.getContractFactory(
      "AccessManager",
      deployer
    );
    accessManager = await AccessManagerFactory.deploy(deployer.address);
    await accessManager.waitForDeployment();

    const MZUSDFactory = await ethers.getContractFactory("MZUSD", deployer);
    mzusd = (await upgrades.deployProxy(
      MZUSDFactory,
      [
        accessManager.target,
        MAINNET_USDC,
        0, // _hourlyLimitUSDC (0 = limit is off)
      ],
      {
        kind: "uups",
        initializer: "initialize",
        unsafeAllow: ["constructor"],
      }
    )) as unknown as MZUSD;

    const ReservoirFactory = await ethers.getContractFactory(
      "ReservoirUSDC",
      deployer
    );
    reservoir = (await upgrades.deployProxy(
      ReservoirFactory,
      [MAINNET_USDC, accessManager.target],
      {
        kind: "uups",
        initializer: "initialize",
        unsafeAllow: ["constructor"],
      }
    )) as unknown as ReservoirUSDC;

    const VaultFactory = await ethers.getContractFactory("Vault", deployer);
    vault = (await upgrades.deployProxy(
      VaultFactory,
      [MAINNET_USDC, mzusd.target, reservoir.target, accessManager.target],
      {
        kind: "uups",
        initializer: "initialize",
        unsafeAllow: ["constructor"],
      }
    )) as unknown as Vault;

    // Wire MZUSD to Vault
    await mzusd.setVault(vault.target);

    // Tranche
    const TrancheFactory = await ethers.getContractFactory("Tranche", deployer);
    tranche = (await upgrades.deployProxy(
      TrancheFactory,
      [
        mzusd.target, // assetToken (MZUSD as IERC20)
        vault.target, // vaultAddress
        1, // trancheIdentifier
        0, // initialUnstakeDelayEpochs
        "Senior Tranche", // name
        "sMZUSD", // symbol
        accessManager.target, // accessManager
        false, // polJuniorMode
        ethers.ZeroAddress, // polPayoutAddress
      ],
      {
        kind: "uups",
        initializer: "initialize",
        unsafeAllow: ["constructor"],
      }
    )) as unknown as Tranche;

    // register tranche in vault for yield tests
    await vault.addTranche(tranche.target, 10_000, true);

    //ROLES granting
    // 1) Allow VAULT_ROLE to call MZUSD.mint()
    const mintSelector = mzusd.interface.getFunction("mint")!.selector;
    await accessManager.setTargetFunctionRole(
      mzusd.target,
      [mintSelector],
      VAULT_ROLE
    );

    // 2) Allow VAULT_ROLE to call Tranche.notifyYield()
    const notifySelector =
      tranche.interface.getFunction("notifyYield")!.selector;
    await accessManager.setTargetFunctionRole(
      tranche.target,
      [notifySelector],
      VAULT_ROLE
    );

    // 3) Grant VAULT_ROLE to Vault
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

  // small helper to mint MZUSD via real deposit
  async function mintMZUSDFor(user: any, usdcAmount6: bigint): Promise<bigint> {
    const whale = await imp(USDC_WHALE);

    // give user some USDC
    await usdc.connect(whale).transfer(user.address, usdcAmount6);

    // deposit to MZUSD
    await usdc.connect(user).approve(mzusd.target, usdcAmount6);
    await mzusd.connect(user).deposit(usdcAmount6);

    const mzBalance = await mzusd.balanceOf(user.address);
    return mzBalance;
  }

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

    const tx = await tranche.connect(alice).deposit(expectedMZ, alice.address);
    await tx.wait();

    await expect(tx)
      .to.emit(tranche, "Deposit")
      .withArgs(alice.address, alice.address, expectedMZ, expectedMZ);

    const aliceMZFinal = await mzusd.balanceOf(alice.address);
    const aliceShares = await tranche.balanceOf(alice.address);
    const trancheAssetsAfter = await tranche.totalAssets();
    const trancheSharesAfter = await tranche.totalSupply();

    // MZUSD moved from Alice to Tranche
    expect(aliceMZFinal).to.equal(0n);

    // first deposit in ERC4626 -> shares == assets
    expect(aliceShares).to.equal(expectedMZ);
    expect(trancheSharesAfter).to.equal(expectedMZ);

    // totalAssets uses virtual NAV, but without streaming = real MZUSD balance
    expect(trancheAssetsAfter).to.equal(expectedMZ);

    // convertToAssets(shares) will return the same amount
    const previewAssets = await tranche.convertToAssets(aliceShares);
    expect(previewAssets).to.equal(expectedMZ);
  });

  it.only("Streams yield linearly and affects deposits & pricePerShare correctly", async () => {
    const DAY = 24 * 60 * 60;

    // 1) Alice gets MZUSD
    const depositUSDC = to6(100n); // 100 USDC -> 100 MZUSD
    const expectedMZ = to18(100n);

    await mintMZUSDFor(alice, depositUSDC);

    // And deposits into Tranche
    await mzusd.connect(alice).approve(tranche.target, expectedMZ);
    await tranche.connect(alice).deposit(expectedMZ, alice.address);

    const aliceShares = await tranche.balanceOf(alice.address);
    expect(aliceShares).to.equal(expectedMZ);

    const assetsAfterAliceDeposit = await tranche.totalAssets();
    expect(assetsAfterAliceDeposit).to.equal(expectedMZ); // 100

    await expect(
      vault.connect(deployer).distributeYield(1000n)
    ).to.be.revertedWithCustomError(vault, "EpochTooSoon"); // dummy call to check revert

    // 2) Time skip for one epoch, distributeYield on Vault is called
    // needed to make _advanceEpochAndValidate() not to fail with EpochTooSoon (1 day because we initialized contract with 1 day minEpochDuration)
    await time.increase(DAY);

    const reportedUSDC = to6(20n);
    const expectedYieldMZ = to18(20n);
    const epochIdBefore = await vault.currentEpochId();
    const newEpochId = (await vault.currentEpochId()) + 1n;

    // Call distributeYield and get tx
    const tx = await vault.connect(deployer).distributeYield(reportedUSDC);
    await tx.wait();

    // Use Hardhat time helper to get latest block timestamp (the tx block)
    const streamStartTs = BigInt(await time.latest());
    const minDuration = await vault.minEpochDuration();
    const expectedStreamEnd = streamStartTs + minDuration;

    await expect(tx)
      .to.emit(tranche, "YieldNotified")
      .withArgs(newEpochId, expectedYieldMZ, streamStartTs, expectedStreamEnd)
      .and.emit(vault, "YieldDistributed")
      .withArgs(reportedUSDC, expectedYieldMZ, newEpochId);

    const streamingAmount = await tranche.yieldStreamingAmount();
    expect(streamingAmount).to.equal(expectedYieldMZ);

    const yieldStart = await tranche.yieldStreamStart();
    const yieldEnd = await tranche.yieldStreamEnd();

    expect(yieldStart).to.equal(streamStartTs);
    expect(yieldEnd).to.equal(expectedStreamEnd);
    expect(yieldEnd - yieldStart).to.equal(minDuration);

    // On Tranche the yield is already there, but all "unaccrued" (ts == start)
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
    // expect(priceMid).to.equal(expectedMidPrice);

    // 4) Bob comes in the middle of the stream: deposits MZUSD at the already increased price
    const bobUSDCDeposit = to6(100n);
    const bobMintedMZ = await mintMZUSDFor(bob, bobUSDCDeposit);

    await mzusd.connect(bob).approve(tranche.target, bobMintedMZ);

    // previewDeposit needs to show less shares than assets, because pricePerShare > 1
    const previewBobShares = await tranche.previewDeposit(bobMintedMZ);

    expect(previewBobShares).to.be.lt(bobMintedMZ); // bob's part is worth less shares due to pricePerShare > 1

    const txBob = await tranche.connect(bob).deposit(bobMintedMZ, bob.address);
    await txBob.wait();

    const bobShares = await tranche.balanceOf(bob.address);

    //price grow up because of streaming, between preview and actual deposit
    //because of it actual shares should be lte than previewed
    expect(bobShares).to.be.lte(previewBobShares);
    expect(bobShares).to.be.gt(0n);
    const delta =
      previewBobShares > bobShares
        ? previewBobShares - bobShares
        : bobShares - previewBobShares;

    //difference due to math and 1 second of streaming should be very small
    expect(delta).to.be.lte(10n ** 16n);

    // For checking sanity: Alice still has her original shares
    const aliceSharesAfterBob = await tranche.balanceOf(alice.address);
    expect(aliceSharesAfterBob).to.equal(aliceShares);

    // 5) Move time to the end of streaming and check that all yield is accrued
    await time.increase(DAY);

    const finalBalance = await mzusd.balanceOf(tranche.target);
    const finalTotalAssets = await tranche.totalAssets();

    // On the balance: 100 (Alice) + 100 (Bob) + 20 (yield) = 220
    expect(finalBalance).to.equal(to18(220n));

    // Virtual totalAssets should match real balance, as unaccruedYield == 0
    expect(finalTotalAssets).to.equal(finalBalance);

    const totalShares = await tranche.totalSupply();
    const finalPrice = await tranche.pricePerShare();

    // Price should be > midPrice and > 1
    expect(finalPrice).to.be.gt(priceMid);
    expect(finalPrice).to.be.gt(to18(1n));

    // Invariant check: NAV ~= price * totalShares / 1e18
    const reconstructedAssets = (finalPrice * totalShares) / to18(1n);
    // Allow a small difference due to integer divisions, but it should be minimal
    const diff = finalTotalAssets - reconstructedAssets;
    const absDiff = diff >= 0n ? diff : -diff;

    // difference is purely from integer division rounding (streaming + ERC4626 formulas),
    // should be tiny compared to total NAV
    expect(absDiff).to.be.lte(1000n);
  });
});
