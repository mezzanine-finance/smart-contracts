// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IVault {
    function distributeYield(uint256 usdcReported) external;
}

interface ILossManager {
    function applyLoss(uint256 usdcLoss) external;
}

/// @title NAV oracle automation
/// @notice Stores oracle NAV snapshots with a veto window, then applies yield or loss via Automation.
/// @dev submitNav is AccessManaged; map it to ORACLE_ROLE in AccessManager, and grant this contract
///      a role that can call Vault.distributeYield and LossManager.applyLoss. NAV is USDC (6d).
contract NavOracleAutomation is AutomationCompatibleInterface, AccessManaged {
    uint256 public constant SCALE = 1e12; // MZUSD 18d -> USDC 6d

    IERC20 public immutable mzusd;
    address public immutable vault;
    address public immutable lossManager;

    uint256 public vetoPeriod;

    bool public hasPendingNav;
    uint256 public pendingNavUSDC;
    uint256 public pendingTotalSupplyMZ;
    uint256 public pendingSubmittedAt;
    uint256 public pendingReadyAt;

    event NavSubmitted(
        uint256 navUSDC,
        uint256 totalSupplyMZ,
        bool isYield,
        uint256 deltaUSDC,
        uint256 submittedAt,
        uint256 readyAt
    );
    event NavRejected(uint256 navUSDC, uint256 totalSupplyMZ);
    event NavApplied(uint256 navUSDC, uint256 totalSupplyMZ, bool isYield, uint256 deltaUSDC);
    event VetoPeriodUpdated(uint256 newPeriod);

    error PendingNavExists();
    error NoPendingNav();
    error NotReady(uint256 readyAt);
    error ZeroAddress();

    constructor(
        address accessManager,
        address mzusd_,
        address vault_,
        address lossManager_,
        uint256 vetoPeriod_
    ) AccessManaged(accessManager) {
        if (
            accessManager == address(0) ||
            mzusd_ == address(0) ||
            vault_ == address(0) ||
            lossManager_ == address(0)
        ) {
            revert ZeroAddress();
        }
        mzusd = IERC20(mzusd_);
        vault = vault_;
        lossManager = lossManager_;
        vetoPeriod = vetoPeriod_;
    }

    /// @notice Submits a NAV snapshot (USDC 6d) and records matching MZUSD total supply.
    /// @dev Reverts if a pending NAV exists. If vetoPeriod is 0, applies immediately.
    function submitNav(uint256 navUSDC) external restricted {
        if (hasPendingNav) revert PendingNavExists();

        uint256 totalSupplyMZ = mzusd.totalSupply();
        (bool isYield, uint256 deltaUSDC) = _deltaUSDC(navUSDC, totalSupplyMZ);

        uint256 submittedAt = block.timestamp;
        uint256 readyAt = submittedAt + vetoPeriod;

        pendingNavUSDC = navUSDC;
        pendingTotalSupplyMZ = totalSupplyMZ;
        pendingSubmittedAt = submittedAt;
        pendingReadyAt = readyAt;
        hasPendingNav = true;

        emit NavSubmitted(navUSDC, totalSupplyMZ, isYield, deltaUSDC, submittedAt, readyAt);

        if (vetoPeriod == 0) {
            _applyPending();
        }
    }

    /// @notice Rejects the pending NAV snapshot during the veto window.
    function rejectPendingNav() external restricted {
        if (!hasPendingNav) revert NoPendingNav();
        emit NavRejected(pendingNavUSDC, pendingTotalSupplyMZ);
        _clearPending();
    }

    /// @notice Updates the veto period for future submissions.
    function setVetoPeriod(uint256 newPeriod) external restricted {
        vetoPeriod = newPeriod;
        emit VetoPeriodUpdated(newPeriod);
    }

    /// @notice Chainlink Automation check: pending NAV exists and veto period elapsed.
    function checkUpkeep(
        bytes calldata /* checkData */
    ) external view returns (bool upkeepNeeded, bytes memory performData) {
        if (!hasPendingNav) return (false, "");
        if (block.timestamp < pendingReadyAt) return (false, "");
        return (true, "");
    }

    /// @notice Applies pending NAV after the veto period.
    function performUpkeep(bytes calldata /* performData */) external {
        if (!hasPendingNav) revert NoPendingNav();
        if (block.timestamp < pendingReadyAt) revert NotReady(pendingReadyAt);
        _applyPending();
    }

    function _applyPending() internal {
        (bool isYield, uint256 deltaUSDC) = _deltaUSDC(pendingNavUSDC, pendingTotalSupplyMZ);

        if (isYield) {
            IVault(vault).distributeYield(deltaUSDC);
        } else {
            ILossManager(lossManager).applyLoss(deltaUSDC);
        }

        emit NavApplied(pendingNavUSDC, pendingTotalSupplyMZ, isYield, deltaUSDC);
        _clearPending();
    }

    function _deltaUSDC(
        uint256 navUSDC,
        uint256 totalSupplyMZ
    ) internal pure returns (bool isYield, uint256 deltaUSDC) {
        uint256 totalSupplyUSDC = totalSupplyMZ / SCALE;
        if (navUSDC >= totalSupplyUSDC) {
            isYield = true;
            deltaUSDC = navUSDC - totalSupplyUSDC;
        } else {
            isYield = false;
            deltaUSDC = totalSupplyUSDC - navUSDC;
        }
    }

    function _clearPending() internal {
        hasPendingNav = false;
        pendingNavUSDC = 0;
        pendingTotalSupplyMZ = 0;
        pendingSubmittedAt = 0;
        pendingReadyAt = 0;
    }
}
