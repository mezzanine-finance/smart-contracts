// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
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
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    address public polPayout;

    event PolPayoutUpdated(address payout);
    event PolPayout(uint256 amount);
    event PolPayoutHookFailed(address indexed payout, uint256 amount);

    error ZeroAddress();
    error ZeroYieldPassed();

    constructor() {
        _disableInitializers();
    }

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
        __Pausable_init();
        __UUPSUpgradeable_init();

        polPayout = polPayoutAddress;
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

    function setPolPayout(address payout) external restricted {
        if (payout == address(0)) revert ZeroAddress();
        polPayout = payout;
        emit PolPayoutUpdated(payout);
    }

    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override restricted {}
}
