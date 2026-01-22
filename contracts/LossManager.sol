// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// solhint-disable-next-line max-line-length
import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PauseManagedUpgradeable} from "./pause/PauseManagedUpgradeable.sol";
import {PauseCategory} from "./pause/PauseCategory.sol";

// aderyn-fp-next-line(reused-contract-name)
interface IMZUSD is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}
// aderyn-fp-next-line(reused-contract-name)
interface ITranche {
    function totalAssets() external view returns (uint256 assets);
}
// aderyn-fp-next-line(reused-contract-name)
interface IVaultEpoch {
    function advanceEpoch() external returns (uint256 newEpochId);
}

/// @title LossManager
/// @notice Burns mzUSD from tranches in predefined order to materialize protocol losses
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract LossManager is
    Initializable,
    AccessManagedUpgradeable,
    UUPSUpgradeable,
    PauseManagedUpgradeable
{
    uint256 public constant USDC_DECIMALS = 6;
    uint256 public constant MZ_DECIMALS = 18;
    uint256 public constant SCALE = 10 ** (MZ_DECIMALS - USDC_DECIMALS); // 1e12

    IMZUSD public mzusd; // protocol stablecoin contract
    address[] public trancheOrder; // order to burn from
    uint256 public maxLossPerTxUSDC; // 0 = no limit
    address public vault; // vault reference for mandatory epoch advancement

    /// @notice Optional group id for proportional loss sharing across a PAIR of tranches.
    /// @dev If trancheOrder[i] and trancheOrder[i+1] are contiguous and share the same non-zero group id,
    ///      then they form a pair and share losses proportionally by TVL (totalAssets).
    mapping(address => uint256) public trancheGroup;
    address public navOracle; // canonical NAV automation address

    event TrancheGroupUpdated(
        address indexed trancheA,
        address indexed trancheB,
        uint256 indexed groupId
    );
    event LossApplied(uint256 usdcLoss, uint256 lossMZ, address[] tranches, uint256[] cutsMZ);
    event TrancheOrderUpdated(address[] newOrder);
    event MaxLossPerTxUpdated(uint256 newLimitUSDC);
    event NavOracleUpdated(address newNavOracle);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroLength();
    error SameValue();
    error DuplicateTranche(address tranche);
    error InsufficientCover(uint256 remainingMZ);
    error LimitExceeded();
    error GroupIdAlreadyAssigned(uint256 groupId);
    error GroupNotContiguous(uint256 groupId);
    error LengthMismatch(uint256 orderLen, uint256 groupLen);
    event VaultUpdated(address indexed vault);
    error NotNavOracle();

    constructor() {
        _disableInitializers();
    }

    /// @param accessManager controls access to restricted functions
    /// @param pauseManager pause manager address for category-based pauses
    /// @param _mzusd protocol stablecoin contract
    /// @param _vault vault contract used to advance epochs
    /// @param order tranche burn order
    /// @param groupIds group ids aligned with order
    /// @param _maxLossPerTxUSDC - max loss per tx in USDC 6d (0 = no limit)
    function initialize(
        address accessManager,
        address pauseManager,
        address _mzusd,
        address _vault,
        address[] memory order,
        uint256[] memory groupIds,
        uint256 _maxLossPerTxUSDC
    ) external initializer {
        if (accessManager == address(0) || _mzusd == address(0) || _vault == address(0)) {
            revert ZeroAddress();
        }

        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager);
        mzusd = IMZUSD(_mzusd);
        vault = _vault;
        emit VaultUpdated(_vault);
        _setTrancheOrderAndGroups(order, groupIds);
        maxLossPerTxUSDC = _maxLossPerTxUSDC;
    }

    modifier onlyNavOracle() {
        if (msg.sender != navOracle) revert NotNavOracle();
        _;
    }

    // @notice applies loss denominated in USDC 6d, burns mzUSD 18d from tranches in order
    function applyLoss(
        uint256 usdcLoss
    ) external onlyNavOracle whenNotPaused(PauseCategory.PROTOCOL) {
        if (usdcLoss == 0) revert ZeroAmount();
        if (maxLossPerTxUSDC != 0 && usdcLoss > maxLossPerTxUSDC) revert LimitExceeded();

        // Advance the epoch as part of loss materialization so epoch-based withdrawal flows
        // do not get stuck in periods where yield is zero but losses are applied.
        address v = vault;
        if (v == address(0)) revert ZeroAddress();
        // Hard-fail if epoch cannot be advanced (e.g., too soon / missing permissions).
        IVaultEpoch(v).advanceEpoch();

        uint256 remainingMZ = _toMZ(usdcLoss);
        uint256 orderLen = trancheOrder.length;
        uint256[] memory cuts = new uint256[](orderLen);

        remainingMZ = _applyLossAcrossOrder(remainingMZ, cuts);
        if (remainingMZ > 0) revert InsufficientCover(remainingMZ);

        emit LossApplied(usdcLoss, _toMZ(usdcLoss), _copyOrder(orderLen), cuts);
    }

    //SETTERS

    // @notice sets tranche burn order and group pairing in one call
    function setTrancheOrderAndGroups(
        address[] memory order,
        uint256[] memory groupIds
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        _setTrancheOrderAndGroups(order, groupIds);
    }

    /// @notice Update NAV oracle automation address.
    function setNavOracle(
        address _navOracle
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (_navOracle == address(0)) revert ZeroAddress();
        if (navOracle == _navOracle) revert SameValue();
        navOracle = _navOracle;
        emit NavOracleUpdated(_navOracle);
    }

    // @notice sets max loss per tx in USDC 6d (0 = no limit)
    function setMaxLossPerTxUSDC(
        uint256 maxLossValue
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        maxLossPerTxUSDC = maxLossValue;
        emit MaxLossPerTxUpdated(maxLossValue);
    }

    //GETTERS

    function trancheOrderLength() external view returns (uint256 length) {
        length = trancheOrder.length;
    }

    function getTrancheOrder() external view returns (address[] memory order) {
        uint256 orderLen = trancheOrder.length;
        order = new address[](orderLen);
        for (uint256 i; i < orderLen; ++i) {
            order[i] = trancheOrder[i];
        }
    }

    function getTrancheOrderAndGroups()
        external
        view
        returns (address[] memory order, uint256[] memory groupIds)
    {
        uint256 orderLen = trancheOrder.length;
        order = new address[](orderLen);
        groupIds = new uint256[](orderLen);

        for (uint256 i; i < orderLen; ++i) {
            address tranche = trancheOrder[i];
            order[i] = tranche;
            groupIds[i] = trancheGroup[tranche];
        }
    }

    //INTERNAL HELPERS

    function _setTrancheOrderAndGroups(address[] memory order, uint256[] memory groupIds) internal {
        _validateTrancheConfig(order, groupIds);

        uint256 oldLen = trancheOrder.length;
        for (uint256 i; i < oldLen; ++i) {
            trancheGroup[trancheOrder[i]] = 0;
        }

        trancheOrder = order;

        uint256 orderLen = order.length;
        for (uint256 i; i < orderLen; ++i) {
            trancheGroup[order[i]] = groupIds[i];
        }

        emit TrancheOrderUpdated(order);
        _emitGroupUpdates(order, groupIds);
    }

    function _emitGroupUpdates(address[] memory order, uint256[] memory groupIds) internal {
        uint256 orderLen = order.length;
        for (uint256 i; i < orderLen; ) {
            uint256 gid = groupIds[i];
            if (gid == 0) {
                ++i;
                continue;
            }
            emit TrancheGroupUpdated(order[i], order[i + 1], gid);
            i += 2;
        }
    }

    function _toMZ(uint256 usdcAmount) internal pure returns (uint256 mzAmount) {
        mzAmount = usdcAmount * SCALE;
    }

    function _validateTrancheConfig(
        address[] memory order,
        uint256[] memory groupIds
    ) internal pure {
        uint256 orderLen = order.length;
        if (orderLen == 0) revert ZeroLength();
        if (groupIds.length != orderLen) {
            revert LengthMismatch(orderLen, groupIds.length);
        }

        for (uint256 i; i < orderLen; ++i) {
            address tranche = order[i];
            if (tranche == address(0)) revert ZeroAddress();
            for (uint256 j = 0; j < i; ++j) {
                if (order[j] == tranche) revert DuplicateTranche(tranche);
            }
        }

        uint256[] memory seenGroupIds = new uint256[](orderLen);
        uint256 seenCount;
        for (uint256 i; i < orderLen; ) {
            uint256 gid = groupIds[i];
            if (gid == 0) {
                ++i;
                continue;
            }

            if (i + 1 >= orderLen) revert GroupNotContiguous(gid);
            if (groupIds[i + 1] != gid) revert GroupNotContiguous(gid);

            for (uint256 j = 0; j < seenCount; ++j) {
                if (seenGroupIds[j] == gid) revert GroupIdAlreadyAssigned(gid);
            }
            seenGroupIds[seenCount++] = gid;
            i += 2;
        }
    }

    // @notice burns up to remainingMZ from tranches in order, returns any leftover amount
    function _applyLossAcrossOrder(
        uint256 remainingMZ,
        uint256[] memory cuts
    ) internal returns (uint256 remainingMZOut) {
        uint256 orderLen = trancheOrder.length;
        uint256 i = 0;

        while (i < orderLen && remainingMZ > 0) {
            (uint256 nextI, uint256 burned) = _applyLossStep(i, remainingMZ, cuts);
            remainingMZ -= burned;
            i = nextI;
        }

        remainingMZOut = remainingMZ;
    }

    // @notice applies loss step at index i, returns next index and amount burned
    function _applyLossStep(
        uint256 i,
        uint256 remainingMZ,
        uint256[] memory cuts
    ) internal returns (uint256 nextI, uint256 burned) {
        // Pair-mode is enabled only if trancheOrder[i] and trancheOrder[i+1] share the same non-zero group id.
        address t0 = trancheOrder[i];
        (bool isPair, address t1) = _pairAt(i, t0);
        if (!isPair) {
            return _burnSequential(i, t0, remainingMZ, cuts);
        }
        return _burnPair(i, remainingMZ, cuts, t0, t1);
    }

    // @notice checks if trancheOrder[i] and trancheOrder[i+1] form a pair, returns info
    function _pairAt(uint256 i, address t0) internal view returns (bool isPair, address t1) {
        uint256 orderLen = trancheOrder.length;
        uint256 gid = trancheGroup[t0];
        if (gid == 0 || i + 1 >= orderLen) return (false, address(0));

        t1 = trancheOrder[i + 1];
        if (trancheGroup[t1] != gid) return (false, address(0));

        return (true, t1);
    }

    // @notice gets totalAssets (TVL) of a tranche
    function _tvl(address tranche) internal view returns (uint256 tvl) {
        tvl = ITranche(tranche).totalAssets();
    }

    // @notice burns from a single tranche at index i, returns next index and amount burned
    function _burnSequential(
        uint256 i,
        address t0,
        uint256 remainingMZ,
        uint256[] memory cuts
    ) internal returns (uint256 nextI, uint256 burned) {
        uint256 tvl0 = _tvl(t0);
        if (tvl0 == 0) return (i + 1, 0);

        uint256 toBurn0 = tvl0 < remainingMZ ? tvl0 : remainingMZ;
        _burnAndRecord(t0, toBurn0, cuts, i);
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
        if (lossForPair == pairTVL) {
            _burnAndRecord(t0, tvl0, cuts, i);
            _burnAndRecord(t1, tvl1, cuts, i + 1);
            return (i + 2, lossForPair);
        }
        (uint256 burn0, uint256 burn1) = _splitPair(lossForPair, tvl0, tvl1, pairTVL);

        _burnAndRecord(t0, burn0, cuts, i);
        _burnAndRecord(t1, burn1, cuts, i + 1);

        return (i + 2, lossForPair);
    }

    function _burnAndRecord(
        address tranche,
        uint256 amount,
        uint256[] memory cuts,
        uint256 idx
    ) internal {
        if (amount == 0) return;
        mzusd.burn(tranche, amount);
        cuts[idx] = amount;
    }

    function _splitPair(
        uint256 lossForPair,
        uint256 tvl0,
        uint256 tvl1,
        uint256 pairTVL
    ) internal pure returns (uint256 burn0, uint256 burn1) {
        // Proportional split (floor)
        burn0 = (lossForPair * tvl0) / pairTVL;
        burn1 = (lossForPair * tvl1) / pairTVL;

        // Allocate rounding remainder - prefer first tranche then second.
        uint256 rem = lossForPair - (burn0 + burn1);
        if (rem != 0) {
            uint256 cap0 = tvl0 - burn0;
            uint256 add0 = cap0 < rem ? cap0 : rem;
            burn0 += add0;
            rem -= add0;
        }
        if (rem != 0) {
            uint256 cap1 = tvl1 - burn1;
            uint256 add1 = cap1 < rem ? cap1 : rem;
            burn1 += add1;
            rem -= add1;
        }
        if (rem != 0) revert InsufficientCover(rem);
    }

    // @notice creates a copy of the current tranche order for event emission
    function _copyOrder(uint256 orderLen) internal view returns (address[] memory orderCopy) {
        orderCopy = new address[](orderLen);
        for (uint256 j = 0; j < orderLen; ++j) {
            orderCopy[j] = trancheOrder[j];
        }
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function,
    // AccessManager should be configured to restrict call to upgradeToAndCall function,
    // as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
