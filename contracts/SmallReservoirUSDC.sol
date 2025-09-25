// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";


interface IStrategy {
    function invest(uint256 amount) external returns (bool);
    function divest(uint256 amount) external returns (uint256);
    function harvest() external;
    function totalAssets() external view returns (uint256);
}

contract SmallReservoirUSDC is Initializable, AccessManagedUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    /* ---------- roles ----------*/
    bytes32 public constant VAULT_ROLE           = keccak256("VAULT_ROLE");
    bytes32 public constant STRATEGY_MANAGER_ROLE = keccak256("STRATEGY_MANAGER_ROLE");

    /* ---------- state ----------*/
    IERC20 public usdc;                 // underlying asset (set in init, NOT immutable)
    IStrategy[] public strategies;      // active strategies list
    mapping(IStrategy => bool) public isStrategyActive;

    /* ---------- events ----------*/
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event StrategyAdded(IStrategy indexed strategy);
    event StrategyRemoved(IStrategy indexed strategy);
    event Invested(IStrategy indexed strategy, uint256 amount);
    event Divested(IStrategy indexed strategy, uint256 amount);
    event Harvested(IStrategy indexed strategy);

    /* ---------- errors ----------*/
    error StrategyAlreadyExists();
    error StrategyNotFound();
    error ZeroAmount();
    error InsufficientBalance();
    error ZeroAddress();


    //vault role + strategy manager role ()

    /* ---------- constructor ----------*/
    constructor() { _disableInitializers(); }

    function initialize(address _usdcAddress, address accessManager) external initializer {
         __AccessManaged_init(accessManager);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        usdc = IERC20(_usdcAddress);
    }

    /* ---------------------------------------------------------
     *  Funds Management
     * -------------------------------------------------------*/
    function deposit(uint256 amount) external restricted nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount, address to) external restricted nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 localBal = usdc.balanceOf(address(this));

        if (localBal < amount) {
            uint256 needed = amount - localBal;
            uint256 len = strategies.length;
            for (uint i = len; i > 0 && needed > 0; i--) {
                IStrategy strat = strategies[i-1];
                uint256 bal = strat.totalAssets();
                if (bal == 0) continue;
                uint256 toDivest = bal > needed ? needed : bal;
                uint256 got = strat.divest(toDivest);
                if (got == 0) continue;
                needed = got >= needed ? 0 : needed - got;
            }
        }

        uint256 finalBal = usdc.balanceOf(address(this));
        if (finalBal < amount) revert InsufficientBalance();
        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /* ---------------------------------------------------------
     *  Strategy Management
     * -------------------------------------------------------*/
    function addStrategy(IStrategy strategy) external restricted {
        if (strategy == IStrategy(address(0))) revert ZeroAddress();
        if (isStrategyActive[strategy]) revert StrategyAlreadyExists();
        isStrategyActive[strategy] = true;
        strategies.push(strategy);
        emit StrategyAdded(strategy);
    }

    function removeStrategy(IStrategy strategy) external restricted {
        if (!isStrategyActive[strategy]) revert StrategyNotFound();
        usdc.forceApprove(address(strategy), 0); // reset approval
        // remove from array (swap & pop)
        for (uint i = 0; i < strategies.length; i++) {
            if (strategies[i] == strategy) {
                strategies[i] = strategies[strategies.length-1];
                strategies.pop();
                break;
            }
        }
        isStrategyActive[strategy] = false;
        emit StrategyRemoved(strategy);
    }

    function invest(IStrategy strategy, uint256 amount) external restricted {
        if (!isStrategyActive[strategy]) revert StrategyNotFound();
        if (amount == 0) revert ZeroAmount();
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientBalance();

        usdc.safeIncreaseAllowance(address(strategy), amount);
        strategy.invest(amount);
        usdc.forceApprove(address(strategy), 0);
        emit Invested(strategy, amount);
    }

    function divest(IStrategy strategy, uint256 amount) external restricted {
        if (!isStrategyActive[strategy]) revert StrategyNotFound();
        strategy.divest(amount);
        emit Divested(strategy, amount);
    }

    function harvest(IStrategy strategy) external restricted{
        if (!isStrategyActive[strategy]) revert StrategyNotFound();
        strategy.harvest();
        emit Harvested(strategy);
    }

    /* ---------------------------------------------------------
     *  View helpers
     * -------------------------------------------------------*/
    function totalAssets() external view returns (uint256) {
        uint256 total = usdc.balanceOf(address(this));
        for (uint i = 0; i < strategies.length; i++) {
            total += strategies[i].totalAssets();
        }
        return total;
    }

    /* ---------- UUPS ----------*/
    function _authorizeUpgrade(address newImplementation) internal override restricted {}

    uint256[50] private __gap; // reserved for upgrades
}
