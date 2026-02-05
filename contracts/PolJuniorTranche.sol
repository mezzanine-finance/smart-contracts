// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";
import "./interfaces/IVault.sol";
import "./interfaces/IMZUSD.sol";

/// @title POL Junior Tranche
/// @notice Admin-managed protocol-owned-liquidity tranche for treasury/POL operations.
/// @notice This is NOT a standard public user investment tranche:
///         withdrawals/redeems are `restricted` and controlled by AccessManager policy.
/// @notice Yield sent by Vault is forwarded immediately to `polPayout` (no streaming, no umbrella queue).
/// @notice Despite governance/ops control, this tranche still participates in loss realization via LossManager `applyLoss`.
/// @notice When configured in the same LossManager group as the regular Junior tranche, losses are split proportionally by TVL within that group.
/// @dev Intended usage is protocol treasury liquidity management; governance/ops roles decide who can exit.
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract PolJuniorTranche is
    ERC4626Upgradeable,
    AccessManagedUpgradeable,
    UUPSUpgradeable,
    PauseManagedUpgradeable
{
    using SafeERC20 for IERC20;

    address public immutable vault;
    address public polPayout;

    event PolPayoutUpdated(address payout);
    event PolPayoutNotified(uint256 amount);

    error PolPayoutNotSet();
    error ZeroAddress();
    error ZeroYieldPassed();
    error NotVault();
    error NotLossManager();
    error InvalidMZUSDAccessManager(address actual);
    error InvalidMZUSDPauseManager(address actual);
    error InvalidMZUSDVault(address actual);
    error InvalidPolPayout(address payout);
    error InvalidVault(address vaultAddress);

    constructor(address vaultAddress) {
        if (vaultAddress == address(0)) revert ZeroAddress();
        vault = vaultAddress;
        _disableInitializers();
    }

    /// @notice Initializer.
    /// @param assetToken Underlying asset token (MZUSD).
    /// @param vaultAddress Canonical Vault address allowed to notify yield (must match immutable vault).
    /// @param name_ Tranche name.
    /// @param symbol_ Tranche symbol.
    /// @param accessManager AccessManager address.
    /// @param pauseManager_ PauseManager address for category-based pauses.
    /// @param polPayoutAddress Yield payout recipient controlled by protocol governance/ops.
    function initialize(
        IERC20 assetToken,
        address vaultAddress,
        string memory name_,
        string memory symbol_,
        address accessManager,
        address pauseManager_,
        address polPayoutAddress
    ) external initializer {
        if (
            accessManager == address(0) ||
            address(assetToken) == address(0) ||
            vaultAddress == address(0)
        ) {
            revert ZeroAddress();
        }
        if (polPayoutAddress == address(0)) revert ZeroAddress();
        if (vaultAddress != vault) revert InvalidVault(vaultAddress);

        IMZUSD mzusd = IMZUSD(address(assetToken));
        address mzusdAccessManager = mzusd.authority();
        if (mzusdAccessManager != accessManager) {
            revert InvalidMZUSDAccessManager(mzusdAccessManager);
        }

        address mzusdPauseManager = mzusd.pauseManager();
        if (mzusdPauseManager != pauseManager_) {
            revert InvalidMZUSDPauseManager(mzusdPauseManager);
        }

        address mzusdVault = mzusd.vault();
        if (mzusdVault != address(0) && mzusdVault != vault) {
            revert InvalidMZUSDVault(mzusdVault);
        }

        if (polPayoutAddress == accessManager || polPayoutAddress == address(assetToken)) {
            revert InvalidPolPayout(polPayoutAddress);
        }

        __ERC20_init(name_, symbol_);
        __ERC4626_init(assetToken);
        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);

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

    /// @notice Deposit assets and mint shares.
    /// @dev Deposit is open, but this tranche is intended for protocol-controlled liquidity management.
    function deposit(uint256 assets, address receiver) public override returns (uint256 shares) {
        return super.deposit(assets, receiver);
    }

    /// @notice Mint shares by depositing assets.
    /// @dev Mint is open, but this tranche is intended for protocol-controlled liquidity management.
    function mint(uint256 shares, address receiver) public override returns (uint256 assets) {
        return super.mint(shares, receiver);
    }

    /// @notice Withdraw assets by burning shares.
    /// @dev Restricted admin flow: not a permissionless user exit path.
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override restricted returns (uint256 shares) {
        return super.withdraw(assets, receiver, owner);
    }

    /// @notice Redeem shares for assets.
    /// @dev Restricted admin flow: not a permissionless user exit path.
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override restricted returns (uint256 assets) {
        return super.redeem(shares, receiver, owner);
    }

    function transfer(
        address to,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused(PauseCategory.TRANSFERS)
        returns (bool success)
    {
        return super.transfer(to, value);
    }

    function approve(
        address spender,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused(PauseCategory.TRANSFERS)
        returns (bool success)
    {
        return super.approve(spender, value);
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused(PauseCategory.TRANSFERS)
        returns (bool success)
    {
        return super.transferFrom(from, to, value);
    }

    /// @notice Vault calls this after transferring `yieldAmount` of MZUSD to this contract.
    /// @dev Forwards yield immediately to `polPayout`; POL tranche does not stream yield over epochs.
    function notifyYield(
        uint256 yieldAmount
    ) external onlyVault whenNotPaused(PauseCategory.PROTOCOL) {
        if (yieldAmount == 0) revert ZeroYieldPassed();

        address payout = polPayout;
        if (payout == address(0)) revert PolPayoutNotSet();

        IERC20(asset()).safeTransfer(payout, yieldAmount);
        emit PolPayoutNotified(yieldAmount);
    }

    /// @notice Burn MZUSD from this tranche (used by LossManager).
    /// @dev Burns only this contract's own asset balance via MZUSD burn access controls.
    /// @dev For grouped loss application (with Junior tranche), the burned amount is this tranche's proportional share computed by LossManager.
    function burn(uint256 amount) external onlyLossManager whenNotPaused(PauseCategory.PROTOCOL) {
        IMZUSD(asset()).burn(amount);
    }

    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override whenNotPaused(PauseCategory.DEPOSITS) {
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override whenNotPaused(PauseCategory.WITHDRAWALS) {
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @notice Update POL yield payout address.
    /// @dev Restricted admin operation.
    function setPolPayout(address payout) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (payout == address(0)) revert ZeroAddress();
        polPayout = payout;
        emit PolPayoutUpdated(payout);
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
