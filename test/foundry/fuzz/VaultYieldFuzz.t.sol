// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Tranche} from "contracts/Tranche.sol";
import {Vault} from "contracts/Vault.sol";
import {MockLossManagerRef} from "contracts/test/MockLossManagerRef.sol";
import {MockNavOracleAutomationRef} from "contracts/test/MockNavOracleAutomationRef.sol";
import {BaseProtocolFuzzTest} from "./BaseProtocolFuzz.t.sol";

contract VaultYieldFuzzTest is BaseProtocolFuzzTest {
    uint16 internal constant BASE_REWARD_BPS = 4000;
    uint16 internal constant RISK_BPS = 2000;

    Tranche internal tranche0;
    Tranche internal tranche1;
    Tranche internal tranche2;
    address internal navOracle;

    function setUp() public override {
        super.setUp();

        uint64 adminRole = accessManager.ADMIN_ROLE();
        bytes4[] memory vaultSelectors = new bytes4[](5);
        vaultSelectors[0] = Vault.setLossManager.selector;
        vaultSelectors[1] = Vault.setNavOracle.selector;
        vaultSelectors[2] = Vault.registerTranche.selector;
        vaultSelectors[3] = Vault.setTrancheConfig.selector;
        vaultSelectors[4] = Vault.setFeeRates.selector;
        accessManager.setTargetFunctionRole(address(vault), vaultSelectors, adminRole);

        tranche0 = _deployTranche(1, "Tranche 0", "T0");
        tranche1 = _deployTranche(2, "Tranche 1", "T1");
        tranche2 = _deployTranche(3, "Tranche 2", "T2");

        MockLossManagerRef lossRef = new MockLossManagerRef(address(vault), address(mzusd));
        vault.setLossManager(address(lossRef));

        MockNavOracleAutomationRef navRef = new MockNavOracleAutomationRef(
            address(vault),
            address(lossRef),
            address(mzusd)
        );
        navOracle = address(navRef);
        vault.setNavOracle(navOracle);

        vault.registerTranche(address(tranche0));
        vault.registerTranche(address(tranche1));
        vault.registerTranche(address(tranche2));

        Vault.TrancheInfo[] memory infos = new Vault.TrancheInfo[](3);
        infos[0] = Vault.TrancheInfo(address(tranche0), RISK_BPS, true);
        infos[1] = Vault.TrancheInfo(address(tranche1), RISK_BPS, true);
        infos[2] = Vault.TrancheInfo(address(tranche2), RISK_BPS, true);
        bool[] memory pairFlags = new bool[](3);
        vault.setTrancheConfig(infos, pairFlags, BASE_REWARD_BPS);
    }

    function testFuzz_DistributeYieldConservesMintAndAllocatesAll(
        uint96 usdcReportedSeed,
        uint16 perfBpsSeed,
        uint16 protBpsSeed,
        uint96 deposit0Seed,
        uint96 deposit1Seed,
        uint96 deposit2Seed
    ) public {
        uint16 perfBps = uint16(bound(perfBpsSeed, 0, 5_000));
        uint16 protBps = uint16(bound(protBpsSeed, 0, 5_000));
        vm.assume(uint256(perfBps) + uint256(protBps) <= vault.MAX_TOTAL_FEE_BPS());

        uint256 deposit0 = bound(uint256(deposit0Seed), 1, 3_000_000e6);
        uint256 deposit1 = bound(uint256(deposit1Seed), 1, 3_000_000e6);
        uint256 deposit2 = bound(uint256(deposit2Seed), 1, 3_000_000e6);

        _fundAndDeposit(vm.addr(101), tranche0, deposit0);
        _fundAndDeposit(vm.addr(102), tranche1, deposit1);
        _fundAndDeposit(vm.addr(103), tranche2, deposit2);

        vault.setFeeRates(perfBps, protBps);

        uint256 usdcReported = bound(uint256(usdcReportedSeed), 0, 5_000_000e6);
        uint256 mintedGross = usdcReported * SCALE;
        uint256 expectedPerf = (mintedGross * perfBps) / BPS;
        uint256 expectedProt = (mintedGross * protBps) / BPS;
        uint256 allocatable = mintedGross - expectedPerf - expectedProt;

        uint256 t0Before = mzusd.balanceOf(address(tranche0));
        uint256 t1Before = mzusd.balanceOf(address(tranche1));
        uint256 t2Before = mzusd.balanceOf(address(tranche2));
        uint256 feeReceiverBefore = mzusd.balanceOf(address(this));
        uint256 supplyBefore = mzusd.totalSupply();

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        vault.distributeYield(usdcReported);

        uint256 t0After = mzusd.balanceOf(address(tranche0));
        uint256 t1After = mzusd.balanceOf(address(tranche1));
        uint256 t2After = mzusd.balanceOf(address(tranche2));
        uint256 supplyAfter = mzusd.totalSupply();
        uint256 feeReceiverAfter = mzusd.balanceOf(address(this));

        assertEq(supplyAfter - supplyBefore, mintedGross);
        assertEq(feeReceiverAfter - feeReceiverBefore, expectedPerf + expectedProt);
        assertEq(mzusd.balanceOf(address(vault)), 0);

        if (allocatable == 0) {
            assertEq(t0After - t0Before, 0);
            assertEq(t1After - t1Before, 0);
            assertEq(t2After - t2Before, 0);
            return;
        }

        uint256 totalTvl = t0Before + t1Before + t2Before;
        uint256 basePool = (allocatable * BASE_REWARD_BPS) / BPS;

        uint256 expected0 = ((basePool * t0Before) / totalTvl) + ((allocatable * RISK_BPS) / BPS);
        uint256 expected1 = ((basePool * t1Before) / totalTvl) + ((allocatable * RISK_BPS) / BPS);
        uint256 expected2 = allocatable - expected0 - expected1;

        assertEq(t0After - t0Before, expected0);
        assertEq(t1After - t1Before, expected1);
        assertEq(t2After - t2Before, expected2);
        assertEq((t0After - t0Before) + (t1After - t1Before) + (t2After - t2Before), allocatable);
    }

    function testFuzz_DistributeYieldSkipsDisabledAndZeroTVLButAllocatesAll(
        uint96 usdcReportedSeed,
        uint16 perfBpsSeed,
        uint16 protBpsSeed,
        uint96 deposit0Seed,
        uint96 deposit1Seed
    ) public {
        uint16 perfBps = uint16(bound(perfBpsSeed, 0, 5_000));
        uint16 protBps = uint16(bound(protBpsSeed, 0, 5_000));
        vm.assume(uint256(perfBps) + uint256(protBps) <= vault.MAX_TOTAL_FEE_BPS());

        uint256 deposit0 = bound(uint256(deposit0Seed), 1, 3_000_000e6);
        uint256 deposit1 = bound(uint256(deposit1Seed), 1, 3_000_000e6);
        _fundAndDeposit(vm.addr(201), tranche0, deposit0);
        _fundAndDeposit(vm.addr(202), tranche1, deposit1);

        Vault.TrancheInfo[] memory infos = new Vault.TrancheInfo[](3);
        infos[0] = Vault.TrancheInfo(address(tranche0), 2000, true);
        infos[1] = Vault.TrancheInfo(address(tranche1), 3000, false);
        infos[2] = Vault.TrancheInfo(address(tranche2), 1000, true);
        bool[] memory pairFlags = new bool[](3);
        vault.setTrancheConfig(infos, pairFlags, 4000);

        vault.setFeeRates(perfBps, protBps);

        uint256 usdcReported = bound(uint256(usdcReportedSeed), 1, 5_000_000e6);
        uint256 mintedGross = usdcReported * SCALE;
        uint256 expectedPerf = (mintedGross * perfBps) / BPS;
        uint256 expectedProt = (mintedGross * protBps) / BPS;
        uint256 allocatable = mintedGross - expectedPerf - expectedProt;

        uint256 t0Before = mzusd.balanceOf(address(tranche0));
        uint256 t1Before = mzusd.balanceOf(address(tranche1));
        uint256 t2Before = mzusd.balanceOf(address(tranche2));
        uint256 feeReceiverBefore = mzusd.balanceOf(address(this));
        uint256 supplyBefore = mzusd.totalSupply();

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        vault.distributeYield(usdcReported);

        uint256 t0After = mzusd.balanceOf(address(tranche0));
        uint256 t1After = mzusd.balanceOf(address(tranche1));
        uint256 t2After = mzusd.balanceOf(address(tranche2));
        uint256 feeReceiverAfter = mzusd.balanceOf(address(this));
        uint256 supplyAfter = mzusd.totalSupply();

        assertEq(supplyAfter - supplyBefore, mintedGross);
        assertEq(feeReceiverAfter - feeReceiverBefore, expectedPerf + expectedProt);
        assertEq(mzusd.balanceOf(address(vault)), 0);

        assertEq(t0After - t0Before, allocatable);
        assertEq(t1After - t1Before, 0);
        assertEq(t2After - t2Before, 0);
    }

    function testFuzz_DistributeYieldRevertsWhenNoEnabledTrancheHasTVL(
        uint96 usdcReportedSeed,
        uint96 depositSeed
    ) public {
        uint256 deposit0 = bound(uint256(depositSeed), 1, 3_000_000e6);
        _fundAndDeposit(vm.addr(301), tranche0, deposit0);

        Vault.TrancheInfo[] memory infos = new Vault.TrancheInfo[](3);
        infos[0] = Vault.TrancheInfo(address(tranche0), 3333, false);
        infos[1] = Vault.TrancheInfo(address(tranche1), 3333, false);
        infos[2] = Vault.TrancheInfo(address(tranche2), 3334, false);
        bool[] memory pairFlags = new bool[](3);
        vault.setTrancheConfig(infos, pairFlags, 0);

        uint256 usdcReported = bound(uint256(usdcReportedSeed), 1, 5_000_000e6);

        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(Vault.TVLZero.selector);
        vm.prank(navOracle);
        vault.distributeYield(usdcReported);
    }

    function testFuzz_DistributeYieldWithDynamicConfigMatchesModel(
        uint96 usdcReportedSeed,
        uint16 perfBpsSeed,
        uint16 protBpsSeed,
        uint96 deposit0Seed,
        uint96 deposit1Seed,
        uint96 deposit2Seed,
        uint16 risk0Seed,
        uint16 risk1Seed,
        uint16 baseSeed,
        uint8 enabledSeed
    ) public {
        uint16 perfBps = uint16(bound(perfBpsSeed, 0, 5_000));
        uint16 protBps = uint16(bound(protBpsSeed, 0, 5_000));
        vm.assume(uint256(perfBps) + uint256(protBps) <= vault.MAX_TOTAL_FEE_BPS());

        uint256 deposit0 = bound(uint256(deposit0Seed), 0, 3_000_000e6);
        uint256 deposit1 = bound(uint256(deposit1Seed), 0, 3_000_000e6);
        uint256 deposit2 = bound(uint256(deposit2Seed), 0, 3_000_000e6);

        if (deposit0 != 0) _fundAndDeposit(vm.addr(401), tranche0, deposit0);
        if (deposit1 != 0) _fundAndDeposit(vm.addr(402), tranche1, deposit1);
        if (deposit2 != 0) _fundAndDeposit(vm.addr(403), tranche2, deposit2);

        uint16 risk0 = uint16(bound(uint256(risk0Seed), 0, BPS));
        uint16 risk1 = uint16(bound(uint256(risk1Seed), 0, BPS - risk0));
        uint16 baseRewardBps = uint16(bound(uint256(baseSeed), 0, BPS - risk0 - risk1));
        uint16 risk2 = uint16(BPS - baseRewardBps - risk0 - risk1);

        Vault.TrancheInfo[] memory infos = new Vault.TrancheInfo[](3);
        infos[0] = Vault.TrancheInfo(address(tranche0), risk0, (enabledSeed & 0x01) != 0);
        infos[1] = Vault.TrancheInfo(address(tranche1), risk1, (enabledSeed & 0x02) != 0);
        infos[2] = Vault.TrancheInfo(address(tranche2), risk2, (enabledSeed & 0x04) != 0);
        bool[] memory pairFlags = new bool[](3);
        vault.setTrancheConfig(infos, pairFlags, baseRewardBps);

        vault.setFeeRates(perfBps, protBps);

        uint256 usdcReported = bound(uint256(usdcReportedSeed), 1, 5_000_000e6);
        uint256 mintedGross = usdcReported * SCALE;
        uint256 expectedPerf = (mintedGross * perfBps) / BPS;
        uint256 expectedProt = (mintedGross * protBps) / BPS;
        uint256 allocatable = mintedGross - expectedPerf - expectedProt;

        uint256[3] memory trancheTvls;
        trancheTvls[0] = tranche0.totalAssets();
        trancheTvls[1] = tranche1.totalAssets();
        trancheTvls[2] = tranche2.totalAssets();

        bool[3] memory participating;
        uint256 totalTvl;
        uint256 lastParticipatingIdx;
        bool hasParticipants;

        for (uint256 i; i < 3; ++i) {
            if (!enabled[i] || trancheTvls[i] == 0) continue;
            participating[i] = true;
            hasParticipants = true;
            totalTvl += trancheTvls[i];
            lastParticipatingIdx = i;
        }

        uint256 feeReceiverBefore = mzusd.balanceOf(address(this));
        uint256 supplyBefore = mzusd.totalSupply();
        uint256[3] memory trancheBalancesBefore;
        trancheBalancesBefore[0] = mzusd.balanceOf(address(tranche0));
        trancheBalancesBefore[1] = mzusd.balanceOf(address(tranche1));
        trancheBalancesBefore[2] = mzusd.balanceOf(address(tranche2));

        vm.warp(block.timestamp + 1 days + 1);

        if (!hasParticipants) {
            vm.expectRevert(Vault.TVLZero.selector);
            vm.prank(navOracle);
            vault.distributeYield(usdcReported);
            return;
        }

        vm.prank(navOracle);
        vault.distributeYield(usdcReported);

        uint256[3] memory expectedShares;
        uint256 basePool = (allocatable * baseRewardBps) / BPS;
        uint256 allocated;
        for (uint256 i; i < 3; ++i) {
            if (!participating[i]) continue;
            uint256 baseShare = (basePool * trancheTvls[i]) / totalTvl;
            uint256 riskShare = (allocatable * risk[i]) / BPS;
            uint256 totalShare = baseShare + riskShare;

            if (i == lastParticipatingIdx) {
                totalShare = allocatable - allocated;
            }

            expectedShares[i] = totalShare;
            allocated += totalShare;
        }

        uint256[3] memory trancheBalancesAfter;
        trancheBalancesAfter[0] = mzusd.balanceOf(address(tranche0));
        trancheBalancesAfter[1] = mzusd.balanceOf(address(tranche1));
        trancheBalancesAfter[2] = mzusd.balanceOf(address(tranche2));

        uint256 supplyAfter = mzusd.totalSupply();
        uint256 feeReceiverAfter = mzusd.balanceOf(address(this));

        assertEq(supplyAfter - supplyBefore, mintedGross);
        assertEq(feeReceiverAfter - feeReceiverBefore, expectedPerf + expectedProt);
        assertEq(mzusd.balanceOf(address(vault)), 0);

        assertEq(trancheBalancesAfter[0] - trancheBalancesBefore[0], expectedShares[0]);
        assertEq(trancheBalancesAfter[1] - trancheBalancesBefore[1], expectedShares[1]);
        assertEq(trancheBalancesAfter[2] - trancheBalancesBefore[2], expectedShares[2]);
        assertEq(expectedShares[0] + expectedShares[1] + expectedShares[2], allocatable);
    }

    function _deployTranche(
        uint256 trancheId,
        string memory name,
        string memory symbol
    ) internal returns (Tranche tranche) {
        Tranche trancheImpl = new Tranche(address(vault), false);
        tranche = Tranche(
            _deployProxy(
                address(trancheImpl),
                abi.encodeCall(Tranche.initialize, (trancheId, 0, name, symbol))
            )
        );
    }

    function _fundAndDeposit(address user, Tranche tranche, uint256 usdcAmount) internal {
        uint256 mzAmount = usdcAmount * SCALE;

        usdc.mint(user, usdcAmount);
        vm.startPrank(user);
        usdc.approve(address(mzusd), usdcAmount);
        mzusd.deposit(usdcAmount);
        mzusd.approve(address(tranche), mzAmount);
        tranche.deposit(mzAmount, user);
        vm.stopPrank();
    }
}
