import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { parseEther, MaxUint256, ZeroAddress, parseUnits } from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { impersonateAccount, setBalance, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { } from "../typechain-types";

async function imp(addr: string) {
  await setBalance(addr, parseEther("10"));
  await impersonateAccount(addr);
  return ethers.getSigner(addr);
}

let deployer: SignerWithAddress,
  admin: SignerWithAddress,
  user1: SignerWithAddress,
  user2: SignerWithAddress,
  user3: SignerWithAddress,
  user4: SignerWithAddress;

let snapshotA: SnapshotRestorer;

describe("Smth", () => {
  before(async () => {
    [deployer] = await ethers.getSigners();
    admin = deployer;

    const RetailCoreFactory = await ethers.getContractFactory("RetailCore", deployer);
    retail = (await upgrades.deployProxy(
      RetailCoreFactory,
      [king.target, admin.address, DEPOSIT_FEE_BPS, UNWRAP_FEE_BPS, EPOCH_DURATION_S],
      { initializer: "initialize", kind: "transparent" },
    )) as RetailCore;

    swell = (await ethers.getContractAt("IERC20", TOKENS.SWELL, user1)) as IERC20;

    await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    snapshotA = await takeSnapshot();
  });

  afterEach(async () => await snapshotA.restore());

  describe("Deployment", () => {
    it("should initialize correctly", async () => {
      expect(await retail.kingContract()).to.equal(KING_ADDRESS);
    });
  });
});
