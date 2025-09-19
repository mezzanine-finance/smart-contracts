// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMZUSD is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external; // LossManager has burn-rights
}

interface ITrancheLike {
    function totalAssets() external view returns (uint256);
}

/// @title LossManager
/// @notice Manages losses by burning mzUSD from tranches in a predefined order
contract LossManager is
    Initializable,
    AccessManagedUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    uint256 public constant USDC_DECIMALS = 6;
    uint256 public constant MZ_DECIMALS = 18;
    uint256 public constant SCALE = 10 ** (MZ_DECIMALS - USDC_DECIMALS); // 1e12

    IMZUSD public mzusd;
    address[] public trancheOrder; // [JLT, MLT, SMT], burn from these addresses in order
    uint256 public maxLossPerTxUSDC; // 0 = no limit

    event LossApplied(
        uint256 usdcLoss,
        uint256 lossMZ,
        address[] tranches,
        uint256[] cutsMZ
    );
    event TrancheOrderUpdated(address[] newOrder);
    event MaxLossPerTxUpdated(uint256 newLimitUSDC);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroLength();
    error InsufficientCover(uint256 remainingMZ);
    error LimitExceeded();

    function initialize(
        address accessManager,
        address _mzusd,
        address[] memory order,
        uint256 _maxLossPerTxUSDC
    ) external initializer {
        if (accessManager == address(0) || _mzusd == address(0))
            revert ZeroAddress();
        __AccessManaged_init(accessManager);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        mzusd = IMZUSD(_mzusd);
        _setTrancheOrder(order);
        maxLossPerTxUSDC = _maxLossPerTxUSDC;
    }

    // --- Admin via AccessManager ---
    function setTrancheOrder(address[] memory order) external restricted {
        _setTrancheOrder(order);
    }

    function setMaxLossPerTxUSDC(uint256 maxLossValue) external restricted {
        maxLossPerTxUSDC = maxLossValue;
        emit MaxLossPerTxUpdated(maxLossValue);
    }

    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
        _unpause();
    }

    // --- Core ---
    function applyLoss(
        uint256 usdcLoss
    ) external whenNotPaused nonReentrant restricted {
        if (usdcLoss == 0) revert ZeroAmount();
        if (maxLossPerTxUSDC != 0 && usdcLoss > maxLossPerTxUSDC)
            revert LimitExceeded();

        uint256 remaining = usdcLoss * SCALE; // 18d
        uint256 trancheOLength = trancheOrder.length;
        uint256[] memory cuts = new uint256[](trancheOLength);

        for (uint256 i; i < trancheOLength && remaining > 0; ++i) {
            address trancheInOrder = trancheOrder[i];
            uint256 tvl = ITrancheLike(trancheInOrder).totalAssets(); // 18d mzUSD held by tranche
            if (tvl == 0) continue;

            uint256 take = tvl < remaining ? tvl : remaining;
            // burn directly from tranche address (LossManager must have burn-rights)
            mzusd.burn(trancheInOrder, take);

            cuts[i] = take;
            remaining -= take;
        }

        if (remaining > 0) revert InsufficientCover(remaining);
        emit LossApplied(usdcLoss, usdcLoss * SCALE, trancheOrder, cuts);
    }

    function trancheOrderLength() external view returns (uint256) {
        return trancheOrder.length;
    }

    // --- Internals ---
    function _setTrancheOrder(address[] memory order) internal {
        if (order.length == 0) revert ZeroLength();
        for (uint256 i; i < order.length; ++i) {
            if (order[i] == address(0)) revert ZeroAddress();
        }
        trancheOrder = order;
        emit TrancheOrderUpdated(order);
    }

    // UUPS upgrade auth via AccessManager
    function _authorizeUpgrade(address) internal override restricted {}
}
