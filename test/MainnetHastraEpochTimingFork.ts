import {expect} from "chai";
import {ethers, network} from "hardhat";
import {time} from "@nomicfoundation/hardhat-network-helpers";

const forkTest = process.env.TEST_MAINNET_HASTRA_EPOCH_TIMING === "true" ? describe : describe.skip;
const FORK_BLOCK = 26342978; // 2026-11-04 17:34:59 UTC, after the replacement NAV submission.
const WEEK = 604800n;
const TEMPORARY_DURATION = WEEK - 75n * 60n;
const STEADY_DURATION = WEEK - 15n * 60n;
const SAFE = "0x0b61220A0d0aFd11da63B2931EE368E34E60d122";
const RECEIVER = "0xFAf5012Ee1d9344cf388281e67982Efa75a0bC77";
const OPERATOR = "0x816dd023C90eDfb751EEfdCCe064AeBB3Bb2AaEd";
const VAULT = "0xBB03549117e38103589774AE1D6338D1B237FFA2";
const NAV = "0x9994BC2eCdFd7BDeB5423f5e48E285b91e6a69A7";
const TRANCHES = [
    "0x0e246e5FA94E90ab784b03961C35AaD9999b6649",
    "0x6F5d94Dc0c8bBf052aBF024259d087dA45AD96A1",
];
const utc = (value: string) => BigInt(Date.parse(value) / 1000);

