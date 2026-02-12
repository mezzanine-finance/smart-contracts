// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Tranche} from "contracts/Tranche.sol";
import {Vault} from "contracts/Vault.sol";
import {MockLossManagerRef} from "contracts/test/MockLossManagerRef.sol";
import {MockNavOracleAutomationRef} from "contracts/test/MockNavOracleAutomationRef.sol";
import {BaseProtocolFuzzTest} from "./BaseProtocolFuzz.t.sol";

contract TrancheStreamingFuzzTest is BaseProtocolFuzzTest {
    Tranche internal tranche;
    address internal navOracle;

    function setUp() public override {
        super.setUp();

        uint64 adminRole = accessManager.ADMIN_ROLE();
        bytes4[] memory vaultSelectors = new bytes4[](4);
        vaultSelectors[0] = Vault.setLossManager.selector;
        vaultSelectors[1] = Vault.setNavOracle.selector;
        vaultSelectors[2] = Vault.addTranche.selector;
        vaultSelectors[3] = Vault.setYieldDistribution.selector;
        accessManager.setTargetFunctionRole(address(vault), vaultSelectors, adminRole);

        tranche = _deployTranche(1, "Streaming Tranche", "STR");

        MockLossManagerRef lossRef = new MockLossManagerRef(address(vault), address(mzusd));
        vault.setLossManager(address(lossRef));

        MockNavOracleAutomationRef navRef = new MockNavOracleAutomationRef(
            address(vault),
            address(lossRef),
            address(mzusd)
        );
        navOracle = address(navRef);
        vault.setNavOracle(navOracle);

        vault.addTranche(address(tranche));

        uint16[] memory riskPremiums = new uint16[](1);
        bool[] memory enabled = new bool[](1);
        enabled[0] = true;
        vault.setYieldDistribution(10_000, riskPremiums, enabled);
    }

    function testFuzz_NotifyYieldStreamsLinearlyIntoTotalAssets(
        uint96 depositSeed,
        uint96 yieldSeed,
        uint40 elapsedSeed,
        address user
    ) public {
        _assumeValidUser(user);

        uint256 depositUSDC = bound(uint256(depositSeed), 1, 5_000_000e6);
        uint256 reportedYieldUSDC = bound(uint256(yieldSeed), 1, 5_000_000e6);
        uint256 expectedYieldMZ = reportedYieldUSDC * SCALE;

        _fundAndDeposit(user, depositUSDC);
        uint256 assetsBefore = tranche.totalAssets();

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        vault.distributeYield(reportedYieldUSDC);

        assertEq(tranche.totalAssets(), assetsBefore);

        uint256 start = tranche.yieldStreamStart();
        uint256 end = tranche.yieldStreamEnd();
        uint256 duration = end - start;
        uint256 elapsed = bound(uint256(elapsedSeed), 0, duration);

        vm.warp(start + elapsed);
        uint256 expectedAtElapsed = assetsBefore + ((expectedYieldMZ * elapsed) / duration);
        assertEq(tranche.totalAssets(), expectedAtElapsed);

        vm.warp(end);
        assertEq(tranche.totalAssets(), assetsBefore + expectedYieldMZ);
    }

    function testFuzz_NotifyYieldRevertsWhileStreamActive(
        uint96 depositSeed,
        uint96 yieldSeed,
        uint96 secondYieldSeed,
        address user
    ) public {
        _assumeValidUser(user);

        uint256 depositUSDC = bound(uint256(depositSeed), 1, 5_000_000e6);
        uint256 reportedYieldUSDC = bound(uint256(yieldSeed), 1, 5_000_000e6);
        uint256 secondYieldMZ = bound(uint256(secondYieldSeed), 1, 5_000_000e6) * SCALE;

        _fundAndDeposit(user, depositUSDC);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        vault.distributeYield(reportedYieldUSDC);

        vm.prank(address(vault));
        vm.expectRevert(Tranche.YieldStreamIsActive.selector);
        tranche.notifyYield(secondYieldMZ);
    }

    function testFuzz_NotifyYieldCanRestartAfterPreviousStreamEnds(
        uint96 depositSeed,
        uint96 yieldSeed,
        uint96 nextYieldSeed,
        address user
    ) public {
        _assumeValidUser(user);

        uint256 depositUSDC = bound(uint256(depositSeed), 1, 5_000_000e6);
        uint256 reportedYieldUSDC = bound(uint256(yieldSeed), 1, 5_000_000e6);
        uint256 nextYieldMZ = bound(uint256(nextYieldSeed), 1, 5_000_000e6) * SCALE;

        _fundAndDeposit(user, depositUSDC);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        vault.distributeYield(reportedYieldUSDC);

        vm.warp(uint256(tranche.yieldStreamEnd()) + 1);

        vm.prank(address(vault));
        mzusd.mint(address(tranche), nextYieldMZ);

        vm.prank(address(vault));
        tranche.notifyYield(nextYieldMZ);

        assertEq(tranche.yieldStreamingAmount(), nextYieldMZ);
        assertEq(uint256(tranche.yieldStreamEnd()) - uint256(tranche.yieldStreamStart()), 1 days);
    }

    function testFuzz_FinalizeAndClaimDuringActiveStreamConservesReservedAssets(
        uint96 depositASeed,
        uint96 depositBSeed,
        uint96 withdrawASharesSeed,
        uint96 withdrawBSharesSeed,
        uint96 yieldSeed,
        uint40 elapsedSeed,
        address userA,
        address userB
    ) public {
        _assumeValidUser(userA);
        _assumeValidUser(userB);
        vm.assume(userA != userB);

        uint256 depositAUSDC = bound(uint256(depositASeed), 2, 3_000_000e6);
        uint256 depositBUSDC = bound(uint256(depositBSeed), 2, 3_000_000e6);

        _fundAndDeposit(userA, depositAUSDC);
        _fundAndDeposit(userB, depositBUSDC);

        uint256 sharesA = tranche.balanceOf(userA);
        uint256 sharesB = tranche.balanceOf(userB);
        uint256 withdrawAShares = bound(uint256(withdrawASharesSeed), 1, sharesA);
        uint256 withdrawBShares = bound(uint256(withdrawBSharesSeed), 1, sharesB);

        uint256 targetEpoch = vault.currentEpochId();

        vm.prank(userA);
        tranche.requestWithdrawal(withdrawAShares);
        vm.prank(userB);
        tranche.requestWithdrawal(withdrawBShares);

        uint256 reportedYieldUSDC = bound(uint256(yieldSeed), 1, 3_000_000e6);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        vault.distributeYield(reportedYieldUSDC);

        uint256 streamStart = tranche.yieldStreamStart();
        uint256 streamEnd = tranche.yieldStreamEnd();
        uint256 streamDuration = streamEnd - streamStart;
        vm.assume(streamDuration > 1);

        uint256 elapsed = bound(uint256(elapsedSeed), 0, streamDuration - 1);
        vm.warp(streamStart + elapsed);

        tranche.finalizeEpoch(targetEpoch);

        (
            uint256 umbrellaShares,
            bool isFinalized,
            uint256 finalizedShares,
            uint256 finalizedAssets
        ) = tranche.getEpochInfo(targetEpoch);
        assertEq(umbrellaShares, 0);
        assertTrue(isFinalized);
        assertEq(finalizedShares, withdrawAShares + withdrawBShares);
        assertEq(tranche.reservedAssets(), finalizedAssets);

        uint256 expectedClaimA = (withdrawAShares * finalizedAssets) / finalizedShares;
        uint256 expectedClaimB = (withdrawBShares * finalizedAssets) / finalizedShares;

        uint256 userABefore = mzusd.balanceOf(userA);
        uint256 userBBefore = mzusd.balanceOf(userB);

        vm.prank(userA);
        tranche.claim(targetEpoch);
        vm.prank(userB);
        tranche.claim(targetEpoch);

        assertEq(mzusd.balanceOf(userA) - userABefore, expectedClaimA);
        assertEq(mzusd.balanceOf(userB) - userBBefore, expectedClaimB);

        uint256 expectedDust = finalizedAssets - expectedClaimA - expectedClaimB;
        assertEq(tranche.reservedAssets(), expectedDust);
        assertGe(mzusd.balanceOf(address(tranche)), tranche.reservedAssets());
    }

    function _deployTranche(
        uint256 trancheId,
        string memory name,
        string memory symbol
    ) internal returns (Tranche deployed) {
        Tranche trancheImpl = new Tranche(address(vault), false);
        deployed = Tranche(
            _deployProxy(
                address(trancheImpl),
                abi.encodeCall(Tranche.initialize, (trancheId, 0, name, symbol))
            )
        );
    }

    function _fundAndDeposit(address user, uint256 usdcAmount) internal {
        uint256 mzAmount = usdcAmount * SCALE;

        usdc.mint(user, usdcAmount);
        vm.startPrank(user);
        usdc.approve(address(mzusd), usdcAmount);
        mzusd.deposit(usdcAmount);
        mzusd.approve(address(tranche), mzAmount);
        tranche.deposit(mzAmount, user);
        vm.stopPrank();
    }

    function _assumeValidUser(address user) internal view {
        vm.assume(user != address(0));
        vm.assume(user != address(this));
        vm.assume(user != address(usdc));
        vm.assume(user != address(mzusd));
        vm.assume(user != address(vault));
        vm.assume(user != address(reservoir));
        vm.assume(user != address(accessManager));
        vm.assume(user != address(pauseManager));
        vm.assume(user != address(tranche));
    }
}
