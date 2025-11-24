// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";

interface IReservoir {
    function deposit(uint256 amount) external;

    function withdraw(uint256 amount, address to) external;
}

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
    UUPSUpgradeable,
    IReservoir
{
    using SafeERC20 for IERC20;

    IERC20 public usdc;

    IStrategy[] internal _strategies; // version 2: list of strategies
    mapping(IStrategy => bool) internal _isStrategy; // version 2: quick check
    mapping(IStrategy => uint256) internal _strategyCap; // version 2: optional per-strategy cap

    uint256 internal _minKeepInReservoir; // version 2: do not invest below this

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAmount();
    error InsufficientBalance();
    error ZeroAddress();

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _usdc,
        address accessManager
    ) external initializer {
        if (_usdc == address(0) || accessManager == address(0)) {
            revert ZeroAddress();
        }

        __AccessManaged_init(accessManager);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        usdc = IERC20(_usdc);
    }

    /// @notice Vault calls this when it wants to park USDC here.
    function deposit(uint256 amount) external override restricted nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(_msgSender(), address(this), amount);
        emit Deposited(_msgSender(), amount);
    }

    /// @notice Vault calls this when it wants to pull USDC back.
    function withdraw(
        uint256 amount,
        address to
    ) external override restricted nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        uint256 bal = usdc.balanceOf(address(this));
        if (bal < amount) revert InsufficientBalance();

        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice helper to see how much USDC is parked
    function totalAssets() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override restricted {}
}
