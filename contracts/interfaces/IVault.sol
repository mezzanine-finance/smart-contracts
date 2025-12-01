// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IVault {
    function withdraw(address to, uint256 amount) external;
    function currentEpochId() external view returns (uint256);
    function minEpochDuration() external view returns (uint256);
}
