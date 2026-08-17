// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IAllowlist} from "./interfaces/IAllowlist.sol";

/// @title AllowlistStub
/// @notice Permissive allowlist implementation that accepts every account.
contract AllowlistStub is IAllowlist {
    /// @inheritdoc IAllowlist
    function verifyAccount(address account) external pure returns (bool) {
        account;
        return true;
    }
}
