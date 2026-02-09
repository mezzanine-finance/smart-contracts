// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// solhint-disable-next-line max-line-length
import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PauseManagedUpgradeable} from "./pause/PauseManagedUpgradeable.sol";
import {PauseCategory} from "./pause/PauseCategory.sol";
import {IMZUSD} from "./interfaces/IMZUSD.sol";
import {ITranche} from "./interfaces/ITranche.sol";
import {IVault} from "./interfaces/IVault.sol";

/// @title LossManager
/// @notice Burns MZUSD from tranches in configured order to materialize protocol losses.
/// @dev Pairing is encoded by contiguous flags in `isPairedWithNext`.
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract LossManager is AccessManagedUpgradeable, UUPSUpgradeable, PauseManagedUpgradeable {
    uint256 public constant SCALE = 1e12; // USDC 6d -> MZUSD 18d

    /// @notice Protocol stablecoin contract.
    IMZUSD public mzusd;
    /// @notice Burn priority order for loss application.
    address[] public trancheOrder;
    /// @notice Max loss allowed per transaction in USDC 6d (0 disables the limit).
    uint256 public maxLossPerTxUSDC;
    /// @notice Vault reference used for mandatory epoch advancement on every loss apply.
    address public immutable vault;

    /// @notice Pairing lookup. If non-zero, tranche shares loss with the paired tranche.
    mapping(address => address) public tranchePairedTo;

    /// @notice Uncovered loss from the latest `applyLoss` call (MZUSD 18d).
    uint256 public lastUncoveredLossMZ;
    /// @notice Total uncovered loss accumulated across all `applyLoss` calls (MZUSD 18d).
    uint256 public totalUncoveredLossMZ;

    /// @notice Emitted after each loss application.
    /// @param usdcLoss Requested loss in USDC 6d.
    /// @param requestedMZ Requested loss in MZUSD 18d.
    /// @param burnedMZ Burned amount in MZUSD 18d.
    /// @param uncoveredMZ Uncovered amount for this call in MZUSD 18d.
    /// @param totalUncoveredMZ Accumulated uncovered amount in MZUSD 18d.
    event LossApplied(
        uint256 usdcLoss,
        uint256 requestedMZ,
        uint256 burnedMZ,
        uint256 uncoveredMZ,
        uint256 totalUncoveredMZ
    );
    /// @notice Emitted when tranche order (and implied pair mapping) is updated.
    /// @param newOrder New tranche burn order.
    event TrancheOrderUpdated(address[] newOrder);
    /// @notice Emitted when max loss per transaction is updated.
    /// @param newLimitUSDC New max loss value in USDC 6 decimals.
    event MaxLossPerTxUpdated(uint256 newLimitUSDC);

    /// @notice Thrown when an address argument is zero.
    error ZeroAddress();
    /// @notice Thrown when amount is zero for a non-zero-required operation.
    error ZeroAmount();
    /// @notice Thrown when tranche order is empty.
    error ZeroLength();
    /// @notice Thrown when tranche order contains duplicate addresses.
    error DuplicateTranche(address tranche);
    /// @notice Thrown when configured max per tx limit is exceeded.
    error LimitExceeded();
    /// @notice Thrown when pair flags are malformed (must be contiguous `true,true`).
    error PairNotContiguous(uint256 index);
    /// @notice Thrown when order and pair-flags lengths differ.
    error LengthMismatch(uint256 orderLen, uint256 flagsLen);
    /// @notice Thrown when caller is not configured NAV oracle.
    error NotNavOracle();
    /// @notice Thrown when requested loss exceeds current MZUSD total supply scaled to USDC.
    error LossExceedsTotalSupply(uint256 usdcLoss, uint256 totalSupplyUSDC);

    /// @notice Disable initializer on implementation contract and set immutable vault.
    constructor(address vaultAddress) {
        if (vaultAddress == address(0)) revert ZeroAddress();
        vault = vaultAddress;
        _disableInitializers();
    }

    /// @notice Initialize LossManager.
    /// @dev AccessManager and PauseManager are sourced from the provided MZUSD contract.
    /// @param order Tranche burn order.
    /// @param isPairedWithNext Pairing flags aligned with `order`.
    /// @param _maxLossPerTxUSDC Max loss per tx in USDC 6d (0 disables the limit).
    function initialize(
        address[] memory order,
        bool[] memory isPairedWithNext,
        uint256 _maxLossPerTxUSDC
    ) external initializer {
        IMZUSD token = IMZUSD(IVault(vault).mzusd());
        address accessManager = token.authority();
        address pauseManager_ = token.pauseManager();
        if (accessManager == address(0)) revert ZeroAddress();

        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);

        mzusd = token;
        _setTrancheOrderAndPairs(order, isPairedWithNext);
        maxLossPerTxUSDC = _maxLossPerTxUSDC;
    }

    /// @notice Restricts access to the configured NAV oracle.
    modifier onlyNavOracle() {
        if (msg.sender != IVault(vault).navOracle()) revert NotNavOracle();
        _;
    }

    /// @notice Apply loss in USDC and burn MZUSD from tranches in configured order.
    /// @dev Does not revert when tranche TVL is insufficient: burns what is available and records uncovered remainder.
    /// @param usdcLoss Loss amount in USDC 6d.
    function applyLoss(
        uint256 usdcLoss
    ) external onlyNavOracle whenNotPaused(PauseCategory.PROTOCOL) {
        if (usdcLoss == 0) revert ZeroAmount();
        if (maxLossPerTxUSDC != 0 && usdcLoss > maxLossPerTxUSDC) revert LimitExceeded();

        uint256 totalSupplyUSDC = mzusd.totalSupply() / SCALE;
        if (usdcLoss > totalSupplyUSDC) {
            revert LossExceedsTotalSupply(usdcLoss, totalSupplyUSDC);
        }

        // Advance epoch as part of loss materialization so epoch-based withdrawal flows
        // do not get stuck in periods where yield is zero but losses are applied.
        // Hard-fail if epoch cannot be advanced (e.g., too soon / missing permissions).
        IVault(vault).advanceEpoch();

        (uint256 burnedMZ, uint256 uncoveredMZ) = _applyLossAcrossOrder(_toMZ(usdcLoss));

        lastUncoveredLossMZ = uncoveredMZ;
        if (uncoveredMZ != 0) {
            totalUncoveredLossMZ += uncoveredMZ;
        }

        emit LossApplied(usdcLoss, _toMZ(usdcLoss), burnedMZ, uncoveredMZ, totalUncoveredLossMZ);
    }

    // SETTERS

    /// @notice Set tranche burn order and pair flags in one call.
    /// @param order Tranche burn order.
    /// @param isPairedWithNext Pair flags aligned with `order`.
    /// @dev A valid pair is represented by two contiguous `true` flags.
    function setTrancheOrderAndPairs(
        address[] memory order,
        bool[] memory isPairedWithNext
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        _setTrancheOrderAndPairs(order, isPairedWithNext);
    }

    /// @notice Set max loss per tx in USDC 6d; 0 disables the limit.
    /// @param maxLossValue Max loss value in USDC 6 decimals.
    function setMaxLossPerTxUSDC(
        uint256 maxLossValue
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        maxLossPerTxUSDC = maxLossValue;
        emit MaxLossPerTxUpdated(maxLossValue);
    }

    // GETTERS

    /// @notice Returns configured tranche order length.
    function trancheOrderLength() external view returns (uint256 length) {
        length = trancheOrder.length;
    }

    /// @notice Returns current tranche burn order.
    function getTrancheOrder() external view returns (address[] memory order) {
        uint256 orderLen = trancheOrder.length;
        order = new address[](orderLen);
        for (uint256 i; i < orderLen; ++i) {
            order[i] = trancheOrder[i];
        }
    }

    /// @notice Returns current tranche order and pair flags.
    /// @dev Pair is represented symmetrically as `true,true` at indices `i` and `i+1`.
    function getTrancheOrderAndPairs()
        external
        view
        returns (address[] memory order, bool[] memory isPairedWithNext)
    {
        uint256 orderLen = trancheOrder.length;
        order = new address[](orderLen);
        isPairedWithNext = new bool[](orderLen);

        for (uint256 i; i < orderLen; ++i) {
            address tranche = trancheOrder[i];
            order[i] = tranche;
            if (i + 1 < orderLen && tranchePairedTo[tranche] == trancheOrder[i + 1]) {
                isPairedWithNext[i] = true;
                isPairedWithNext[i + 1] = true;
            }
        }
    }

    // INTERNAL HELPERS

    /// @notice Validates and applies tranche order and pair configuration.
    /// @param order Tranche burn order.
    /// @param isPairedWithNext Pair flags aligned with order.
    /// @dev Clears previous pair mapping before applying new config.
    function _setTrancheOrderAndPairs(
        address[] memory order,
        bool[] memory isPairedWithNext
    ) internal {
        _validateTrancheConfig(order, isPairedWithNext);

        // Clear old mapping to avoid stale pair links after reconfiguration.
        uint256 oldLen = trancheOrder.length;
        for (uint256 i; i < oldLen; ++i) {
            delete tranchePairedTo[trancheOrder[i]];
        }

        trancheOrder = order;

        // Build pair mapping from contiguous `true,true` flags.
        uint256 orderLen = order.length;
        for (uint256 i; i < orderLen; ) {
            if (!isPairedWithNext[i]) {
                ++i;
                continue;
            }

            address t0 = order[i];
            address t1 = order[i + 1];
            tranchePairedTo[t0] = t1;
            tranchePairedTo[t1] = t0;
            i += 2;
        }

        emit TrancheOrderUpdated(order);
    }

    /// @notice Converts USDC 6-decimal amount to MZUSD 18-decimal amount.
    /// @param usdcAmount USDC amount in 6 decimals.
    /// @return mzAmount MZUSD amount in 18 decimals.
    function _toMZ(uint256 usdcAmount) internal pure returns (uint256 mzAmount) {
        mzAmount = usdcAmount * SCALE;
    }

    /// @notice Validates tranche order and pair flags.
    /// @param order Tranche burn order.
    /// @param isPairedWithNext Pair flags aligned with order.
    /// @dev Validation checks:
    ///      - non-zero length
    ///      - matching lengths
    ///      - non-zero tranche addresses
    ///      - no duplicate tranches
    ///      - pairs must be contiguous `true,true`
    /// @dev Examples:
    ///      order=[A,B,C,D], flags=[false,true,true,false] -> valid pair (B,C)
    ///      order=[A,B,C,D], flags=[true,true,false,false] -> valid pair (A,B)
    ///      order=[A,B,C,D], flags=[true,false,true,false] -> invalid (non-contiguous)
    function _validateTrancheConfig(
        address[] memory order,
        bool[] memory isPairedWithNext
    ) internal pure {
        uint256 orderLen = order.length;
        if (orderLen == 0) revert ZeroLength();
        if (isPairedWithNext.length != orderLen) {
            revert LengthMismatch(orderLen, isPairedWithNext.length);
        }

        // Ensure order does not contain zero addresses or duplicates.
        for (uint256 i; i < orderLen; ++i) {
            address tranche = order[i];
            if (tranche == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                if (order[j] == tranche) revert DuplicateTranche(tranche);
            }
        }

        // Validate `true,true` pair encoding and contiguity.
        for (uint256 i; i < orderLen; ) {
            if (!isPairedWithNext[i]) {
                ++i;
                continue;
            }

            if (i + 1 >= orderLen) revert PairNotContiguous(i);
            if (!isPairedWithNext[i + 1]) revert PairNotContiguous(i);

            i += 2;
        }
    }

    /// @notice Burns up to `requestedMZ` from tranches by configured order.
    /// @param requestedMZ Requested loss amount in MZUSD 18 decimals.
    /// @return burnedMZ Total amount actually burned in MZUSD 18 decimals.
    /// @return uncoveredMZ Uncovered remainder in MZUSD 18 decimals.
    /// @dev Applies proportional split inside configured pairs and sequential burn for solo tranches.
    function _applyLossAcrossOrder(
        uint256 requestedMZ
    ) internal returns (uint256 burnedMZ, uint256 uncoveredMZ) {
        uint256 orderLen = trancheOrder.length;

        // Remaining amount is progressively reduced as cuts are applied by order.
        uint256 remainingMZ = requestedMZ;

        for (uint256 i; remainingMZ != 0 && i < orderLen; ) {
            // Current tranche and its optional paired tranche.
            address t0 = trancheOrder[i];
            address t1 = tranchePairedTo[t0];

            // Process pair only at the left side to keep a single linear pass
            // and avoid re-processing the second tranche.
            if (i + 1 < orderLen && t1 != address(0) && trancheOrder[i + 1] == t1) {
                uint256 tvl0 = ITranche(t0).totalAssets();
                uint256 tvl1 = ITranche(t1).totalAssets();
                uint256 pairTVL = tvl0 + tvl1;

                // Paired tranches split loss either by full pair TVL coverage
                // or proportionally by TVL when pair TVL exceeds remaining loss.
                if (pairTVL != 0) {
                    uint256 lossForPair = pairTVL < remainingMZ ? pairTVL : remainingMZ;
                    (uint256 burn0, uint256 burn1) = _splitPair(lossForPair, tvl0, tvl1, pairTVL);

                    if (burn0 != 0) {
                        ITranche(t0).burnMZUSD(burn0);
                        burnedMZ += burn0;
                    }

                    if (burn1 != 0) {
                        ITranche(t1).burnMZUSD(burn1);
                        burnedMZ += burn1;
                    }

                    remainingMZ -= (burn0 + burn1);
                }

                i += 2;
                continue;
            }

            // Solo tranche consumes as much loss as possible from its own TVL.
            uint256 tvl = ITranche(t0).totalAssets();
            if (tvl != 0) {
                uint256 burnAmount = tvl < remainingMZ ? tvl : remainingMZ;
                ITranche(t0).burnMZUSD(burnAmount);
                burnedMZ += burnAmount;
                remainingMZ -= burnAmount;
            }

            ++i;
        }

        // Any remainder is intentionally preserved as uncovered loss.
        uncoveredMZ = remainingMZ;
    }

    /// @notice Split `lossForPair` proportionally by TVL between two paired tranches.
    /// @param lossForPair Loss amount allocated to the pair.
    /// @param tvl0 TVL of first tranche.
    /// @param tvl1 TVL of second tranche.
    /// @param pairTVL Combined TVL of the pair.
    /// @return burn0 Burn amount for first tranche.
    /// @return burn1 Burn amount for second tranche.
    /// @dev Uses floor division, then assigns rounding remainder to tranche 0 first
    ///      and tranche 1 second, while preserving per-tranche TVL caps.
    function _splitPair(
        uint256 lossForPair,
        uint256 tvl0,
        uint256 tvl1,
        uint256 pairTVL
    ) internal pure returns (uint256 burn0, uint256 burn1) {
        // Proportional split with floor rounding.
        burn0 = (lossForPair * tvl0) / pairTVL;
        burn1 = (lossForPair * tvl1) / pairTVL;

        // Allocate rounding remainder: tranche 0 first, then tranche 1.
        uint256 rem = lossForPair - (burn0 + burn1);
        if (rem == 0) return (burn0, burn1);

        uint256 cap0 = tvl0 - burn0;
        if (rem > cap0) {
            burn0 += cap0;
            burn1 += (rem - cap0);
        } else {
            burn0 += rem;
        }
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function,
    // AccessManager should be configured to restrict call to upgradeToAndCall function,
    // as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
