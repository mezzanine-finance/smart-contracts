// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {BaseProtocolFuzzTest} from "./BaseProtocolFuzz.t.sol";

contract VaultWithdrawFuzzTest is BaseProtocolFuzzTest {
    function testFuzz_VaultWithdrawConservesTotalLiquidityAndPaysExactAmount(
        uint96 amountSeed,
        uint96 idleSeed,
        uint96 reservoirSeed,
        address receiver
    ) public {
        vm.assume(receiver != address(0));
        vm.assume(receiver != address(vault));
        vm.assume(receiver != address(reservoir));

        uint256 amount = bound(uint256(amountSeed), 1, 5_000_000e6);
        uint256 idle = bound(uint256(idleSeed), 0, amount);
        uint256 neededFromReservoir = amount - idle;
        uint256 reservoirBalance = bound(
            uint256(reservoirSeed),
            neededFromReservoir,
            neededFromReservoir + 5_000_000e6
        );

        usdc.mint(address(vault), idle);
        usdc.mint(address(reservoir), reservoirBalance);

        uint256 receiverBefore = usdc.balanceOf(receiver);
        uint256 totalBefore = usdc.balanceOf(address(vault)) + usdc.balanceOf(address(reservoir));

        vm.prank(address(mzusd));
        vault.withdraw(receiver, amount);

        uint256 receiverAfter = usdc.balanceOf(receiver);
        uint256 totalAfter = usdc.balanceOf(address(vault)) + usdc.balanceOf(address(reservoir));

        assertEq(receiverAfter - receiverBefore, amount);
        assertEq(totalBefore - totalAfter, amount);
    }

    function testFuzz_VaultWithdrawPullsFromReservoirWhenIdleInsufficient(
        uint96 amountSeed,
        uint96 idleSeed,
        uint96 reservoirSeed,
        address receiver
    ) public {
        vm.assume(receiver != address(0));
        vm.assume(receiver != address(vault));
        vm.assume(receiver != address(reservoir));

        uint256 amount = bound(uint256(amountSeed), 1, 5_000_000e6);
        uint256 idle = bound(uint256(idleSeed), 0, amount - 1);
        uint256 neededFromReservoir = amount - idle;
        uint256 reservoirBalance = bound(
            uint256(reservoirSeed),
            neededFromReservoir,
            neededFromReservoir * 2
        );

        usdc.mint(address(vault), idle);
        usdc.mint(address(reservoir), reservoirBalance);

        vm.prank(address(mzusd));
        vault.withdraw(receiver, amount);

        assertEq(usdc.balanceOf(receiver), amount);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(address(reservoir)), reservoirBalance - neededFromReservoir);
    }

    function testFuzz_VaultWithdrawRevertsWhenCombinedLiquidityInsufficient(
        uint96 amountSeed,
        uint96 idleSeed,
        uint96 reservoirSeed,
        address receiver
    ) public {
        vm.assume(receiver != address(0));

        uint256 amount = bound(uint256(amountSeed), 2, 5_000_000e6);
        uint256 idle = bound(uint256(idleSeed), 0, amount - 1);
        uint256 neededFromReservoir = amount - idle;
        uint256 reservoirBalance = bound(uint256(reservoirSeed), 0, neededFromReservoir - 1);

        usdc.mint(address(vault), idle);
        usdc.mint(address(reservoir), reservoirBalance);

        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector,
                address(reservoir),
                reservoirBalance,
                neededFromReservoir
            )
        );
        vm.prank(address(mzusd));
        vault.withdraw(receiver, amount);
    }
}
