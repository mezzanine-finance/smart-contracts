// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import "../MZUSD.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MZUSDNettingHelper {
    // Simple deposit to preload MZUSD balance for this helper
    function depositOnly(address mzusd, address usdc, uint256 depositUSDC) external {
        IERC20(usdc).approve(mzusd, depositUSDC);
        MZUSD(mzusd).deposit(depositUSDC);
    }

    // D -> W in one tx
    function depositAndWithdraw(
        address mzusd,
        address usdc,
        uint256 depositUSDC,
        uint256 withdrawMZ
    ) external {
        IERC20(usdc).approve(mzusd, depositUSDC);
        MZUSD(mzusd).deposit(depositUSDC);
        MZUSD(mzusd).requestWithdrawal(withdrawMZ);
    }

    // W -> D
    function withdrawThenDeposit(
        address mzusd,
        address usdc,
        uint256 withdrawMZ,
        uint256 depositUSDC
    ) external {
        MZUSD(mzusd).requestWithdrawal(withdrawMZ);
        IERC20(usdc).approve(mzusd, depositUSDC);
        MZUSD(mzusd).deposit(depositUSDC);
    }

    // W -> D -> W
    function withdrawDepositWithdraw(
        address mzusd,
        address usdc,
        uint256 withdraw1MZ,
        uint256 depositUSDC,
        uint256 withdraw2MZ
    ) external {
        MZUSD(mzusd).requestWithdrawal(withdraw1MZ);

        IERC20(usdc).approve(mzusd, depositUSDC);
        MZUSD(mzusd).deposit(depositUSDC);

        MZUSD(mzusd).requestWithdrawal(withdraw2MZ);
    }
}
