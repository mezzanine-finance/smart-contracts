// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// solhint-disable-next-line max-line-length
import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PauseManagedUpgradeable} from "./pause/PauseManagedUpgradeable.sol";
import {PauseCategory} from "./pause/PauseCategory.sol";
import {IPauseManager} from "./pause/IPauseManager.sol";
import {IMZUSD} from "./interfaces/IMZUSD.sol";
import {ITranche} from "./interfaces/ITranche.sol";
import {IVault} from "./interfaces/IVault.sol";

/// @title LossManager
/// @notice Burns MZUSD from tranches in configured order to materialize protocol losses.
/// @dev Tranche order and pairing are owned by the Vault; LossManager queries them at runtime.
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract LossManager is AccessManagedUpgradeable, UUPSUpgradeable, PauseManagedUpgradeable {
    uint256 public constant SCALE = 1e12; // USDC 6d -> MZUSD 18d

    /// @notice Protocol stablecoin contract.
    IMZUSD public mzusd;
    /// @notice Max loss allowed per transaction in USDC 6d (0 disables the limit).
    uint256 public maxLossPerTxUSDC;
    /// @notice IssuanceVault reference used for mandatory epoch advancement on every loss apply.
    address public immutable vault;

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
    /// @notice Emitted when max loss per transaction is updated.
    /// @param newLimitUSDC New max loss value in USDC 6 decimals.
    event MaxLossPerTxUpdated(uint256 newLimitUSDC);

    /// @notice Thrown when an address argument is zero.
    error ZeroAddress();
    /// @notice Thrown when amount is zero for a non-zero-required operation.
    error ZeroAmount();
    /// @notice Thrown when configured max per tx limit is exceeded.
    error LimitExceeded();
    /// @notice Thrown when caller is not configured NAV oracle.
    error NotNavOracle();
    /// @notice Thrown when requested loss exceeds current MZUSD total supply scaled to USDC.
    error LossExceedsTotalSupply(uint256 usdcLoss, uint256 totalSupplyUSDC);
    /// @notice Thrown when a setter is called with the same value as the current state.
    error SameValue();

    /// @notice Disable initializer on implementation contract and set immutable vault.
    /// @param vaultAddress IssuanceVault address; must be non-zero.
    constructor(address vaultAddress) {
        if (vaultAddress == address(0)) revert ZeroAddress();
        vault = vaultAddress;
        _disableInitializers();
    }

    /// @notice Initialize LossManager.
    /// @dev AccessManager and PauseManager are sourced from the provided MZUSD contract.
    /// @param _maxLossPerTxUSDC Max loss per tx in USDC 6d (0 disables the limit).
    function initialize(uint256 _maxLossPerTxUSDC) external initializer {
        IMZUSD token = IMZUSD(IVault(vault).mzusd());
        address accessManager = token.authority();
        address pauseManager_ = token.pauseManager();
        if (accessManager == address(0)) revert ZeroAddress();

        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);

        mzusd = token;
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

    /// @notice Set max loss per tx in USDC 6d; 0 disables the limit.
    /// @param maxLossValue Max loss value in USDC 6 decimals.
    function setMaxLossPerTxUSDC(
        uint256 maxLossValue
    ) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (maxLossPerTxUSDC == maxLossValue) revert SameValue();
        maxLossPerTxUSDC = maxLossValue;
        emit MaxLossPerTxUpdated(maxLossValue);
    }

    // INTERNAL HELPERS

    /// @notice Converts USDC 6-decimal amount to MZUSD 18-decimal amount.
    /// @param usdcAmount USDC amount in 6 decimals.
    /// @return mzAmount MZUSD amount in 18 decimals.
    function _toMZ(uint256 usdcAmount) internal pure returns (uint256 mzAmount) {
        mzAmount = usdcAmount * SCALE;
    }

    /// @notice Burns up to `requestedMZ` from tranches by order configured in the Vault.
    /// @param requestedMZ Requested loss amount in MZUSD 18 decimals.
    /// @return burnedMZ Total amount actually burned in MZUSD 18 decimals.
    /// @return uncoveredMZ Uncovered remainder in MZUSD 18 decimals.
    /// @dev Applies proportional split inside configured pairs and sequential burn for solo tranches.
    ///      Tranches paused under `PauseCategory.PROTOCOL` are treated as zero TVL:
    ///      solo paused tranches are skipped; in pair mode the unpaused side absorbs the full pair loss.
    function _applyLossAcrossOrder(
        uint256 requestedMZ
    ) internal returns (uint256 burnedMZ, uint256 uncoveredMZ) {
        IVault vaultRef = IVault(vault);
        address[] memory order = vaultRef.getTrancheOrder();
        uint256 orderLen = order.length;
        IPauseManager pauseMgr = IPauseManager(pauseManager());

        // Remaining amount is progressively reduced as cuts are applied by order.
        uint256 remainingMZ = requestedMZ;

        for (uint256 i; remainingMZ != 0 && i < orderLen; ) {
            address t0 = order[i];
            address t1 = vaultRef.tranchePairedTo(t0);

            // Process pair only at the left side to keep a single linear pass
            // and avoid re-processing the second tranche.
            if (i + 1 < orderLen && t1 != address(0) && order[i + 1] == t1) {
                uint256 burnedPair = _applyLossToPair(pauseMgr, t0, t1, remainingMZ);
                burnedMZ += burnedPair;
                remainingMZ -= burnedPair;
                i += 2;
                continue;
            }

            // Solo tranche: skip if paused; otherwise consume as much as possible from its TVL.
            if (!pauseMgr.isPaused(t0, PauseCategory.PROTOCOL)) {
                uint256 tvl = ITranche(t0).totalAssets();
                if (tvl != 0) {
                    uint256 burnAmount = tvl < remainingMZ ? tvl : remainingMZ;
                    ITranche(t0).burnMZUSD(burnAmount);
                    burnedMZ += burnAmount;
                    remainingMZ -= burnAmount;
                }
            }

            ++i;
        }

        // Any remainder is intentionally preserved as uncovered loss.
        uncoveredMZ = remainingMZ;
    }

    /// @notice Apply loss to a paired tranche slot; paused sides are treated as zero TVL.
    /// @param pauseMgr Pause manager used to query per-tranche PROTOCOL pause state.
    /// @param t0 First tranche in the pair.
    /// @param t1 Second tranche in the pair.
    /// @param remainingMZ Remaining loss budget in MZUSD 18 decimals.
    /// @return burnedPair Total burned across the pair in MZUSD 18 decimals.
    function _applyLossToPair(
        IPauseManager pauseMgr,
        address t0,
        address t1,
        uint256 remainingMZ
    ) internal returns (uint256 burnedPair) {
        // Paused side is treated as zero TVL so the unpaused side absorbs the full pair loss.
        uint256 tvl0 = pauseMgr.isPaused(t0, PauseCategory.PROTOCOL)
            ? 0
            : ITranche(t0).totalAssets();
        uint256 tvl1 = pauseMgr.isPaused(t1, PauseCategory.PROTOCOL)
            ? 0
            : ITranche(t1).totalAssets();
        uint256 pairTVL = tvl0 + tvl1;
        if (pairTVL == 0) return 0;

        uint256 lossForPair = pairTVL < remainingMZ ? pairTVL : remainingMZ;
        (uint256 burn0, uint256 burn1) = _splitPair(lossForPair, tvl0, pairTVL);

        if (burn0 != 0) ITranche(t0).burnMZUSD(burn0);
        if (burn1 != 0) ITranche(t1).burnMZUSD(burn1);

        burnedPair = burn0 + burn1;
    }

    /// @notice Split `lossForPair` proportionally by TVL between two paired tranches.
    /// @param lossForPair Loss amount allocated to the pair.
    /// @param tvl0 TVL of first tranche.
    /// @param pairTVL Combined TVL of the pair (`tvl0 + tvl1`).
    /// @return burn0 Burn amount for first tranche.
    /// @return burn1 Burn amount for second tranche.
    /// @dev Computes tranche 0 via floor division and derives tranche 1 by
    ///      subtraction. Callers must ensure `lossForPair <= pairTVL`; under
    ///      that invariant `burn1 <= tvl1` holds because
    ///      `floor(loss*tvl0/pairTVL) >= loss - tvl1`, so no cap-overflow
    ///      handling is required. The 1-wei floor-rounding residue lands on
    ///      tranche 1.
    function _splitPair(
        uint256 lossForPair,
        uint256 tvl0,
        uint256 pairTVL
    ) internal pure returns (uint256 burn0, uint256 burn1) {
        burn0 = (lossForPair * tvl0) / pairTVL;
        burn1 = lossForPair - burn0;
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function,
    // AccessManager should be configured to restrict call to upgradeToAndCall function,
    // as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
