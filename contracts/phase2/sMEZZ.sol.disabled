// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title sMEZZ — governance/receipt token (immutable, votes-enabled, AccessManager-managed)
/// @notice Mint/Burn are restricted via AccessManager (see `restricted` modifier).
contract sMEZZ is ERC20, ERC20Permit, ERC20Votes, AccessManaged {
    /// @param _authority AccessManager address controlling who can call mint/burn.
    constructor(address _authority)
        ERC20("Staked MEZZ", "sMEZZ")
        ERC20Permit("Staked MEZZ")
        AccessManaged(_authority)
    {}

    /// @notice Mint sMEZZ to `to`. Restricted by AccessManager.
    function mint(address to, uint256 amount) external restricted {
        _mint(to, amount);
    }

    /// @notice Burn `amount` from `from`. Restricted by AccessManager (bind this selector to a role).
    function burn(address from, uint256 amount) external restricted {
        _burn(from, amount);
    }

    /// @dev In OZ v5, `_update` is the single hook to combine ERC20 and Votes logic.
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    /// @dev Required because both ERC20Permit and ERC20Votes/Nonces define `nonces`.
    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}