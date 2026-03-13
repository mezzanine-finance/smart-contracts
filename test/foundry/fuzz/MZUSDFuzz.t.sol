// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";
import {MZUSD} from "contracts/MZUSD.sol";
import {MZUSDNettingHelper} from "contracts/test/MZUSDNettingHelper.sol";
import {Allowlist} from "contracts/Allowlist.sol";
import {BaseProtocolFuzzTest} from "./BaseProtocolFuzz.t.sol";

contract MZUSDFuzzTest is BaseProtocolFuzzTest {
    function testFuzz_DepositMintsOneToOneAndMovesUSDCToVault(
        uint96 depositSeed,
        address user
    ) public {
        _assumeValidUser(user);
        _allowlistAccount(user);
        uint256 depositUSDC = bound(uint256(depositSeed), 1, 5_000_000e6);

        uint256 vaultBefore = usdc.balanceOf(address(vault));

        usdc.mint(user, depositUSDC);
        vm.startPrank(user);
        usdc.approve(address(mzusd), depositUSDC);
        mzusd.deposit(depositUSDC);
        vm.stopPrank();

        assertEq(mzusd.balanceOf(user), depositUSDC * SCALE);
        assertEq(usdc.balanceOf(user), 0);
        assertEq(usdc.balanceOf(address(vault)), vaultBefore + depositUSDC);
    }

    function testFuzz_RequestWithdrawalBurnsIntegralAndKeepsDust(
        uint96 depositSeed,
        uint96 withdrawSeed,
        uint40 dustSeed,
        address user
    ) public {
        _assumeValidUser(user);
        _allowlistAccount(user);

        uint256 depositUSDC = bound(uint256(depositSeed), 2, 5_000_000e6);
        uint256 withdrawUSDC = bound(uint256(withdrawSeed), 1, depositUSDC - 1);
        uint256 dustMZ = bound(uint256(dustSeed), 0, SCALE - 1);

        usdc.mint(user, depositUSDC);

        vm.startPrank(user);
        usdc.approve(address(mzusd), depositUSDC);
        mzusd.deposit(depositUSDC);

        uint256 supplyBeforeWithdraw = mzusd.totalSupply();
        uint256 requestMZ = (withdrawUSDC * SCALE) + dustMZ;
        mzusd.requestWithdrawal(requestMZ);
        vm.stopPrank();

        assertEq(mzusd.balanceOf(user), (depositUSDC * SCALE) - (withdrawUSDC * SCALE));
        assertEq(usdc.balanceOf(user), withdrawUSDC);
        assertEq(mzusd.totalSupply(), supplyBeforeWithdraw - (withdrawUSDC * SCALE));
    }

    function testFuzz_TooSmallWithdrawalAlwaysReverts(uint96 tinySeed, address user) public {
        _assumeValidUser(user);
        _allowlistAccount(user);
        uint256 tinyMZ = bound(uint256(tinySeed), 1, SCALE - 1);

        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(MZUSD.TooSmallWithdrawalAmount.selector, tinyMZ, 0));
        mzusd.requestWithdrawal(tinyMZ);
        vm.stopPrank();
    }

    function testFuzz_DepositAndWithdrawInOneTxDoesNotConsumeRedemptionCap(
        uint96 depositSeed,
        uint96 withdrawSeed,
        uint96 capSeed
    ) public {
        uint256 depositUSDC = bound(uint256(depositSeed), 2, 5_000_000e6);
        uint256 withdrawUSDC = bound(uint256(withdrawSeed), 2, depositUSDC);
        uint256 capUSDC = bound(uint256(capSeed), 1, withdrawUSDC - 1);

        MZUSDNettingHelper helper = new MZUSDNettingHelper();
        _allowlistAccount(address(helper));

        mzusd.setGlobalRedemptionCap(capUSDC);
        usdc.mint(address(helper), depositUSDC);

        uint256 usedBefore = mzusd.windowUsedUSDC();
        helper.depositAndWithdraw(address(mzusd), address(usdc), depositUSDC, withdrawUSDC * SCALE);

        assertEq(mzusd.windowUsedUSDC(), usedBefore);
        assertEq(usdc.balanceOf(address(helper)), withdrawUSDC);
        assertEq(mzusd.balanceOf(address(helper)), (depositUSDC - withdrawUSDC) * SCALE);
    }

    function testFuzz_AtomicNettingConsumesOnlyExcessOverSameTxDeposits(
        uint96 depositSeed,
        uint96 excessWithdrawalSeed,
        uint96 capSeed
    ) public {
        uint256 depositUSDC = bound(uint256(depositSeed), 1, 5_000_000e6);
        uint256 excessWithdrawalUSDC = bound(uint256(excessWithdrawalSeed), 1, 5_000_000e6);
        uint256 capUSDC = bound(uint256(capSeed), 1, 5_000_000e6);

        MZUSDNettingHelper helper = new MZUSDNettingHelper();
        _allowlistAccount(address(helper));
        uint256 withdrawUSDC = depositUSDC + excessWithdrawalUSDC;
        uint256 withdrawMZ = withdrawUSDC * SCALE;

        vm.prank(address(vault));
        mzusd.mint(address(helper), excessWithdrawalUSDC * SCALE);
        mzusd.setGlobalRedemptionCap(capUSDC);
        usdc.mint(address(helper), depositUSDC);
        usdc.mint(address(reservoir), excessWithdrawalUSDC);

        if (excessWithdrawalUSDC > capUSDC) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    MZUSD.GlobalRedemptionCapExceeded.selector,
                    capUSDC,
                    excessWithdrawalUSDC,
                    excessWithdrawalUSDC
                )
            );
            helper.depositAndWithdraw(address(mzusd), address(usdc), depositUSDC, withdrawMZ);
            return;
        }

        helper.depositAndWithdraw(address(mzusd), address(usdc), depositUSDC, withdrawMZ);
        assertEq(mzusd.windowUsedUSDC(), excessWithdrawalUSDC);
    }

    function testFuzz_RedemptionWindowRollsOverAndAppliesQueuedDuration(
        uint96 capSeed,
        uint96 firstWithdrawSeed,
        uint96 secondWithdrawSeed,
        uint32 nextDurationSeed,
        address user
    ) public {
        _assumeValidUser(user);
        _allowlistAccount(user);

        uint256 capUSDC = bound(uint256(capSeed), 2, 5_000_000e6);
        uint256 firstWithdrawUSDC = bound(uint256(firstWithdrawSeed), 1, capUSDC);
        uint256 secondWithdrawUSDC = bound(uint256(secondWithdrawSeed), 1, capUSDC);

        uint32 minDuration = mzusd.MIN_REDEMPTION_WINDOW_DURATION();
        uint32 maxDuration = mzusd.MAX_REDEMPTION_WINDOW_DURATION();
        uint32 nextDuration = uint32(
            bound(uint256(nextDurationSeed), uint256(minDuration) + 1, uint256(maxDuration))
        );

        uint32 initialDuration = mzusd.redemptionWindowDuration();
        uint256 totalWithdrawUSDC = firstWithdrawUSDC + secondWithdrawUSDC;

        mzusd.setGlobalRedemptionCap(capUSDC);
        mzusd.setRedemptionWindowDuration(nextDuration);

        vm.prank(address(vault));
        mzusd.mint(user, totalWithdrawUSDC * SCALE);
        usdc.mint(address(vault), totalWithdrawUSDC);

        vm.prank(user);
        mzusd.requestWithdrawal(firstWithdrawUSDC * SCALE);

        assertEq(mzusd.windowUsedUSDC(), firstWithdrawUSDC);
        assertEq(mzusd.redemptionWindowDuration(), initialDuration);
        assertEq(mzusd.nextRedemptionWindowDuration(), nextDuration);

        vm.warp(block.timestamp + uint256(initialDuration) + 1);

        vm.prank(user);
        mzusd.requestWithdrawal(secondWithdrawUSDC * SCALE);

        assertEq(mzusd.windowUsedUSDC(), secondWithdrawUSDC);
        assertEq(mzusd.redemptionWindowDuration(), nextDuration);

        (uint256 capNow, uint256 usedNow, uint256 remainingNow) = mzusd.getRemainingRedemptionCap();
        assertEq(capNow, capUSDC);
        assertEq(usedNow, secondWithdrawUSDC);
        assertEq(remainingNow, capUSDC - secondWithdrawUSDC);
    }

    function testFuzz_InterleavedAtomicNettingTracksUsageAcrossTwoWithdrawals(
        uint96 deposit1Seed,
        uint96 deposit2Seed,
        uint96 extraMintSeed,
        uint96 withdraw1Seed,
        uint96 withdraw2Seed,
        uint96 capSeed,
        address user
    ) public {
        _assumeValidUser(user);
        _allowlistAccount(user);

        uint256 deposit1USDC = bound(uint256(deposit1Seed), 2, 3_000_000e6);
        uint256 deposit2USDC = bound(uint256(deposit2Seed), 0, 3_000_000e6);
        uint256 extraMintUSDC = bound(uint256(extraMintSeed), 0, 3_000_000e6);

        uint256 totalDepositsUSDC = deposit1USDC + deposit2USDC;
        uint256 totalAvailableUSDC = totalDepositsUSDC + extraMintUSDC;
        uint256 preSecondDepositAvailableUSDC = deposit1USDC + extraMintUSDC;

        uint256 withdraw1USDC = bound(uint256(withdraw1Seed), 1, preSecondDepositAvailableUSDC - 1);
        uint256 withdraw2USDC = bound(
            uint256(withdraw2Seed),
            1,
            totalAvailableUSDC - withdraw1USDC
        );

        uint256 txDepositedTracker = deposit1USDC;
        uint256 net1USDC = withdraw1USDC > txDepositedTracker
            ? withdraw1USDC - txDepositedTracker
            : 0;
        txDepositedTracker = txDepositedTracker > withdraw1USDC
            ? txDepositedTracker - withdraw1USDC
            : 0;
        txDepositedTracker += deposit2USDC;
        uint256 net2USDC = withdraw2USDC > txDepositedTracker
            ? withdraw2USDC - txDepositedTracker
            : 0;
        uint256 expectedUsedUSDC = net1USDC + net2USDC;

        uint256 minCapUSDC = net1USDC == 0 ? 1 : net1USDC;
        uint256 capUSDC;
        if (expectedUsedUSDC == 0) {
            capUSDC = bound(uint256(capSeed), 1, 5_000_000e6);
        } else {
            capUSDC = bound(uint256(capSeed), minCapUSDC, expectedUsedUSDC);
        }
        mzusd.setGlobalRedemptionCap(capUSDC);

        if (extraMintUSDC != 0) {
            vm.prank(address(vault));
            mzusd.mint(user, extraMintUSDC * SCALE);
            usdc.mint(address(reservoir), extraMintUSDC);
        }

        usdc.mint(user, totalDepositsUSDC);
        uint256 usedBefore = mzusd.windowUsedUSDC();

        vm.startPrank(user);
        usdc.approve(address(mzusd), totalDepositsUSDC);
        mzusd.deposit(deposit1USDC);
        mzusd.requestWithdrawal(withdraw1USDC * SCALE);

        if (deposit2USDC != 0) {
            mzusd.deposit(deposit2USDC);
        }

        if (expectedUsedUSDC > capUSDC) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    MZUSD.GlobalRedemptionCapExceeded.selector,
                    capUSDC,
                    expectedUsedUSDC,
                    net2USDC
                )
            );
            mzusd.requestWithdrawal(withdraw2USDC * SCALE);
            vm.stopPrank();

            assertEq(mzusd.windowUsedUSDC(), usedBefore + net1USDC);
            assertEq(usdc.balanceOf(user), withdraw1USDC);
            assertEq(mzusd.balanceOf(user), (totalAvailableUSDC - withdraw1USDC) * SCALE);
            return;
        }

        mzusd.requestWithdrawal(withdraw2USDC * SCALE);
        vm.stopPrank();

        assertEq(mzusd.windowUsedUSDC(), usedBefore + expectedUsedUSDC);
        assertEq(usdc.balanceOf(user), withdraw1USDC + withdraw2USDC);
        assertEq(
            mzusd.balanceOf(user),
            (totalAvailableUSDC - withdraw1USDC - withdraw2USDC) * SCALE
        );
    }

    function test_SetAllowlist() public {
        Allowlist newAllowlistImpl = new Allowlist();
        Allowlist newAllowlist = Allowlist(
            _deployProxy(
                address(newAllowlistImpl),
                abi.encodeCall(Allowlist.initialize, (address(accessManager), sanctionsList))
            )
        );

        vm.expectEmit(true, false, false, false, address(mzusd));
        emit MZUSD.AllowlistUpdated(address(newAllowlist));
        mzusd.setAllowlist(address(newAllowlist));

        assertEq(address(mzusd.allowlist()), address(newAllowlist));
    }

    function test_SetAllowlistRevertsOnZeroAddress() public {
        vm.expectRevert(MZUSD.ZeroAddress.selector);
        mzusd.setAllowlist(address(0));
    }

    function test_SetAllowlistRevertsWhenUnauthorized(address caller) public {
        vm.assume(caller != address(0));
        vm.assume(caller != address(this));

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, caller)
        );
        mzusd.setAllowlist(address(allowlist));
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
    }
}
