// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

contract MockAutomationTarget {
    uint256 public calls;
    bytes public lastPerformData;

    error ForcedRevert();

    function performUpkeep(bytes calldata performData) external {
        calls++;
        lastPerformData = performData;
    }

    function forbiddenCall() external pure returns (bool) {
        return true;
    }

    function revertingCall() external pure {
        revert ForcedRevert();
    }

    function revertingWithoutData() external pure {
        assembly ("memory-safe") {
            revert(0, 0)
        }
    }
}
