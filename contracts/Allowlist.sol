// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/external/ISanctionsList.sol";

/// @title Allowlist
/// @notice A smart contract which stores allowlist for the protocol.
/// @notice Allowlisters are able to add/remove accounts from the allowlist.
/// @notice Account verification checks that account is in allowlist and is not sanctioned by Chainanalysis.
contract Allowlist is AccessManagedUpgradeable, UUPSUpgradeable {
    /// @notice Address of Sanctions List by Chainanalysis.
    ISanctionsList sanctionsList;
    /// @notice Validates if account is allowed.
    mapping(address => bool) public isAllowlisted;

    event AddedToAllowlist(address indexed account);
    event RemovedFromAllowlist(address indexed account);

    error AlreadyAllowlisted(address account);
    error NotAllowlisted(address account);
    error ZeroAddress();

    constructor() {
        _disableInitializers();
    }

    /// @param _accessManager AccessManager address.
    /// @param _sanctionsList Sanctions list address.
    function initialize(
        address _accessManager,
        ISanctionsList _sanctionsList
    ) external initializer {
        require(address(_sanctionsList) != address(0), ZeroAddress());
        sanctionsList = _sanctionsList;
        __AccessManaged_init(_accessManager);
    }

    // ALLOWLIST FUNCTIONS

    /// @notice Adds account to the allowlist.
    /// @dev Account shouldn't already be in the allowlist.
    function add(address account) external restricted {
        _add(account);
    }

    /// @notice Removes the account from the allowlist.
    /// @dev Account should already be in the allowlist.
    function remove(address account) external restricted {
        _remove(account);
    }

    /// @notice Same as `add` function, but for a batch of accounts.
    function addBatch(address[] calldata accounts) external restricted {
        uint256 length = accounts.length;
        for (uint256 i; i < length; ++i) {
            _add(accounts[i]);
        }
    }

    /// @notice Same as `remove` function, but for a batch of accounts.
    function removeBatch(address[] calldata accounts) external restricted {
        uint256 length = accounts.length;
        for (uint256 i; i < length; ++i) {
            _remove(accounts[i]);
        }
    }

    // GETTERS

    /// @notice Verifies if the account is in the allowlist and is not sanctioned by the Chainanalysis.
    /// @param account Address of verify.
    /// @return status True if account is in allow list and is not sanctioned, false otherwise.
    function verifyAccount(address account) external view returns (bool) {
        return isAllowlisted[account] && !sanctionsList.isSanctioned(account);
    }

    // INTERNAL FUNCTIONS

    function _add(address account) private {
        require(account != address(0), ZeroAddress());
        require(!isAllowlisted[account], AlreadyAllowlisted(account));
        isAllowlisted[account] = true;
        emit AddedToAllowlist(account);
    }

    function _remove(address account) private {
        require(isAllowlisted[account], NotAllowlisted(account));
        delete isAllowlisted[account];
        emit RemovedFromAllowlist(account);
    }

    /// @notice While restricted is applied to the internal _authorizeUpgrade function, AccessManager should be configured to restrict call to upgradeToAndCall function, as it's the public entry point.
    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address newImplementation) internal override restricted {}
}
