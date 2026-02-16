// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Tranche} from "contracts/Tranche.sol";
import {LossManager} from "contracts/LossManager.sol";
import {MockNavOracleAutomationRef} from "contracts/test/MockNavOracleAutomationRef.sol";
import {MZUSD} from "contracts/MZUSD.sol";
import {BaseProtocolFuzzTest} from "./BaseProtocolFuzz.t.sol";

contract TrancheLossFuzzTest is BaseProtocolFuzzTest {
    uint64 internal constant BURNER_ROLE = 5;

    Tranche internal junior;
    Tranche internal mezzanine;
    Tranche internal senior;
    Tranche internal directTranche;
    LossManager internal lossManager;
    address internal navOracle;

    function setUp() public override {
        super.setUp();

        junior = _deployTranche(1, false, "Junior Tranche", "JLT");
        mezzanine = _deployTranche(2, false, "Mezzanine Tranche", "MLT");
        senior = _deployTranche(3, false, "Senior Tranche", "SLT");
        directTranche = _deployTranche(4, true, "Direct Tranche", "DLT");

        bytes4[] memory burnSelectors = new bytes4[](1);
        burnSelectors[0] = MZUSD.burn.selector;
        accessManager.setTargetFunctionRole(address(mzusd), burnSelectors, BURNER_ROLE);
        accessManager.grantRole(BURNER_ROLE, address(junior), 0);
        accessManager.grantRole(BURNER_ROLE, address(mezzanine), 0);
        accessManager.grantRole(BURNER_ROLE, address(senior), 0);
        accessManager.grantRole(BURNER_ROLE, address(directTranche), 0);

        address[] memory order = new address[](2);
        order[0] = address(junior);
        order[1] = address(senior);
        bool[] memory pairFlags = new bool[](2);
        pairFlags[0] = false;
        pairFlags[1] = false;

        LossManager lossManagerImpl = new LossManager(address(vault));
        lossManager = LossManager(
            _deployProxy(
                address(lossManagerImpl),
                abi.encodeCall(LossManager.initialize, (order, pairFlags, 0))
            )
        );

        vault.setLossManager(address(lossManager));

        MockNavOracleAutomationRef navRef = new MockNavOracleAutomationRef(
            address(vault),
            address(lossManager),
            address(mzusd)
        );
        navOracle = address(navRef);
        vault.setNavOracle(navOracle);
    }

    function testFuzz_DirectTrancheRequestWithdrawalBurnsSharesAndRedeemsPreviewedAssets(
        uint96 depositUsdcSeed,
        uint96 withdrawalSharesSeed,
        address user
    ) public {
        _assumeValidUser(user);

        uint256 depositUSDC = bound(uint256(depositUsdcSeed), 2, 5_000_000e6);
        uint256 mintedShares = _fundAndDepositToTranche(user, directTranche, depositUSDC);
        uint256 withdrawalShares = bound(uint256(withdrawalSharesSeed), 1, mintedShares);

        uint256 expectedAssetsOut = directTranche.previewRedeem(withdrawalShares);
        uint256 userMzusdBefore = mzusd.balanceOf(user);
        uint256 trancheMzusdBefore = mzusd.balanceOf(address(directTranche));
        vm.prank(user);
        directTranche.requestWithdrawal(withdrawalShares);

        assertEq(directTranche.balanceOf(user), mintedShares - withdrawalShares);
        assertEq(mzusd.balanceOf(user), userMzusdBefore + expectedAssetsOut);
        assertEq(mzusd.balanceOf(address(directTranche)), trancheMzusdBefore - expectedAssetsOut);
    }

    function testFuzz_ApplyLossRevertsWhenOverMaxLossPerTx(
        uint96 limitSeed,
        uint96 excessSeed
    ) public {
        uint256 maxLossUSDC = bound(uint256(limitSeed), 1, 5_000_000e6);
        uint256 excessUSDC = bound(uint256(excessSeed), 1, 5_000_000e6);
        uint256 requestedLossUSDC = maxLossUSDC + excessUSDC;

        lossManager.setMaxLossPerTxUSDC(maxLossUSDC);

        vm.expectRevert(LossManager.LimitExceeded.selector);
        vm.prank(navOracle);
        lossManager.applyLoss(requestedLossUSDC);
    }

    function testFuzz_ApplyLossRevertsWhenLossExceedsTotalSupply(
        uint96 juniorUsdcSeed,
        uint96 excessSeed,
        address juniorDepositor
    ) public {
        _assumeValidUser(juniorDepositor);

        uint256 juniorUSDC = bound(uint256(juniorUsdcSeed), 1, 3_000_000e6);
        _fundAndDepositToTranche(juniorDepositor, junior, juniorUSDC);

        uint256 totalSupplyUSDC = mzusd.totalSupply() / SCALE;
        uint256 excessUSDC = bound(uint256(excessSeed), 1, 3_000_000e6);
        uint256 requestedLossUSDC = totalSupplyUSDC + excessUSDC;

        vm.expectRevert(
            abi.encodeWithSelector(
                LossManager.LossExceedsTotalSupply.selector,
                requestedLossUSDC,
                totalSupplyUSDC
            )
        );
        vm.prank(navOracle);
        lossManager.applyLoss(requestedLossUSDC);
    }

    function testFuzz_ApplyLossSequentialOrderMatchesExpectedBurnAndUncovered(
        uint96 juniorUsdcSeed,
        uint96 seniorUsdcSeed,
        uint96 outsideUsdcSeed,
        uint96 lossUsdcSeed,
        address juniorDepositor,
        address seniorDepositor
    ) public {
        _assumeValidUser(juniorDepositor);
        _assumeValidUser(seniorDepositor);

        uint256 juniorUSDC = bound(uint256(juniorUsdcSeed), 1, 3_000_000e6);
        uint256 seniorUSDC = bound(uint256(seniorUsdcSeed), 1, 3_000_000e6);
        uint256 outsideUSDC = bound(uint256(outsideUsdcSeed), 0, 3_000_000e6);

        _fundAndDepositToTranche(juniorDepositor, junior, juniorUSDC);
        _fundAndDepositToTranche(seniorDepositor, senior, seniorUSDC);

        if (outsideUSDC != 0) {
            vm.prank(address(vault));
            mzusd.mint(address(0xBEEF), outsideUSDC * SCALE);
        }

        uint256 totalSupplyUSDC = mzusd.totalSupply() / SCALE;
        uint256 lossUSDC = bound(uint256(lossUsdcSeed), 1, totalSupplyUSDC);
        uint256 requestedMZ = lossUSDC * SCALE;

        uint256 juniorBefore = mzusd.balanceOf(address(junior));
        uint256 seniorBefore = mzusd.balanceOf(address(senior));
        uint256 supplyBefore = mzusd.totalSupply();

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        lossManager.applyLoss(lossUSDC);

        uint256 burnJunior = _min(juniorBefore, requestedMZ);
        uint256 burnSenior = _min(seniorBefore, requestedMZ - burnJunior);
        uint256 expectedBurn = burnJunior + burnSenior;
        uint256 expectedUncovered = requestedMZ - expectedBurn;

        assertEq(mzusd.balanceOf(address(junior)), juniorBefore - burnJunior);
        assertEq(mzusd.balanceOf(address(senior)), seniorBefore - burnSenior);
        assertEq(supplyBefore - mzusd.totalSupply(), expectedBurn);
        assertEq(lossManager.lastUncoveredLossMZ(), expectedUncovered);
        assertEq(lossManager.totalUncoveredLossMZ(), expectedUncovered);
    }

    function testFuzz_ApplyLossPairModeSplitsProportionallyAndTracksUncovered(
        uint96 juniorUsdcSeed,
        uint96 seniorUsdcSeed,
        uint96 outsideUsdcSeed,
        uint96 lossUsdcSeed,
        address juniorDepositor,
        address seniorDepositor
    ) public {
        _assumeValidUser(juniorDepositor);
        _assumeValidUser(seniorDepositor);

        uint256 juniorUSDC = bound(uint256(juniorUsdcSeed), 1, 3_000_000e6);
        uint256 seniorUSDC = bound(uint256(seniorUsdcSeed), 1, 3_000_000e6);
        uint256 outsideUSDC = bound(uint256(outsideUsdcSeed), 0, 3_000_000e6);

        _fundAndDepositToTranche(juniorDepositor, junior, juniorUSDC);
        _fundAndDepositToTranche(seniorDepositor, senior, seniorUSDC);

        address[] memory order = new address[](2);
        order[0] = address(junior);
        order[1] = address(senior);
        bool[] memory pairFlags = new bool[](2);
        pairFlags[0] = true;
        pairFlags[1] = true;
        lossManager.setTrancheOrderAndPairs(order, pairFlags);

        if (outsideUSDC != 0) {
            vm.prank(address(vault));
            mzusd.mint(address(0xCAFE), outsideUSDC * SCALE);
        }

        uint256 totalSupplyUSDC = mzusd.totalSupply() / SCALE;
        uint256 lossUSDC = bound(uint256(lossUsdcSeed), 1, totalSupplyUSDC);
        uint256 requestedMZ = lossUSDC * SCALE;

        uint256 juniorBefore = mzusd.balanceOf(address(junior));
        uint256 seniorBefore = mzusd.balanceOf(address(senior));
        uint256 pairTVL = juniorBefore + seniorBefore;
        uint256 supplyBefore = mzusd.totalSupply();

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        lossManager.applyLoss(lossUSDC);

        uint256 lossForPair = _min(requestedMZ, pairTVL);
        uint256 burnedJunior = juniorBefore - mzusd.balanceOf(address(junior));
        uint256 burnedSenior = seniorBefore - mzusd.balanceOf(address(senior));
        uint256 expectedUncovered = requestedMZ - lossForPair;

        assertEq(burnedJunior + burnedSenior, lossForPair);
        assertLe(burnedJunior, juniorBefore);
        assertLe(burnedSenior, seniorBefore);
        assertEq(supplyBefore - mzusd.totalSupply(), lossForPair);
        assertEq(lossManager.lastUncoveredLossMZ(), expectedUncovered);

        if (lossForPair != 0 && pairTVL != 0 && lossForPair < pairTVL) {
            uint256 lhs = burnedJunior * pairTVL;
            uint256 rhs = lossForPair * juniorBefore;
            uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
            // Integer split is floor-based with up to 1 unit remainder assigned inside the pair.
            assertLe(diff, pairTVL);
        }
    }

    function testFuzz_ApplyLossSequentialAcrossThreeTranchesMatchesExpected(
        uint96 juniorUsdcSeed,
        uint96 mezzanineUsdcSeed,
        uint96 seniorUsdcSeed,
        uint96 outsideUsdcSeed,
        uint96 lossUsdcSeed,
        address juniorDepositor,
        address mezzDepositor,
        address seniorDepositor
    ) public {
        _assumeValidUser(juniorDepositor);
        _assumeValidUser(mezzDepositor);
        _assumeValidUser(seniorDepositor);

        uint256 juniorUSDC = bound(uint256(juniorUsdcSeed), 1, 2_000_000e6);
        uint256 mezzanineUSDC = bound(uint256(mezzanineUsdcSeed), 1, 2_000_000e6);
        uint256 seniorUSDC = bound(uint256(seniorUsdcSeed), 1, 2_000_000e6);
        uint256 outsideUSDC = bound(uint256(outsideUsdcSeed), 0, 2_000_000e6);

        _fundAndDepositToTranche(juniorDepositor, junior, juniorUSDC);
        _fundAndDepositToTranche(mezzDepositor, mezzanine, mezzanineUSDC);
        _fundAndDepositToTranche(seniorDepositor, senior, seniorUSDC);

        address[] memory order = new address[](3);
        order[0] = address(junior);
        order[1] = address(mezzanine);
        order[2] = address(senior);
        bool[] memory pairFlags = new bool[](3);
        lossManager.setTrancheOrderAndPairs(order, pairFlags);

        if (outsideUSDC != 0) {
            vm.prank(address(vault));
            mzusd.mint(address(0xDEAD), outsideUSDC * SCALE);
        }

        uint256 totalSupplyUSDC = mzusd.totalSupply() / SCALE;
        uint256 lossUSDC = bound(uint256(lossUsdcSeed), 1, totalSupplyUSDC);
        uint256 requestedMZ = lossUSDC * SCALE;

        uint256 juniorBefore = mzusd.balanceOf(address(junior));
        uint256 mezzanineBefore = mzusd.balanceOf(address(mezzanine));
        uint256 seniorBefore = mzusd.balanceOf(address(senior));
        uint256 supplyBefore = mzusd.totalSupply();

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        lossManager.applyLoss(lossUSDC);

        uint256 burnJunior = _min(juniorBefore, requestedMZ);
        uint256 remainingAfterJunior = requestedMZ - burnJunior;
        uint256 burnMezz = _min(mezzanineBefore, remainingAfterJunior);
        uint256 remainingAfterMezz = remainingAfterJunior - burnMezz;
        uint256 burnSenior = _min(seniorBefore, remainingAfterMezz);

        uint256 expectedBurn = burnJunior + burnMezz + burnSenior;
        uint256 expectedUncovered = requestedMZ - expectedBurn;

        assertEq(mzusd.balanceOf(address(junior)), juniorBefore - burnJunior);
        assertEq(mzusd.balanceOf(address(mezzanine)), mezzanineBefore - burnMezz);
        assertEq(mzusd.balanceOf(address(senior)), seniorBefore - burnSenior);
        assertEq(supplyBefore - mzusd.totalSupply(), expectedBurn);
        assertEq(lossManager.lastUncoveredLossMZ(), expectedUncovered);
    }

    function testFuzz_ApplyLossPairThenSequentialTailMatchesExpected(
        uint96 juniorUsdcSeed,
        uint96 mezzanineUsdcSeed,
        uint96 seniorUsdcSeed,
        uint96 outsideUsdcSeed,
        uint96 lossUsdcSeed,
        address juniorDepositor,
        address mezzDepositor,
        address seniorDepositor
    ) public {
        _assumeValidUser(juniorDepositor);
        _assumeValidUser(mezzDepositor);
        _assumeValidUser(seniorDepositor);

        uint256 juniorUSDC = bound(uint256(juniorUsdcSeed), 1, 2_000_000e6);
        uint256 mezzanineUSDC = bound(uint256(mezzanineUsdcSeed), 1, 2_000_000e6);
        uint256 seniorUSDC = bound(uint256(seniorUsdcSeed), 1, 2_000_000e6);
        uint256 outsideUSDC = bound(uint256(outsideUsdcSeed), 0, 2_000_000e6);

        _fundAndDepositToTranche(juniorDepositor, junior, juniorUSDC);
        _fundAndDepositToTranche(mezzDepositor, mezzanine, mezzanineUSDC);
        _fundAndDepositToTranche(seniorDepositor, senior, seniorUSDC);

        address[] memory order = new address[](3);
        order[0] = address(junior);
        order[1] = address(mezzanine);
        order[2] = address(senior);
        bool[] memory pairFlags = new bool[](3);
        pairFlags[0] = true;
        pairFlags[1] = true;
        lossManager.setTrancheOrderAndPairs(order, pairFlags);

        if (outsideUSDC != 0) {
            vm.prank(address(vault));
            mzusd.mint(address(0xABCD), outsideUSDC * SCALE);
        }

        uint256 totalSupplyUSDC = mzusd.totalSupply() / SCALE;
        uint256 lossUSDC = bound(uint256(lossUsdcSeed), 1, totalSupplyUSDC);
        uint256 requestedMZ = lossUSDC * SCALE;

        uint256 juniorBefore = mzusd.balanceOf(address(junior));
        uint256 mezzanineBefore = mzusd.balanceOf(address(mezzanine));
        uint256 seniorBefore = mzusd.balanceOf(address(senior));
        uint256 supplyBefore = mzusd.totalSupply();

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(navOracle);
        lossManager.applyLoss(lossUSDC);

        uint256 pairTVL = juniorBefore + mezzanineBefore;
        uint256 lossForPair = _min(requestedMZ, pairTVL);
        (uint256 burnJunior, uint256 burnMezzanine) = _splitPairExpected(
            lossForPair,
            juniorBefore,
            mezzanineBefore,
            pairTVL
        );

        uint256 remainingAfterPair = requestedMZ - burnJunior - burnMezzanine;
        uint256 burnSenior = _min(seniorBefore, remainingAfterPair);

        uint256 expectedBurn = burnJunior + burnMezzanine + burnSenior;
        uint256 expectedUncovered = requestedMZ - expectedBurn;

        assertEq(mzusd.balanceOf(address(junior)), juniorBefore - burnJunior);
        assertEq(mzusd.balanceOf(address(mezzanine)), mezzanineBefore - burnMezzanine);
        assertEq(mzusd.balanceOf(address(senior)), seniorBefore - burnSenior);
        assertEq(supplyBefore - mzusd.totalSupply(), expectedBurn);
        assertEq(lossManager.lastUncoveredLossMZ(), expectedUncovered);
        assertEq(lossManager.totalUncoveredLossMZ(), expectedUncovered);
    }

    function _deployTranche(
        uint256 trancheId,
        bool directMode,
        string memory name,
        string memory symbol
    ) internal returns (Tranche tranche) {
        Tranche trancheImpl = new Tranche(address(vault), directMode);
        tranche = Tranche(
            _deployProxy(
                address(trancheImpl),
                abi.encodeCall(Tranche.initialize, (trancheId, 0, name, symbol))
            )
        );
    }

    function _fundAndDepositToTranche(
        address user,
        Tranche tranche,
        uint256 usdcAmount
    ) internal returns (uint256 mintedShares) {
        uint256 mintedMZ = usdcAmount * SCALE;

        usdc.mint(user, usdcAmount);
        vm.startPrank(user);
        usdc.approve(address(mzusd), usdcAmount);
        mzusd.deposit(usdcAmount);
        mzusd.approve(address(tranche), mintedMZ);
        mintedShares = tranche.deposit(mintedMZ, user);
        vm.stopPrank();
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _splitPairExpected(
        uint256 lossForPair,
        uint256 tvl0,
        uint256 tvl1,
        uint256 pairTVL
    ) internal pure returns (uint256 burn0, uint256 burn1) {
        if (lossForPair == 0 || pairTVL == 0) {
            return (0, 0);
        }

        burn0 = (lossForPair * tvl0) / pairTVL;
        burn1 = (lossForPair * tvl1) / pairTVL;

        uint256 rem = lossForPair - burn0 - burn1;
        if (rem == 0) {
            return (burn0, burn1);
        }

        uint256 cap0 = tvl0 - burn0;
        if (rem > cap0) {
            burn0 += cap0;
            burn1 += rem - cap0;
        } else {
            burn0 += rem;
        }
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
        vm.assume(user != address(lossManager));
        vm.assume(user != address(junior));
        vm.assume(user != address(mezzanine));
        vm.assume(user != address(senior));
        vm.assume(user != address(directTranche));
    }
}