forkTest("Hastra epoch timing transition on a pinned mainnet fork", function () {
    this.timeout(300000);

    beforeEach(async () => {
        expect(network.name).to.equal("hardhat");
        const jsonRpcUrl = process.env.MAINNET_RPC ?? process.env.FORKING_URL;
        if (!jsonRpcUrl) throw new Error("A mainnet RPC is required for this opt-in fork test");
        await network.provider.send("hardhat_reset", [
            {forking: {jsonRpcUrl, blockNumber: FORK_BLOCK}},
        ]);
        for (const address of [SAFE, RECEIVER, OPERATOR]) {
            await network.provider.send("hardhat_impersonateAccount", [address]);
            await network.provider.send("hardhat_setBalance", [address, "0x3635C9ADC5DEA00000"]);
        }
    });

    it("queues changes without shortening the current epoch and overwrites an earlier queue", async () => {
        const vault = await ethers.getContractAt(
            "IssuanceVault",
            VAULT,
            await ethers.getSigner(SAFE)
        );
        const start = await vault.epochStart();
        await expect(vault.setEpochConfig(TEMPORARY_DURATION))
            .to.emit(vault, "EpochDurationQueued")
            .withArgs(TEMPORARY_DURATION);
        expect(await vault.epochDuration()).to.equal(WEEK);
        expect(await vault.epochStart()).to.equal(start);
        expect(await vault.pendingEpochDuration()).to.equal(TEMPORARY_DURATION);
        await vault.setEpochConfig(STEADY_DURATION);
        expect(await vault.pendingEpochDuration()).to.equal(STEADY_DURATION);
        expect(await vault.epochDuration()).to.equal(WEEK);
    });

    it("respects the late NAV veto, recovers on November 12, and keeps November 19 at 14:00 UTC", async () => {
        const vault = await ethers.getContractAt(
            "IssuanceVault",
            VAULT,
            await ethers.getSigner(SAFE)
        );
        const nav = await ethers.getContractAt("NavOracleAutomation", NAV);
        const receiver = await ethers.getSigner(RECEIVER);
        const tranches = await Promise.all(TRANCHES.map((a) => ethers.getContractAt("Tranche", a)));
        expect(await vault.currentEpochId()).to.equal(3n);
        expect(await vault.epochStart()).to.equal(utc("2026-10-29T13:30:11Z"));
        expect(await vault.epochDuration()).to.equal(WEEK);
        expect(await vault.pendingEpochDuration()).to.equal(0n);
        expect(await nav.pendingReadyAt()).to.equal(utc("2026-11-05T14:24:11Z"));
        const initialDelta = await nav.pendingDeltaUSDC();
        expect(initialDelta).to.equal(14232534407n);
        await vault.setEpochConfig(TEMPORARY_DURATION);

        // The queued shorter duration cannot bypass the NAV veto or the current duration.
        await time.increaseTo(utc("2026-11-05T14:00:00Z"));
        expect((await nav.checkUpkeep("0x"))[0]).to.equal(false);
        await expect(nav.connect(receiver).performUpkeep("0x")).to.be.revertedWithCustomError(
            nav,
            "NotReady"
        );
        await time.increaseTo(utc("2026-11-05T14:24:11Z"));
        expect((await nav.checkUpkeep("0x"))[0]).to.equal(true);
        await time.setNextBlockTimestamp(utc("2026-11-05T14:25:11Z"));
        await expect(nav.connect(receiver).performUpkeep("0x"))
            .to.emit(vault, "EpochDurationSet")
            .withArgs(TEMPORARY_DURATION)
            .and.to.emit(nav, "NavApplied")
            .withArgs(true, initialDelta, utc("2026-11-05T14:24:11Z"));
        expect(await vault.currentEpochId()).to.equal(4n);
        expect((await nav.checkUpkeep("0x"))[0]).to.equal(false);
        expect(await vault.epochDuration()).to.equal(TEMPORARY_DURATION);
        expect(await vault.pendingEpochDuration()).to.equal(0n);
        for (const tranche of tranches) {
            expect(await tranche.yieldStreamStart()).to.equal(utc("2026-11-05T14:25:11Z"));
            expect(await tranche.yieldStreamEnd()).to.equal(utc("2026-11-12T13:10:11Z"));
        }

        // Queue the permanent duration only AFTER the temporary one has taken effect.
        await vault.setEpochConfig(STEADY_DURATION);
        expect(await vault.epochDuration()).to.equal(TEMPORARY_DURATION);
        expect(await vault.pendingEpochDuration()).to.equal(STEADY_DURATION);

        // Future oracle reports are hypothetical: replace feeds only on this local fork.
        // The real November 5 report above is applied unchanged, using live deployed contracts.
        const feedFactory = await ethers.getContractFactory("MockPackedNavOracle");
        const navFeed = await feedFactory.deploy(8, "Fork-only NAV");
        const supplyFeed = await feedFactory.deploy(8, "Fork-only supply");
        await nav
            .connect(await ethers.getSigner(SAFE))
            .setOracles(navFeed.target, supplyFeed.target);
        const mz = await ethers.getContractAt("MZUSD", await vault.mzusd());
        for (const [date, epoch] of [
            ["2026-11-12", 5n],
            ["2026-11-19", 6n],
        ] as const) {
            const windowStart = utc(`${date}T14:00:00Z`);
            await time.increaseTo(windowStart - 86400n - 600n);
            const timestamp = BigInt(await time.latest());
            const supply = (await mz.totalSupply()) / 10n ** 10n;
            await navFeed.setLatestRoundData(supply + 100000000n, timestamp);
            await supplyFeed.setLatestRoundData(supply, timestamp);
            await nav.connect(await ethers.getSigner(OPERATOR)).submitNav();
            expect(await nav.pendingReadyAt()).to.be.lessThan(windowStart);
            await time.increaseTo(windowStart - 1n);
            expect((await nav.checkUpkeep("0x"))[0]).to.equal(true);
            for (const tranche of tranches)
                expect(await tranche.yieldStreamEnd()).to.be.lessThan(windowStart);
            await time.setNextBlockTimestamp(windowStart + 11n);
            await expect(nav.connect(receiver).performUpkeep("0x")).to.emit(nav, "NavApplied");
            expect(await vault.currentEpochId()).to.equal(epoch);
            expect(await vault.epochStart()).to.equal(windowStart + 11n);
            expect(await vault.epochDuration()).to.equal(STEADY_DURATION);
            expect(await vault.pendingEpochDuration()).to.equal(0n);
            expect((await nav.checkUpkeep("0x"))[0]).to.equal(false);
            for (const tranche of tranches) {
                expect(await tranche.yieldStreamStart()).to.equal(windowStart + 11n);
                expect(await tranche.yieldStreamEnd()).to.equal(
                    windowStart + 11n + STEADY_DURATION
                );
            }
        }
    });
});
