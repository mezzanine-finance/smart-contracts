// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseStrategy.sol";

contract ExampleYieldStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    uint256 private mockInvestedBalance;

    /* ---------- initializer ----------*/
    function initialize(address _usdc, address _reservoir, address _accessManager) external initializer {
        __BaseStrategy_init(_usdc, _reservoir, _accessManager);
    }

    /* ---------- view ----------*/
    function totalAssets() external view override returns (uint256) {
        return mockInvestedBalance;
    }

    /* ---------- core logic (mock) ----------*/
    function _invest(uint256 amount) internal override {
        usdc.safeTransferFrom(reservoir, address(this), amount);
        mockInvestedBalance += amount;
    }

    function _divest(uint256 amount) internal override returns (uint256) {
        uint256 toDivest = amount > mockInvestedBalance ? mockInvestedBalance : amount;
        mockInvestedBalance -= toDivest;
        usdc.safeTransfer(reservoir, toDivest);
        return toDivest;
    }

    function _harvest() internal override {
        uint256 yieldAmount = mockInvestedBalance / 100; // 1% yield
        mockInvestedBalance += yieldAmount;
    }

    uint256[50] private __gap;
}
