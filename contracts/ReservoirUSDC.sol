// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";

interface IStrategy {
    function invest(uint256 amount) external returns (bool);
    function divest(uint256 amount) external returns (uint256);
    function harvest() external;
    function totalAssets() external view returns (uint256);
}

contract ReservoirUSDC is
    Initializable,
    AccessManagedUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    IERC20 public immutable usdc;

    IStrategy[] internal _strategies; // version 2: list of strategies
    mapping(IStrategy => bool) internal _isStrategy; // version 2: quick check
    mapping(IStrategy => uint256) internal _strategyCap; // version 2: optional per-strategy cap

    uint256 internal _minKeepInReservoir; // version 2: do not invest below this

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error EthTransferFailed(address to, uint256 attemptedAmount);

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _disableInitializers();
    }

    function initialize(address accessManager) external initializer {
        if (accessManager == address(0)) {
            revert ZeroAddress();
        }

        __AccessManaged_init(accessManager);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
    }

    /// @notice Called by the Vault to move idle USDC into the Reservoir.
    function deposit(uint256 amount) external nonReentrant restricted {
        if (amount == 0) revert ZeroAmount();
        usdc.transferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Called by the Vault to retrieve USDC from the Reservoir back into the Vault.
    function withdraw(uint256 amount, address to) external nonReentrant restricted {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        // USDC will revert if balance is insufficient
        usdc.transfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice helper to see how much USDC is on balance
    function totalAssets() external view returns (uint256) {
        return usdc.balanceOf(address(this));
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

    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address newImplementation) internal override restricted {}
}
