// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Tranche} from "contracts/Tranche.sol";
import {IssuanceVault} from "contracts/IssuanceVault.sol";
import {MockLossManagerRef} from "contracts/test/MockLossManagerRef.sol";
import {MockNavOracleAutomationRef} from "contracts/test/MockNavOracleAutomationRef.sol";
import {BaseProtocolFuzzTest} from "./BaseProtocolFuzz.t.sol";

contract TrancheUnstakeSlashingFuzzTest is BaseProtocolFuzzTest {
    Tranche internal tranche;
    address internal navOracle;

    function setUp() public override {
        super.setUp();

        uint64 adminRole = accessManager.ADMIN_ROLE();
        bytes4[] memory vaultSelectors = new bytes4[](4);
        vaultSelectors[0] = IssuanceVault.setLossManager.selector;
        vaultSelectors[1] = IssuanceVault.setNavOracle.selector;
        vaultSelectors[2] = IssuanceVault.registerTranche.selector;
        vaultSelectors[3] = IssuanceVault.setTrancheConfig.selector;
        accessManager.setTargetFunctionRole(address(vault), vaultSelectors, adminRole);

        tranche = _deployTranche(1, "Slashing Tranche", "SLH");

        MockLossManagerRef lossRef = new MockLossManagerRef(address(vault), address(mzusd));
        vault.setLossManager(address(lossRef));

        MockNavOracleAutomationRef navRef = new MockNavOracleAutomationRef(
            address(vault),
            address(lossRef),
            address(mzusd)
        );
        navOracle = address(navRef);
        vault.setNavOracle(navOracle);

        vault.registerTranche(address(tranche));

        IssuanceVault.TrancheInfo[] memory infos = new IssuanceVault.TrancheInfo[](1);
        infos[0] = IssuanceVault.TrancheInfo(address(tranche), 0, true);
        bool[] memory pairFlags = new bool[](1);
        vault.setTrancheConfig(infos, pairFlags, 10_000);
    }

    function testFuzz_ClaimAppliesConfiguredYieldSlashAndReleasesFullReserve(
        uint96 depositASeed,
        uint96 depositBSeed,
        uint96 yieldSeed,
        uint16 slashBpsSeed,
        uint96 withdrawSeed,
        address userA,
        address userB
    ) public {
        _assumeValidUser(userA);
        _assumeValidUser(userB);
        vm.assume(userA != userB);

        uint256 depositAUSDC = bound(uint256(depositASeed), 2, 3_000_000e6);
        uint256 depositBUSDC = bound(uint256(depositBSeed), 2, 3_000_000e6);
        uint256 reportedYieldUSDC = bound(uint256(yieldSeed), 1, 3_000_000e6);
        uint256 slashBps = bound(uint256(slashBpsSeed), 1, BPS - 1);

        _fundAndDeposit(userA, depositAUSDC);
        _fundAndDeposit(userB, depositBUSDC);

        tranche.setUnstakeYieldReductionBps(slashBps);

        _advanceEpochAndDistributeYield(reportedYieldUSDC);

        uint256 targetEpoch = vault.currentEpochId();
        uint256 sharesA = tranche.balanceOf(userA);
        uint256 withdrawShares = bound(uint256(withdrawSeed), 1, sharesA);

        vm.prank(userA);
        tranche.requestWithdrawal(withdrawShares);

        uint256 snapshotPrice = tranche.userSnapshotPrice(userA, targetEpoch);

        _advanceEpochAndDistributeYield(0);

        tranche.finalizeEpoch(targetEpoch);

        (uint256 totalShares, uint256 totalAssets, uint256 finalizationPrice) = tranche
            .finalizedEpochs(targetEpoch);
        uint256 fullUserAssets = (withdrawShares * totalAssets) / totalShares;

        uint256 slashAmount = _computeSlash(
            finalizationPrice,
            snapshotPrice,
            slashBps,
            withdrawShares,
            _shareUnit()
        );
        if (slashAmount > fullUserAssets) {
            slashAmount = fullUserAssets;
        }

        uint256 expectedAssetsOut = fullUserAssets - slashAmount;
        uint256 reservedBefore = tranche.reservedAssets();
        uint256 userBefore = mzusd.balanceOf(userA);

        vm.prank(userA);
        tranche.claim(userA, targetEpoch);

        uint256 userReceived = mzusd.balanceOf(userA) - userBefore;
        assertEq(userReceived, expectedAssetsOut);
        assertEq(tranche.reservedAssets(), reservedBefore - fullUserAssets);

        if (slashAmount != 0) {
            assertLt(expectedAssetsOut, fullUserAssets);
        }
    }

    function testFuzz_GetUserEpochInfoMatchesClaimMathWithSlashing(
        uint96 depositASeed,
        uint96 depositBSeed,
        uint96 yieldSeed,
        uint16 slashBpsSeed,
        uint96 withdrawSeed,
        address userA,
        address userB
    ) public {
        _assumeValidUser(userA);
        _assumeValidUser(userB);
        vm.assume(userA != userB);

        uint256 depositAUSDC = bound(uint256(depositASeed), 2, 3_000_000e6);
        uint256 depositBUSDC = bound(uint256(depositBSeed), 2, 3_000_000e6);
        uint256 reportedYieldUSDC = bound(uint256(yieldSeed), 1, 3_000_000e6);
        uint256 slashBps = bound(uint256(slashBpsSeed), 0, BPS - 1);

        _fundAndDeposit(userA, depositAUSDC);
        _fundAndDeposit(userB, depositBUSDC);

        tranche.setUnstakeYieldReductionBps(slashBps);

        _advanceEpochAndDistributeYield(reportedYieldUSDC);

        uint256 targetEpoch = vault.currentEpochId();
        uint256 sharesA = tranche.balanceOf(userA);
        uint256 withdrawShares = bound(uint256(withdrawSeed), 1, sharesA);

        vm.prank(userA);
        tranche.requestWithdrawal(withdrawShares);

        uint256 snapshotPrice = tranche.userSnapshotPrice(userA, targetEpoch);

        _advanceEpochAndDistributeYield(0);

        tranche.finalizeEpoch(targetEpoch);

        (uint256 totalShares, uint256 totalAssets, uint256 finalizationPrice) = tranche
            .finalizedEpochs(targetEpoch);

        uint256 fullUserAssets = (withdrawShares * totalAssets) / totalShares;
        uint256 slashAmount = _computeSlash(
            finalizationPrice,
            snapshotPrice,
            slashBps,
            withdrawShares,
            _shareUnit()
        );
        if (slashAmount > fullUserAssets) {
            slashAmount = fullUserAssets;
        }
        uint256 expectedClaimable = fullUserAssets - slashAmount;

        (uint256 pendingShares, uint256 claimablePreview) = tranche.getUserEpochInfo(
            userA,
            targetEpoch
        );
        assertEq(pendingShares, withdrawShares);
        assertEq(claimablePreview, expectedClaimable);

        uint256 userBefore = mzusd.balanceOf(userA);
        vm.prank(userA);
        tranche.claim(userA, targetEpoch);

        uint256 userReceived = mzusd.balanceOf(userA) - userBefore;
        assertEq(userReceived, claimablePreview);
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
        _allowlistAccount(user);

        usdc.mint(user, usdcAmount);
        vm.startPrank(user);
        usdc.approve(address(mzusd), usdcAmount);
        mzusd.deposit(usdcAmount);
        mzusd.approve(address(tranche), mzAmount);
        tranche.deposit(mzAmount, user);
        vm.stopPrank();
    }

    function _computeSlash(
        uint256 finalizationPrice,
        uint256 snapshotPrice,
        uint256 slashBps,
        uint256 userShares,
        uint256 shareUnit
    ) internal pure returns (uint256 slashAmount) {
        if (snapshotPrice == 0 || slashBps == 0 || finalizationPrice <= snapshotPrice) {
            return 0;
        }

        uint256 yieldPerShare = finalizationPrice - snapshotPrice;
        slashAmount = (yieldPerShare * slashBps * userShares) / BPS / shareUnit;
    }

    function _advanceEpochAndDistributeYield(uint256 reportedYieldUSDC) internal {
        vm.warp(block.timestamp + vault.epochDuration() + 1);
        vm.prank(navOracle);
        vault.distributeYield(reportedYieldUSDC);
    }

    function _shareUnit() internal view returns (uint256) {
        return 10 ** uint256(tranche.decimals());
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
        vm.assume(user != address(allowlist));
        vm.assume(user != address(sanctionsList));
        vm.assume(user != address(tranche));
        vm.assume(user != navOracle);
    }
}
