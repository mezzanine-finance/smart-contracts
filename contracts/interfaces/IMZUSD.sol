// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMZUSD is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function setVault(address vault) external;
    function usdc() external view returns (address);
    function vault() external view returns (address);
    function authority() external view returns (address);
    function pauseManager() external view returns (address);
    function decimals() external view returns (uint8);
}
