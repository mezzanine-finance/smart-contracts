// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title POL Junior Tranche
/// @notice Protocol-owned-liquidity tranche: deposits mint shares, withdrawals are instant (ERC4626),
///         and yield is forwarded immediately to polPayout (no yield streaming, no umbrella).
contract PolJuniorTranche is
    Initializable,
    ERC4626Upgradeable,
    AccessManagedUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    address public polPayout;

    event PolPayoutUpdated(address payout);
    event PolPayout(uint256 amount);
    event PolPayoutHookFailed(address indexed payout, uint256 amount);

    error ZeroAddress();
    error ZeroYieldPassed();
    error EthTransferFailed(address to, uint256 attemptedAmount);

    constructor() {
        _disableInitializers();
    }

    /// @notice Initializer
    /// @param assetToken - underlying asset token (MZUSD)
    /// @param name_ - tranche name
    /// @param symbol_ - tranche symbol
    /// @param accessManager - access manager address for role control
    /// @param polPayoutAddress - address to forward yield to
    function initialize(
        IERC20 assetToken,
        string memory name_,
        string memory symbol_,
        address accessManager,
        address polPayoutAddress
    ) external initializer {
        if (accessManager == address(0) || address(assetToken) == address(0)) revert ZeroAddress();
        if (polPayoutAddress == address(0)) revert ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC4626_init(assetToken);
        __AccessManaged_init(accessManager);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        polPayout = polPayoutAddress;
    }

    /// ERC4626 entry points (role-controlled via AccessManager)
    /// @dev AccessManager should set these to PUBLIC_ROLE
    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant restricted returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant restricted returns (uint256) {
        return super.mint(shares, receiver);
    }

    function transfer(
        address to,
        uint256 value
    ) public override(ERC20Upgradeable, IERC20) restricted returns (bool) {
        return super.transfer(to, value);
    }

    function approve(
        address spender,
        uint256 value
    ) public override(ERC20Upgradeable, IERC20) restricted returns (bool) {
        return super.approve(spender, value);
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) public override(ERC20Upgradeable, IERC20) restricted returns (bool) {
        return super.transferFrom(from, to, value);
    }

    // ERC4626 exit points (role-controlled via AccessManager)
    /// @dev AccessManager should set these to ADMIN_ROLE
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override nonReentrant restricted returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override nonReentrant restricted returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    /// @notice Vault calls this after transferring yieldAmount of MZUSD to this contract.
    /// @dev Forwards yield immediately to polPayout and optionally calls a hook on polPayout.
    function notifyYield(uint256 yieldAmount) external restricted {
        if (yieldAmount == 0) revert ZeroYieldPassed();
        address payout = polPayout;
        if (payout == address(0)) revert ZeroAddress();

        IERC20(asset()).safeTransfer(payout, yieldAmount);
        emit PolPayout(yieldAmount);
    }

    /// @notice Update polPayout address
    function setPolPayout(address payout) external restricted {
        if (payout == address(0)) revert ZeroAddress();
        polPayout = payout;
        emit PolPayoutUpdated(payout);
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

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override restricted {}
}
