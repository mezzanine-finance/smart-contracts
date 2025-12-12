// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// solhint-disable-next-line max-line-length
import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMZUSD is IERC20 {
    function mint(address to, uint256 amount) external;

    function burn(address from, uint256 amount) external;
}

interface ITrancheLike {
    function totalAssets() external view returns (uint256);
}

// @title LossManager
// @notice Burns mzUSD from tranches in predefined order to materialize protocol losses
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
    address[] public trancheOrder; // order to burn from
    uint256 public maxLossPerTxUSDC; // 0 = no limit

    event LossApplied(uint256 usdcLoss, uint256 lossMZ, address[] tranches, uint256[] cutsMZ);
    event TrancheOrderUpdated(address[] newOrder);
    event MaxLossPerTxUpdated(uint256 newLimitUSDC);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroLength();
    error InsufficientCover(uint256 remainingMZ);
    error LimitExceeded();

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address accessManager,
        address _mzusd,
        address[] memory order,
        uint256 _maxLossPerTxUSDC
    ) external initializer {
        if (accessManager == address(0) || _mzusd == address(0)) revert ZeroAddress();

        __AccessManaged_init(accessManager);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        mzusd = IMZUSD(_mzusd);
        _setTrancheOrder(order);
        maxLossPerTxUSDC = _maxLossPerTxUSDC;
    }

    // @notice applies loss denominated in USDC 6d, burns mzUSD 18d from tranches in order
    function applyLoss(uint256 usdcLoss) external whenNotPaused nonReentrant restricted {
        if (usdcLoss == 0) revert ZeroAmount();
        if (maxLossPerTxUSDC != 0 && usdcLoss > maxLossPerTxUSDC) revert LimitExceeded();

        uint256 remaining = usdcLoss * SCALE; // convert 6d to 18d
        uint256 orderLen = trancheOrder.length;
        uint256[] memory cuts = new uint256[](orderLen);

        for (uint256 i = 0; i < orderLen && remaining > 0; i++) {
            address trancheAddr = trancheOrder[i];
            uint256 tvl = ITrancheLike(trancheAddr).totalAssets(); // mzUSD 18d on tranche
            if (tvl == 0) continue;

            uint256 toBurn = tvl < remaining ? tvl : remaining;
            mzusd.burn(trancheAddr, toBurn);

            cuts[i] = toBurn;
            remaining -= toBurn;
        }

        if (remaining > 0) revert InsufficientCover(remaining);

        // copy storage -> memory for event
        address[] memory orderCopy = new address[](orderLen);
        for (uint256 j = 0; j < orderLen; j++) {
            orderCopy[j] = trancheOrder[j];
        }

        emit LossApplied(usdcLoss, usdcLoss * SCALE, orderCopy, cuts);
    }

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

    function trancheOrderLength() external view returns (uint256) {
        return trancheOrder.length;
    }

    function _setTrancheOrder(address[] memory order) internal {
        if (order.length == 0) revert ZeroLength();
        for (uint256 i = 0; i < order.length; i++) {
            if (order[i] == address(0)) revert ZeroAddress();
        }
        trancheOrder = order;
        emit TrancheOrderUpdated(order);
    }

    function _authorizeUpgrade(address) internal override restricted {}
}
