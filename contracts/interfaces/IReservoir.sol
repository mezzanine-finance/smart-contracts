// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IReservoir {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount, address to) external;
    function usdc() external view returns (address);
    function authority() external view returns (address);
    function pauseManager() external view returns (address);
}
