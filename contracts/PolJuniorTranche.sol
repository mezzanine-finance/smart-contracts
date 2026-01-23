// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";

/// @title POL Junior Tranche
/// @notice Protocol-owned-liquidity tranche: deposits mint shares, withdrawals are instant (ERC4626),
///         and yield is forwarded immediately to polPayout (no yield streaming, no umbrella).
// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract PolJuniorTranche is
    Initializable,
    ERC4626Upgradeable,
    AccessManagedUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    PauseManagedUpgradeable
{
    using SafeERC20 for IERC20;

    address public vault;
    address public polPayout;

    event PolPayoutUpdated(address payout);
    event PolPayoutNotified(uint256 amount);

    error PolPayoutNotSet();
    error ZeroAddress();
    error ZeroYieldPassed();
    error NotVault();

    constructor() {
        _disableInitializers();
    }

    /// @notice Initializer
    /// @param assetToken - underlying asset token (MZUSD)
    /// @param vaultAddress - address of the Vault
    /// @param name_ - tranche name
    /// @param symbol_ - tranche symbol
    /// @param accessManager - access manager address for role control
    /// @param pauseManager_ - pause manager address for category-based pauses
    /// @param polPayoutAddress - address to forward yield to
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

        __ERC20_init(name_, symbol_);
        __ERC4626_init(assetToken);
        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);
        __ReentrancyGuard_init();

        vault = vaultAddress;
        polPayout = polPayoutAddress;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant whenNotPaused(PauseCategory.DEPOSITS) returns (uint256 shares) {
        return super.deposit(assets, receiver);
    }

    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant whenNotPaused(PauseCategory.DEPOSITS) returns (uint256 assets) {
        return super.mint(shares, receiver);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    )
        public
        override
        nonReentrant
        restricted
        whenNotPaused(PauseCategory.WITHDRAWALS)
        returns (uint256 shares)
    {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    )
        public
        override
        nonReentrant
        restricted
        whenNotPaused(PauseCategory.WITHDRAWALS)
        returns (uint256 assets)
    {
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

    /// @notice Vault calls this after transferring yieldAmount of MZUSD to this contract.
    /// @dev Forwards yield immediately to polPayout.
    function notifyYield(
        uint256 yieldAmount
    ) external onlyVault whenNotPaused(PauseCategory.PROTOCOL) {
        if (yieldAmount == 0) revert ZeroYieldPassed();

        address payout = polPayout;
        if (payout == address(0)) revert PolPayoutNotSet();

        IERC20(asset()).safeTransfer(payout, yieldAmount);
        emit PolPayoutNotified(yieldAmount);
    }

    /// @notice Update polPayout address
    function setPolPayout(address payout) external restricted whenNotPaused(PauseCategory.ADMIN) {
        if (payout == address(0)) revert ZeroAddress();
        polPayout = payout;
        emit PolPayoutUpdated(payout);
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
