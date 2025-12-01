// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IVault.sol";

interface IMZUSD is IERC20 {
    /// @notice deposit USDC and mint MZUSD 1:1
    function deposit(uint256 amountUSDC) external;

    /// @notice request withdrawal of MZUSD for USDC
    function requestWithdrawal(uint256 amountMZ) external;

    /// @notice pause / unpause user actions
    function pause() external;
    function unpause() external;

    // @notice usage restricted to Vault; mint assets to Tranche + fee lock
    function mint(address to, uint256 amount) external;

    /// @notice set global hourly redemption cap (USDC, 6 decimals); 0 = disabled
    function setGlobalHourlyRedemptionCap(uint256 newCapUSDC) external;

    /// @notice set vault address
    function setVault(address _vault) external;

    /// @notice remaining global hourly redemption cap
    /// @return remainingUSDC remaining cap in USDC (6 decimals)
    /// @return windowStart start timestamp of current window
    function getRemainingGlobalHourlyCap()
        external
        view
        returns (uint256 remainingUSDC, uint256 windowStart);

    /// @notice preview how much MZ will be minted for given USDC
    function previewDeposit(uint256 amountUSDC) external pure returns (uint256 mintMZ);

    /// @notice preview USDC out and dust for given MZ amount
    function previewWithdrawal(uint256 amountMZ)
        external
        pure
        returns (uint256 usdcOut, uint256 dustMZ);

}