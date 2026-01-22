// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface ILossManager {
    function applyLoss(uint256 usdcLoss) external;
}
