// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Vault} from "contracts/Vault.sol";
import {BaseProtocolFuzzTest} from "./BaseProtocolFuzz.t.sol";

contract VaultFuzzTest is BaseProtocolFuzzTest {
    function testFuzz_RebalanceSendsExcessToReservoirWhenIdleAboveBand(
        uint96 targetSeed,
        uint16 bandSeed,
        uint96 idleSeed
    ) public {
        uint256 target = bound(uint256(targetSeed), 1_000_000e6, 20_000_000e6);
        uint16 bandBps = uint16(bound(uint256(bandSeed), 0, 10_000));

        (, uint256 high) = _bufferBounds(target, bandBps);
        uint256 idle = bound(uint256(idleSeed), high + 1, high + 5_000_000e6);

        usdc.mint(address(vault), idle);

        vault.setBuffer(target, bandBps);

        assertEq(usdc.balanceOf(address(vault)), target);
        assertEq(usdc.balanceOf(address(reservoir)), idle - target);
    }

    function testFuzz_RebalanceDoesNothingWhenIdleInsideBand(
        uint96 targetSeed,
        uint16 bandSeed,
        uint96 idleSeed,
        uint96 reservoirSeed
    ) public {
        uint256 target = bound(uint256(targetSeed), 1_000_000e6, 20_000_000e6);
        uint16 bandBps = uint16(bound(uint256(bandSeed), 0, 10_000));

        (uint256 low, uint256 high) = _bufferBounds(target, bandBps);
        uint256 idle = bound(uint256(idleSeed), low, high);
        uint256 reservoirBalance = bound(uint256(reservoirSeed), 0, 5_000_000e6);

        usdc.mint(address(vault), idle);
        usdc.mint(address(reservoir), reservoirBalance);

        vault.setBuffer(target, bandBps);

        assertEq(usdc.balanceOf(address(vault)), idle);
        assertEq(usdc.balanceOf(address(reservoir)), reservoirBalance);
    }

    function testFuzz_RebalancePullsAllAvailableWhenReservoirInsufficient(
        uint96 targetSeed,
        uint16 bandSeed,
        uint96 idleSeed,
        uint96 reservoirSeed
    ) public {
        uint256 target = bound(uint256(targetSeed), 1_000_000e6, 20_000_000e6);
        uint16 bandBps = uint16(bound(uint256(bandSeed), 0, 10_000));

        (uint256 low, ) = _bufferBounds(target, bandBps);
        vm.assume(low > 0);

        uint256 idle = bound(uint256(idleSeed), 0, low - 1);
        uint256 need = target - idle;
        vm.assume(need > 1);

        // Force the "insufficient reservoir" branch: 0 < available < needed.
        uint256 reservoirBalance = bound(uint256(reservoirSeed), 1, need - 1);

        usdc.mint(address(vault), idle);
        usdc.mint(address(reservoir), reservoirBalance);

        vault.setBuffer(target, bandBps);

        assertEq(usdc.balanceOf(address(vault)), idle + reservoirBalance);
        assertEq(usdc.balanceOf(address(reservoir)), 0);
    }

    function testFuzz_SetBufferDoesNotRevertWhenReservoirEmptyAndPullNeeded(
        uint96 targetSeed,
        uint16 bandSeed,
        uint96 idleSeed
    ) public {
        uint256 target = bound(uint256(targetSeed), 1_000_000e6, 20_000_000e6);
        uint16 bandBps = uint16(bound(uint256(bandSeed), 0, 10_000));

        (uint256 low, ) = _bufferBounds(target, bandBps);
        vm.assume(low > 0);

        uint256 idle = bound(uint256(idleSeed), 0, low - 1);
        usdc.mint(address(vault), idle);

        vault.setBuffer(target, bandBps);

        assertEq(vault.idleBufferUSDC(), target);
        assertEq(vault.hysteresisBps(), bandBps);
        assertEq(usdc.balanceOf(address(vault)), idle);
        assertEq(usdc.balanceOf(address(reservoir)), 0);

        vm.expectRevert(Vault.ReservoirEmpty.selector);
        vault.rebalance();
    }

    function testFuzz_RebalancePullsExactlyNeededWhenReservoirSufficient(
        uint96 targetSeed,
        uint16 bandSeed,
        uint96 idleSeed,
        uint96 reservoirSeed
    ) public {
        uint256 target = bound(uint256(targetSeed), 1_000_000e6, 20_000_000e6);
        uint16 bandBps = uint16(bound(uint256(bandSeed), 0, 10_000));

        (uint256 low, ) = _bufferBounds(target, bandBps);
        vm.assume(low > 0);

        uint256 idle = bound(uint256(idleSeed), 0, low - 1);
        uint256 need = target - idle;
        uint256 reservoirBalance = bound(uint256(reservoirSeed), need, need + 5_000_000e6);

        usdc.mint(address(vault), idle);
        usdc.mint(address(reservoir), reservoirBalance);

        vault.setBuffer(target, bandBps);

        assertEq(usdc.balanceOf(address(vault)), target);
        assertEq(usdc.balanceOf(address(reservoir)), reservoirBalance - need);
    }

    function testFuzz_RebalanceDoesNothingAtExactBandEdges(
        uint96 targetSeed,
        uint16 bandSeed,
        uint96 reservoirSeed,
        bool useHighEdge
    ) public {
        uint256 target = bound(uint256(targetSeed), 1_000_000e6, 20_000_000e6);
        uint16 bandBps = uint16(bound(uint256(bandSeed), 0, 10_000));
        (uint256 low, uint256 high) = _bufferBounds(target, bandBps);

        uint256 idle = useHighEdge ? high : low;
        uint256 reservoirBalance = bound(uint256(reservoirSeed), 0, 5_000_000e6);

        usdc.mint(address(vault), idle);
        usdc.mint(address(reservoir), reservoirBalance);

        vault.setBuffer(target, bandBps);

        assertEq(usdc.balanceOf(address(vault)), idle);
        assertEq(usdc.balanceOf(address(reservoir)), reservoirBalance);
    }

    function testFuzz_RebalanceAcrossOppositeDriftsConservesLiquidity(
        uint96 targetSeed,
        uint16 bandSeed,
        uint96 extraIdleSeed,
        uint96 deficitSeed,
        uint96 reservoirSeed
    ) public {
        uint256 target = bound(uint256(targetSeed), 1_000_000e6, 20_000_000e6);
        uint16 bandBps = uint16(bound(uint256(bandSeed), 0, 10_000));
        (uint256 low, uint256 high) = _bufferBounds(target, bandBps);
        vm.assume(low > 0);

        uint256 baseReservoir = bound(uint256(reservoirSeed), 0, 5_000_000e6);

        usdc.mint(address(vault), target);
        usdc.mint(address(reservoir), baseReservoir);

        vault.setBuffer(target, bandBps);
        assertEq(usdc.balanceOf(address(vault)), target);

        uint256 minExtra = (high - target) + 1;
        uint256 extraIdle = bound(uint256(extraIdleSeed), minExtra, minExtra + 5_000_000e6);
        usdc.mint(address(vault), extraIdle);

        uint256 totalBeforeSurplusRebalance = usdc.balanceOf(address(vault)) +
            usdc.balanceOf(address(reservoir));
        vault.rebalance();

        assertEq(usdc.balanceOf(address(vault)), target);
        assertEq(
            usdc.balanceOf(address(vault)) + usdc.balanceOf(address(reservoir)),
            totalBeforeSurplusRebalance
        );

        uint256 minDeficit = (target - low) + 1;
        uint256 deficit = bound(uint256(deficitSeed), minDeficit, target);
        vm.assume(usdc.balanceOf(address(reservoir)) >= deficit);

        vm.prank(address(mzusd));
        vault.withdraw(address(0xBEEF), deficit);

        uint256 totalBeforeDeficitRebalance = usdc.balanceOf(address(vault)) +
            usdc.balanceOf(address(reservoir));
        vault.rebalance();

        assertEq(usdc.balanceOf(address(vault)), target);
        assertEq(
            usdc.balanceOf(address(vault)) + usdc.balanceOf(address(reservoir)),
            totalBeforeDeficitRebalance
        );
    }

    function _bufferBounds(
        uint256 target,
        uint16 bandBps
    ) internal pure returns (uint256 low, uint256 high) {
        low = (target * (BPS - bandBps)) / BPS;
        high = (target * (BPS + bandBps)) / BPS;
    }
}
