// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IStrategy {
    function invest(uint256 amount) external returns (bool);
    function divest(uint256 amount) external returns (uint256);
    function harvest() external;
    function totalAssets() external view returns (uint256);
}

abstract contract BaseStrategy is Initializable, IStrategy, ContextUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    /* ---------- roles ----------*/
    bytes32 public constant HARVESTER_ROLE = keccak256("HARVESTER_ROLE");

    /* ---------- state ----------*/
    address public reservoir;
    IERC20  public usdc;

    /* ---------- modifiers ----------*/
    modifier onlyReservoir() {
        require(_msgSender() == reservoir, "Not reservoir");
        _;
    }

    modifier onlyHarvester() {
        require(hasRole(HARVESTER_ROLE, _msgSender()), "Not harvester");
        _;
    }

    /* ---------- init ----------*/
    function __BaseStrategy_init(address _admin, address _usdc, address _reservoir) internal onlyInitializing {
        __Context_init();
        __AccessControl_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        usdc = IERC20(_usdc);
        reservoir = _reservoir;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(HARVESTER_ROLE,     _admin);
    }

    /* ---------- IStrategy wrappers ----------*/
    function invest(uint256 amount) external virtual override onlyReservoir nonReentrant returns (bool) {
        _invest(amount);
        return true;
    }

    function divest(uint256 amount) external virtual override onlyReservoir nonReentrant returns (uint256) {
        return _divest(amount);
    }

    function harvest() external virtual override onlyHarvester nonReentrant {
        _harvest();
    }

    /* ---------- internal to override ----------*/
    function _invest(uint256 amount) internal virtual;
    function _divest(uint256 amount) internal virtual returns (uint256);
    function _harvest() internal virtual;

    /* ---------- UUPS ----------*/
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    uint256[50] private __gap;
}