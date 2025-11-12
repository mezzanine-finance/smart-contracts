// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IVault {
    function currentEpochId() external view returns (uint256);
}

// @title FeeEscrow
// @notice Holds mzUSD fees minted by the Vault and releases them only after the target epoch is reached in the Vault.
contract FeeEscrow is
    Initializable,
    AccessManagedUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    IERC20 public mzusd;
    IVault public vault;

    struct LockInfo {
        uint256 amount;
        uint256 unlockEpoch;
    }

    mapping(address => LockInfo) public locks;

    event Locked(address indexed beneficiary, uint256 amount, uint256 unlockEpoch);
    event Claimed(address indexed beneficiary, uint256 amount);

    error ZeroAddress();
    error NothingToClaim();
    error StillLocked();

    constructor() {
        _disableInitializers();
    }

    // @param accessManager Access manager for restricted funcs (Vault will be allowed to lock)
    // @param _mzusd mzUSD token address
    // @param _vault Vault that exposes currentEpochId()
    function initialize(
        address accessManager,
        address _mzusd,
        address _vault
    ) external initializer {
        if (accessManager == address(0) || _mzusd == address(0) || _vault == address(0)) revert ZeroAddress();

        __AccessManaged_init(accessManager);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        mzusd = IERC20(_mzusd);
        vault = IVault(_vault);
    }

    // @notice Called by Vault to lock newly minted fees for beneficiary until a specific epoch
    // @dev Vault must mint mzUSD to this escrow before calling this
    function lock(address beneficiary, uint256 amount, uint256 unlockEpoch)
        external
        restricted
    {
        LockInfo storage info = locks[beneficiary];
        info.amount += amount;
        if (unlockEpoch > info.unlockEpoch) {
            info.unlockEpoch = unlockEpoch;
        }
        emit Locked(beneficiary, amount, unlockEpoch);
    }

    // @notice Beneficiary claims once Vault reached the unlock epoch
    function claim(address to) external nonReentrant whenNotPaused {
        if (to == address(0)) revert ZeroAddress();

        LockInfo storage info = locks[_msgSender()];
        if (info.amount == 0) revert NothingToClaim();

        uint256 currentEpoch = vault.currentEpochId();
        if (currentEpoch < info.unlockEpoch) revert StillLocked();

        uint256 amount = info.amount;
        info.amount = 0;

        mzusd.safeTransfer(to, amount);
        emit Claimed(_msgSender(), amount);
    }

    function pause() external restricted {
        _pause();
    }

    function unpause() external restricted {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override restricted {}
}