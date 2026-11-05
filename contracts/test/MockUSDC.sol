// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC - A mock USDC token for testnet deployments.
/// @notice Mimics mainnet USDC (6 decimals, same name/symbol). Anyone can mint.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Public mint function for testnet use.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
