// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface INavOracleAutomationForMock {
    function hasPendingNav() external view returns (bool);
    function submitNav(uint256 navUSDC) external;
}

interface IVaultForMock {
    function getEpochConfig() external view returns (uint64 epochId, uint64 start, uint64 duration);
    function navOracle() external view returns (address);
    function mzusd() external view returns (address);
}

/// @notice Test-only utility automation that submits NAV to NavOracleAutomation.
/// @dev Intentionally convenience-first and not hardened. Use only in test/dev environments.
contract MockNavSubmitterAutomation is AutomationCompatibleInterface {
    uint256 public constant SCALE = 1e12; // MZUSD 18d -> USDC 6d
    uint256 public constant BPS = 10_000;
    uint256 public constant PREMIUM_BPS = 500; // +5%
    uint256 public constant MIN_NAV_DELTA_USDC = 1;

    address public immutable vault;

    event NavSubmittedByAutomation(
        uint256 totalSupplyUSDC,
        uint256 navUSDC,
        uint256 deltaUSDC,
        address navOracle
    );

    error ZeroAddress();
    error NoWork();

    constructor(address vault_) {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
    }

    function checkUpkeep(
        bytes calldata /* checkData */
    ) external view override returns (bool upkeepNeeded, bytes memory performData) {
        (bool canSubmit, uint256 navUSDC) = _canSubmitNow();
        if (!canSubmit) return (false, "");
        return (true, abi.encode(navUSDC));
    }

    function performUpkeep(bytes calldata /* performData */) external override {
        (bool canSubmit, uint256 navUSDC) = _canSubmitNow();
        if (!canSubmit) revert NoWork();

        IVaultForMock v = IVaultForMock(vault);
        address navOracle = v.navOracle();
        uint256 totalSupplyUSDC = IERC20(v.mzusd()).totalSupply() / SCALE;

        INavOracleAutomationForMock(navOracle).submitNav(navUSDC);

        emit NavSubmittedByAutomation(
            totalSupplyUSDC,
            navUSDC,
            navUSDC - totalSupplyUSDC,
            navOracle
        );
    }

    function previewNextNav() external view returns (bool canSubmit, uint256 navUSDC) {
        return _canSubmitNow();
    }

    function _canSubmitNow() internal view returns (bool canSubmit, uint256 navUSDC) {
        IVaultForMock v = IVaultForMock(vault);
        address navOracle = v.navOracle();
        if (navOracle == address(0)) {
            return (false, 0);
        }
        if (INavOracleAutomationForMock(navOracle).hasPendingNav()) {
            return (false, 0);
        }

        (, uint64 epochStart, uint64 epochDuration) = v.getEpochConfig();
        if (block.timestamp < uint256(epochStart) + uint256(epochDuration)) {
            return (false, 0);
        }

        uint256 totalSupplyUSDC = IERC20(v.mzusd()).totalSupply() / SCALE;
        if (totalSupplyUSDC == 0) {
            return (false, 0);
        }

        uint256 premiumDelta = (totalSupplyUSDC * PREMIUM_BPS + (BPS - 1)) / BPS;
        uint256 delta = premiumDelta >= MIN_NAV_DELTA_USDC ? premiumDelta : MIN_NAV_DELTA_USDC;

        return (true, totalSupplyUSDC + delta);
    }
}
