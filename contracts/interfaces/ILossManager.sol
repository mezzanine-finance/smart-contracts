// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface ILossManager {
    function applyLoss(uint256 usdcLoss) external;
    function vault() external view returns (address);
    function mzusd() external view returns (address);
}
