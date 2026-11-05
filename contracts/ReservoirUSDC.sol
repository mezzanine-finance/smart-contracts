// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "./pause/PauseManagedUpgradeable.sol";
import "./pause/PauseCategory.sol";

// @dev This disables false positive by aderyn static analysis tool, it sees payable in upgradeToAndCall and raises an error about locking ether.
// aderyn-fp-next-line(contract-locks-ether)
/// @title ReservoirUSDC
/// @notice Holds excess idle USDC on behalf of the IssuanceVault; vault deposits when above hysteresis
///         upper bound and withdraws when below the lower bound.
/// @dev Only the vault (via AccessManager) can withdraw. External operators may deposit to provide liquidity.
contract ReservoirUSDC is AccessManagedUpgradeable, UUPSUpgradeable, PauseManagedUpgradeable {
    /// @notice USDC token contract (6 decimals).
    IERC20 public immutable usdc;

    /// @notice IssuanceVault address; set once via `setVault`.
    address public vault;
    /// @notice Cumulative USDC deposited by each non-vault address.
    mapping(address => uint256) public depositedBy;
    /// @notice Cumulative USDC withdrawn to each non-vault address.
    mapping(address => uint256) public withdrawnTo;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event VaultUpdated(address indexed vault);

    error ZeroAmount();
    error ZeroAddress();
    error VaultAlreadySet();

    /// @notice Disable initializer on implementation contract and set immutable USDC token reference.
    /// @param _usdc USDC token address; must be non-zero.
    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _disableInitializers();
    }

    /// @notice Initialize the Reservoir.
    /// @param accessManager AccessManager address; must be non-zero.
    /// @param pauseManager_ PauseManager address for category-based pauses.
    function initialize(address accessManager, address pauseManager_) external initializer {
        if (accessManager == address(0)) {
            revert ZeroAddress();
        }

        __AccessManaged_init(accessManager);
        __PauseManaged_init(pauseManager_);
    }

    /// @notice Set master vault address for tracking (one-time).
    /// @param _vault IssuanceVault address; must be non-zero. Reverts if already set.
    function setVault(address _vault) external restricted {
        if (_vault == address(0)) revert ZeroAddress();
        if (vault != address(0)) revert VaultAlreadySet();
        vault = _vault;
        emit VaultUpdated(_vault);
    }

    /// @notice Deposit USDC into the Reservoir.
    /// @param amount USDC amount to deposit (6 decimals); must be > 0.
    /// @dev Typically called by the IssuanceVault to move idle USDC into the Reservoir.
    /// @dev Can also be called by external operators to provide USDC liquidity for the master vault.
    function deposit(uint256 amount) external whenNotPaused(PauseCategory.PROTOCOL) {
        if (amount == 0) revert ZeroAmount();
        usdc.transferFrom(msg.sender, address(this), amount);
        if (!_isVault(msg.sender)) {
            depositedBy[msg.sender] += amount;
        }
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw USDC from the Reservoir.
    /// @param amount USDC amount to withdraw (6 decimals); must be > 0.
    /// @param to Recipient address; must be non-zero. USDC transfer reverts if balance is insufficient.
    /// @dev Called by the IssuanceVault to retrieve USDC from the Reservoir back into the master vault.
    function withdraw(
        uint256 amount,
        address to
    ) external restricted whenNotPaused(PauseCategory.PROTOCOL) {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        // USDC will revert if balance is insufficient
        usdc.transfer(to, amount);
        if (!_isVault(to)) {
            withdrawnTo[to] += amount;
        }
        emit Withdrawn(to, amount);
    }

    /// @notice Current USDC balance held by this Reservoir.
    /// @return balance USDC amount (6 decimals).
    function totalUSDC() external view returns (uint256 balance) {
        balance = usdc.balanceOf(address(this));
    }

    function _isVault(address actor) internal view returns (bool) {
        return actor == vault;
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address newImplementation) internal override restricted {}
}
