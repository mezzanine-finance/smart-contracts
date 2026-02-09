// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface INavOracleAutomation {
    function vault() external view returns (address);
    function lossManager() external view returns (address);
    function mzusd() external view returns (address);
}
