// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Tranche} from "contracts/Tranche.sol";
import {IssuanceVault} from "contracts/IssuanceVault.sol";
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
        vaultSelectors[0] = IssuanceVault.setLossManager.selector;
        vaultSelectors[1] = IssuanceVault.setNavOracle.selector;
        vaultSelectors[2] = IssuanceVault.registerTranche.selector;
        vaultSelectors[3] = IssuanceVault.setTrancheConfig.selector;
        vaultSelectors[4] = IssuanceVault.setFeeRates.selector;
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

        IssuanceVault.TrancheInfo[] memory infos = new IssuanceVault.TrancheInfo[](3);
        infos[0] = IssuanceVault.TrancheInfo(address(tranche0), RISK_BPS, true);
        infos[1] = IssuanceVault.TrancheInfo(address(tranche1), RISK_BPS, true);
        infos[2] = IssuanceVault.TrancheInfo(address(tranche2), RISK_BPS, true);
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

        IssuanceVault.TrancheInfo[] memory infos = new IssuanceVault.TrancheInfo[](3);
        infos[0] = IssuanceVault.TrancheInfo(address(tranche0), 2000, true);
        infos[1] = IssuanceVault.TrancheInfo(address(tranche1), 3000, false);
        infos[2] = IssuanceVault.TrancheInfo(address(tranche2), 1000, true);
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

        IssuanceVault.TrancheInfo[] memory infos = new IssuanceVault.TrancheInfo[](3);
        infos[0] = IssuanceVault.TrancheInfo(address(tranche0), 3333, false);
        infos[1] = IssuanceVault.TrancheInfo(address(tranche1), 3333, false);
        infos[2] = IssuanceVault.TrancheInfo(address(tranche2), 3334, false);
        bool[] memory pairFlags = new bool[](3);
        vault.setTrancheConfig(infos, pairFlags, 0);

        uint256 usdcReported = bound(uint256(usdcReportedSeed), 1, 5_000_000e6);

        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(IssuanceVault.TVLZero.selector);
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

        IssuanceVault.TrancheInfo[] memory infos = new IssuanceVault.TrancheInfo[](3);
        infos[0] = IssuanceVault.TrancheInfo(address(tranche0), risk0, (enabledSeed & 0x01) != 0);
        infos[1] = IssuanceVault.TrancheInfo(address(tranche1), risk1, (enabledSeed & 0x02) != 0);
        infos[2] = IssuanceVault.TrancheInfo(address(tranche2), risk2, (enabledSeed & 0x04) != 0);
        bool[] memory pairFlags = new bool[](3);
        vault.setTrancheConfig(infos, pairFlags, baseRewardBps);

        vault.setFeeRates(perfBps, protBps);

        uint256 usdcReported = bound(uint256(usdcReportedSeed), 1, 5_000_000e6);
        uint256 mintedGross = usdcReported * SCALE;
        uint256 expectedPerf = (mintedGross * perfBps) / BPS;
        uint256 expectedProt = (mintedGross * protBps) / BPS;
        uint256 allocatable = mintedGross - expectedPerf - expectedProt;

        uint256 t0Tvl = tranche0.totalAssets();
        uint256 t1Tvl = tranche1.totalAssets();
        uint256 t2Tvl = tranche2.totalAssets();
        bool p0 = infos[0].enabled && t0Tvl != 0;
        bool p1 = infos[1].enabled && t1Tvl != 0;
        bool p2 = infos[2].enabled && t2Tvl != 0;
        bool hasParticipants = p0 || p1 || p2;

        uint256 feeReceiverBefore = mzusd.balanceOf(address(this));
        uint256 supplyBefore = mzusd.totalSupply();
        uint256 b0Before = mzusd.balanceOf(address(tranche0));
        uint256 b1Before = mzusd.balanceOf(address(tranche1));
        uint256 b2Before = mzusd.balanceOf(address(tranche2));

        vm.warp(block.timestamp + 1 days + 1);

        if (!hasParticipants) {
            vm.expectRevert(IssuanceVault.TVLZero.selector);
            vm.prank(navOracle);
            vault.distributeYield(usdcReported);
            return;
        }

        vm.prank(navOracle);
        vault.distributeYield(usdcReported);

        uint256 b0After = mzusd.balanceOf(address(tranche0));
        uint256 b1After = mzusd.balanceOf(address(tranche1));
        uint256 b2After = mzusd.balanceOf(address(tranche2));
        uint256 supplyAfter = mzusd.totalSupply();
        uint256 feeReceiverAfter = mzusd.balanceOf(address(this));
        uint256 d0 = b0After - b0Before;
        uint256 d1 = b1After - b1Before;
        uint256 d2 = b2After - b2Before;

        assertEq(supplyAfter - supplyBefore, mintedGross);
        assertEq(feeReceiverAfter - feeReceiverBefore, expectedPerf + expectedProt);
        assertEq(mzusd.balanceOf(address(vault)), 0);
        assertEq(d0 + d1 + d2, allocatable);
        if (!p0) assertEq(d0, 0);
        if (!p1) assertEq(d1, 0);
        if (!p2) assertEq(d2, 0);
    }

    function testFuzz_DistributeYieldWithPairedConfigMatchesModel(
        uint96 usdcReportedSeed,
        uint16 perfBpsSeed,
        uint16 protBpsSeed,
        uint96 deposit0Seed,
        uint96 deposit1Seed,
        uint96 deposit2Seed,
        uint16 pairRiskSeed,
        uint16 juniorRiskSeed
    ) public {
        uint16 perfBps = uint16(bound(perfBpsSeed, 0, 5_000));
        uint16 protBps = uint16(bound(protBpsSeed, 0, 5_000));
        vm.assume(uint256(perfBps) + uint256(protBps) <= vault.MAX_TOTAL_FEE_BPS());

        uint16 pairRisk = uint16(bound(uint256(pairRiskSeed), 0, BPS));
        uint16 juniorRisk = uint16(bound(uint256(juniorRiskSeed), 0, BPS - pairRisk));
        uint16 baseRewardBps = uint16(BPS - pairRisk - juniorRisk);

        uint256 deposit0 = bound(uint256(deposit0Seed), 0, 3_000_000e6);
        uint256 deposit1 = bound(uint256(deposit1Seed), 0, 3_000_000e6);
        uint256 deposit2 = bound(uint256(deposit2Seed), 0, 3_000_000e6);

        if (deposit0 != 0) _fundAndDeposit(vm.addr(501), tranche0, deposit0);
        if (deposit1 != 0) _fundAndDeposit(vm.addr(502), tranche1, deposit1);
        if (deposit2 != 0) _fundAndDeposit(vm.addr(503), tranche2, deposit2);

        IssuanceVault.TrancheInfo[] memory infos = new IssuanceVault.TrancheInfo[](3);
        infos[0] = IssuanceVault.TrancheInfo(address(tranche0), pairRisk, true);
        infos[1] = IssuanceVault.TrancheInfo(address(tranche1), 0, true);
        infos[2] = IssuanceVault.TrancheInfo(address(tranche2), juniorRisk, true);
        bool[] memory pairFlags = new bool[](3);
        pairFlags[0] = true;
        pairFlags[1] = true;
        vault.setTrancheConfig(infos, pairFlags, baseRewardBps);
        vault.setFeeRates(perfBps, protBps);

        uint256 usdcReported = bound(uint256(usdcReportedSeed), 1, 5_000_000e6);
        uint256 mintedGross = usdcReported * SCALE;
        uint256 allocatable = mintedGross -
            ((mintedGross * perfBps) / BPS) -
            ((mintedGross * protBps) / BPS);

        uint256 b0Before = mzusd.balanceOf(address(tranche0));
        uint256 b1Before = mzusd.balanceOf(address(tranche1));
        uint256 b2Before = mzusd.balanceOf(address(tranche2));
        uint256 pairBefore = b0Before + b1Before;

        vm.warp(block.timestamp + 1 days + 1);
        if (pairBefore + b2Before == 0) {
            vm.expectRevert(IssuanceVault.TVLZero.selector);
            vm.prank(navOracle);
            vault.distributeYield(usdcReported);
            return;
        }

        vm.prank(navOracle);
        vault.distributeYield(usdcReported);

        uint256 d0 = mzusd.balanceOf(address(tranche0)) - b0Before;
        uint256 d1 = mzusd.balanceOf(address(tranche1)) - b1Before;
        uint256 d2 = mzusd.balanceOf(address(tranche2)) - b2Before;
        uint256 pairDelta = d0 + d1;

        assertEq(pairDelta + d2, allocatable);
        assertEq(mzusd.balanceOf(address(vault)), 0);

        if (pairBefore == 0) {
            assertEq(pairDelta, 0);
        }
        if (b2Before == 0 && pairBefore != 0) {
            assertEq(d2, 0);
            assertEq(pairDelta, allocatable);
        }
        if (b0Before == 0) {
            assertEq(d0, 0);
        }
        if (b1Before == 0) {
            assertEq(d1, 0);
        }
        if (b0Before != 0 && b1Before != 0 && pairDelta != 0) {
            uint256 lhs = d0 * pairBefore;
            uint256 rhs = pairDelta * b0Before;
            uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
            assertLe(diff, pairBefore);
        }
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
        _allowlistAccount(user);

        usdc.mint(user, usdcAmount);
        vm.startPrank(user);
        usdc.approve(address(mzusd), usdcAmount);
        mzusd.deposit(usdcAmount);
        mzusd.approve(address(tranche), mzAmount);
        tranche.deposit(mzAmount, user);
        vm.stopPrank();
    }
}
