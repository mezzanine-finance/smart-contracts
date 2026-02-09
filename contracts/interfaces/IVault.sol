// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IVault {
    function withdraw(address to, uint256 amountUSDC) external;
    function distributeYield(uint256 usdcReported) external;
    function advanceEpoch() external returns (uint256 newEpochId);
    function currentEpochId() external view returns (uint64 epochId);
    function epochDuration() external view returns (uint64 duration);
    function lossManager() external view returns (address lossManager);
    function navOracle() external view returns (address navOracleAddress);
    function mzusd() external view returns (address mzusdAddress);
}
