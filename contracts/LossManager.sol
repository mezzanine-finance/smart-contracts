// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// solhint-disable-next-line max-line-length
import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// aderyn-fp-next-line(reused-contract-name)
interface IMZUSD is IERC20 {
    function mint(address to, uint256 amount) external;

    function burn(address from, uint256 amount) external;
}

// aderyn-fp-next-line(reused-contract-name)
interface ITranche {
    function totalAssets() external view returns (uint256);
}

/// @title LossManager
/// @notice Burns mzUSD from tranches in predefined order to materialize protocol losses
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

    IMZUSD public mzusd; // protocol stablecoin contract
    address[] public trancheOrder; // order to burn from
    uint256 public maxLossPerTxUSDC; // 0 = no limit

    /// @notice Optional group id for proportional loss sharing across a PAIR of tranches.
    /// @dev If trancheOrder[i] and trancheOrder[i+1] are contiguous and share the same non-zero group id,
    ///      then they form a pair and share losses proportionally by TVL (totalAssets).
    mapping(address => uint256) public trancheGroup;

    event TrancheGroupUpdated(address indexed tranche, uint256 indexed groupId);
    event LossApplied(uint256 usdcLoss, uint256 lossMZ, address[] tranches, uint256[] cutsMZ);
    event TrancheOrderUpdated(address[] newOrder);
    event MaxLossPerTxUpdated(uint256 newLimitUSDC);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroLength();
    error InsufficientCover(uint256 remainingMZ);
    error LimitExceeded();
    error EthTransferFailed(address to, uint256 attemptedAmount);

    constructor() {
        _disableInitializers();
    }

    /// @param accessManager controls access to restricted functions
    /// @param _mzusd protocol stablecoin contract
    /// @param order tranche burn order
    /// @param _maxLossPerTxUSDC - max loss per tx in USDC 6d (0 = no limit)
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
    function applyLoss(uint256 usdcLoss) external nonReentrant whenNotPaused restricted {
        if (usdcLoss == 0) revert ZeroAmount();
        if (maxLossPerTxUSDC != 0 && usdcLoss > maxLossPerTxUSDC) revert LimitExceeded();

        uint256 remainingMZ = _toMZ(usdcLoss);
        uint256 orderLen = trancheOrder.length;
        uint256[] memory cuts = new uint256[](orderLen);

        remainingMZ = _applyLossAcrossOrder(remainingMZ, cuts);
        if (remainingMZ > 0) revert InsufficientCover(remainingMZ);

        emit LossApplied(usdcLoss, _toMZ(usdcLoss), _copyOrder(orderLen), cuts);
    }

    //SETTERS

    // @notice sets tranche burn order
    function setTrancheOrder(address[] memory order) external restricted {
        _setTrancheOrder(order);
    }

    // @notice sets tranche group id for paired loss sharing
    function setTrancheGroup(address tranche, uint256 groupId) external restricted {
        if (tranche == address(0)) revert ZeroAddress();
        trancheGroup[tranche] = groupId;
        emit TrancheGroupUpdated(tranche, groupId);
    }

    // @notice sets max loss per tx in USDC 6d (0 = no limit)
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

    //GETTERS

    function trancheOrderLength() external view returns (uint256) {
        return trancheOrder.length;
    }

    //INTERNAL HELPERS

    function _setTrancheOrder(address[] memory order) internal {
        if (order.length == 0) revert ZeroLength();
        // aderyn-ignore-next-line(require-revert-in-loop)
        for (uint256 i = 0; i < order.length; i++) {
            if (order[i] == address(0)) revert ZeroAddress();
        }
        trancheOrder = order;
        emit TrancheOrderUpdated(order);
    }

    function _toMZ(uint256 usdcAmount) internal pure returns (uint256) {
        return usdcAmount * SCALE;
    }

    // @notice burns up to remainingMZ from tranches in order, returns any leftover amount
    function _applyLossAcrossOrder(
        uint256 remainingMZ,
        uint256[] memory cuts
    ) internal returns (uint256) {
        uint256 orderLen = trancheOrder.length;
        uint256 i = 0;

        while (i < orderLen && remainingMZ > 0) {
            (uint256 nextI, uint256 burned) = _applyLossStep(i, remainingMZ, cuts);
            remainingMZ -= burned;
            i = nextI;
        }

        return remainingMZ;
    }

    // @notice applies loss step at index i, returns next index and amount burned
    function _applyLossStep(
        uint256 i,
        uint256 remainingMZ,
        uint256[] memory cuts
    ) internal returns (uint256 nextI, uint256 burned) {
        // Pair-mode is enabled only if trancheOrder[i] and trancheOrder[i+1] share the same non-zero group id
        (bool isPair, address t0, address t1, ) = _pairAt(i);
        if (!isPair) {
            return _burnSequential(i, remainingMZ, cuts);
        }
        return _burnPair(i, remainingMZ, cuts, t0, t1);
    }

    // @notice checks if trancheOrder[i] and trancheOrder[i+1] form a pair, returns info
    function _pairAt(
        uint256 i
    ) internal view returns (bool isPair, address t0, address t1, uint256 gid) {
        uint256 orderLen = trancheOrder.length;
        t0 = trancheOrder[i];
        gid = trancheGroup[t0];
        if (gid == 0) return (false, t0, address(0), 0);
        if (i + 1 >= orderLen) return (false, t0, address(0), 0);

        t1 = trancheOrder[i + 1];
        if (trancheGroup[t1] != gid) return (false, t0, t1, 0);

        return (true, t0, t1, gid);
    }

    // @notice gets totalAssets (TVL) of a tranche
    function _tvl(address tranche) internal view returns (uint256) {
        return ITranche(tranche).totalAssets();
    }

    // @notice burns from a single tranche at index i, returns next index and amount burned
    function _burnSequential(
        uint256 i,
        uint256 remainingMZ,
        uint256[] memory cuts
    ) internal returns (uint256 nextI, uint256 burned) {
        address t0 = trancheOrder[i];
        uint256 tvl0 = _tvl(t0);
        if (tvl0 == 0) return (i + 1, 0);

        uint256 toBurn0 = tvl0 < remainingMZ ? tvl0 : remainingMZ;
        mzusd.burn(t0, toBurn0);
        cuts[i] = toBurn0;
        return (i + 1, toBurn0);
    }

    // @notice burns from a pair of tranches at index i and i+1, returns next index and amount burned
    function _burnPair(
        uint256 i,
        uint256 remainingMZ,
        uint256[] memory cuts,
        address t0,
        address t1
    ) internal returns (uint256 nextI, uint256 burned) {
        uint256 tvl0 = _tvl(t0);
        uint256 tvl1 = _tvl(t1);
        uint256 pairTVL = tvl0 + tvl1;
        if (pairTVL == 0) return (i + 2, 0);

        uint256 lossForPair = pairTVL < remainingMZ ? pairTVL : remainingMZ;

        // Proportional split (floor)
        uint256 burn0 = tvl0 == 0 ? 0 : (lossForPair * tvl0) / pairTVL;
        if (burn0 > tvl0) burn0 = tvl0;

        uint256 burn1 = tvl1 == 0 ? 0 : (lossForPair * tvl1) / pairTVL;
        if (burn1 > tvl1) burn1 = tvl1;

        // Allocate rounding remainder - prefer first tranche then second
        uint256 rem = lossForPair - (burn0 + burn1);
        if (rem != 0) {
            uint256 cap0 = tvl0 - burn0;
            if (cap0 != 0) {
                uint256 add0 = cap0 < rem ? cap0 : rem;
                burn0 += add0;
                rem -= add0;
            }
        }
        // Allocate any remaining remainder to second tranche
        if (rem != 0) {
            uint256 cap1 = tvl1 - burn1;
            if (cap1 != 0) {
                uint256 add1 = cap1 < rem ? cap1 : rem;
                burn1 += add1;
                rem -= add1;
            }
        }

        if (burn0 != 0) {
            mzusd.burn(t0, burn0);
            cuts[i] = burn0;
        }
        if (burn1 != 0) {
            mzusd.burn(t1, burn1);
            cuts[i + 1] = burn1;
        }

        return (i + 2, lossForPair);
    }

    // @notice creates a copy of the current tranche order for event emission
    function _copyOrder(uint256 orderLen) internal view returns (address[] memory orderCopy) {
        orderCopy = new address[](orderLen);
        for (uint256 j = 0; j < orderLen; j++) {
            orderCopy[j] = trancheOrder[j];
        }
    }

    /// @notice Emergency helper to recover ETH that might be accidentally sent to this contract.
    /// @dev Due to inheriting UUPSUpgradeable, the implementation exposes a payable
    ///      `upgradeToAndCall` function, so static analyzers treat this contract as
    ///      capable of receiving ETH. In normal operation, `msg.value` is forwarded
    ///      via the proxy and no ETH should remain here, but having an explicit
    ///      withdrawal function avoids locking ETH that may arrive via selfdestruct
    ///      or mistaken transfers. This function is not part of the normal protocol
    ///      flow and is restricted to the admin role.
    // aderyn-ignore-next-line(state-change-without-event)
    function rescueETH(address to, uint256 amount) external restricted {
        if (to == address(0)) revert ZeroAddress();

        uint256 bal = address(this).balance;
        if (amount > bal) {
            amount = bal;
        }

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed(to, amount);
    }

    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
