// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";

// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
contract ReservoirUSDC is AccessManagedUpgradeable, UUPSUpgradeable, PauseManagedUpgradeable {
    IERC20 public immutable usdc;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _disableInitializers();
    }

    function initialize(address accessManager, address pauseManager_) external initializer {
        if (accessManager == address(0)) {
            revert ZeroAddress();
        }

        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);
    }

    /// @notice Typically called by the Vault to move idle USDC into the Reservoir.
    function deposit(uint256 amount) external whenNotPaused(PauseCategory.PROTOCOL) {
        if (amount == 0) revert ZeroAmount();
        usdc.transferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Called by the Vault to retrieve USDC from the Reservoir back into the Vault OR called by the Curators to move funds into the main fund to earn yield.
    function withdraw(
        uint256 amount,
        address to
    ) external restricted whenNotPaused(PauseCategory.PROTOCOL) {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        // USDC will revert if balance is insufficient
        usdc.transfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice Helper to see how much USDC is on balance
    function totalUSDC() external view returns (uint256 balance) {
        balance = usdc.balanceOf(address(this));
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address newImplementation) internal override restricted {}
}
