// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";
import "./interfaces/IVault.sol";
import "./interfaces/IMZUSD.sol";

/// @title POL Junior Tranche
/// @notice Admin-managed protocol-owned-liquidity tranche for treasury/POL operations.
/// @notice This is NOT a standard public user investment tranche:
///         withdrawals are `restricted` and controlled by AccessManager policy.
/// @notice Yield sent by IssuanceVault is forwarded immediately to `polPayout` (no streaming, no umbrella queue).
/// @notice Despite governance/ops control, this tranche still participates in loss realization via LossManager `applyLoss`.
/// @notice When configured in the same LossManager group as the regular Junior tranche, losses are split proportionally by TVL within that group.
/// @notice There is no deposit function; admins fund by transferring MZUSD directly to this contract.
/// @notice Anyone can transfer MZUSD into this contract, but only admins can withdraw.
/// @dev Intended usage is protocol treasury liquidity management; governance/ops roles decide who can exit.
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract PolJuniorTranche is AccessManagedUpgradeable, UUPSUpgradeable, PauseManagedUpgradeable {
    address public immutable vault;
    IMZUSD public mzusd;
    address public polPayout;

    event PolPayoutUpdated(address payout);
    event PolPayoutNotified(uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroYieldPassed();
    error NotVault();
    error NotLossManager();
    error SameValue();
    error InvalidMZUSDAccessManager(address actual);

    /// @notice Disable initializer on implementation contract and set immutable vault reference.
    /// @param vaultAddress IssuanceVault address; must be non-zero.
    constructor(address vaultAddress) {
        if (vaultAddress == address(0)) revert ZeroAddress();
        vault = vaultAddress;
        _disableInitializers();
    }

    /// @notice Initialize the POL Junior Tranche.
    /// @param polPayoutAddress Address that receives forwarded yield; must be non-zero.
    /// @dev MZUSD, AccessManager, and PauseManager are resolved from the IssuanceVault-linked MZUSD.
    function initialize(address polPayoutAddress) external initializer {
        (IMZUSD mzusdToken, address accessManager, address pauseManager_) = _resolveCoreContracts(
            polPayoutAddress
        );

        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);

        mzusd = mzusdToken;
        polPayout = polPayoutAddress;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    modifier onlyLossManager() {
        if (msg.sender != IVault(vault).lossManager()) revert NotLossManager();
        _;
    }

    /// @notice Total MZUSD assets parked in this tranche.
    /// @return MZUSD balance of this contract (18 decimals).
    function totalAssets() public view returns (uint256) {
        return mzusd.balanceOf(address(this));
    }

    /// @notice Withdraw MZUSD from the POL tranche.
    /// @param assets Amount of MZUSD to withdraw (18 decimals); must be > 0.
    /// @param receiver Address that receives the withdrawn MZUSD; must be non-zero.
    /// @dev Restricted admin flow: not a permissionless user exit path.
    function withdraw(
        uint256 assets,
        address receiver
    ) external restricted whenNotPaused(PauseCategory.WITHDRAWALS) {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        mzusd.transfer(receiver, assets);
        emit Withdrawn(receiver, assets);
    }

    /// @notice IssuanceVault calls this after transferring `yieldAmount` of MZUSD to this contract.
    /// @param yieldAmount Amount of MZUSD yield to forward (18 decimals); must be > 0.
    /// @dev Forwards yield immediately to `polPayout`; POL tranche does not stream yield over epochs.
    function notifyYield(
        uint256 yieldAmount
    ) external onlyVault whenNotPaused(PauseCategory.PROTOCOL) {
        if (yieldAmount == 0) revert ZeroYieldPassed();
        mzusd.transfer(polPayout, yieldAmount);
        emit PolPayoutNotified(yieldAmount);
    }

    /// @notice Burn MZUSD from this tranche (used by LossManager).
    /// @param amount Amount of MZUSD to burn (18 decimals).
    /// @dev Burns only this contract's own asset balance via MZUSD burn access controls.
    /// @dev For grouped loss application (with Junior tranche), the burned amount is this tranche's proportional share computed by LossManager.
    function burnMZUSD(
        uint256 amount
    ) external onlyLossManager whenNotPaused(PauseCategory.PROTOCOL) {
        mzusd.burn(amount);
    }

    /// @notice Update POL yield payout address.
    /// @param payout New payout address; must be non-zero.
    /// @dev Restricted admin operation.
    function setPolPayout(address payout) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (payout == address(0)) revert ZeroAddress();
        if (polPayout == payout) revert SameValue();
        polPayout = payout;
        emit PolPayoutUpdated(payout);
    }

    function _resolveCoreContracts(
        address polPayoutAddress
    ) internal view returns (IMZUSD mzusdToken, address accessManager, address pauseManager_) {
        if (polPayoutAddress == address(0)) revert ZeroAddress();

        mzusdToken = IMZUSD(IVault(vault).mzusd());

        accessManager = mzusdToken.authority();
        if (accessManager == address(0)) {
            revert InvalidMZUSDAccessManager(accessManager);
        }

        pauseManager_ = mzusdToken.pauseManager();
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
