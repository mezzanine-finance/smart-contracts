// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract MockMZUSD {
    address public immutable usdc;
    address public immutable vault;
    uint8 private immutable _decimals;

    constructor(address usdc_, address vault_, uint8 decimals_) {
        usdc = usdc_;
        vault = vault_;
        _decimals = decimals_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    // Minimal stub to satisfy Vault's interface expectations.
    function mint(address, uint256) external {}
}
