// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IAllowlist} from "./interfaces/IAllowlist.sol";

/// @title AllowlistStub
/// @notice Permissive allowlist implementation that accepts every account.
/// @dev Intended for production as well as test deployments that explicitly allow unrestricted
///      participation. Performs no allowlist or sanctions checks, including for the zero address.
contract AllowlistStub is IAllowlist {
    /// @inheritdoc IAllowlist
    function verifyAccount(address account) external pure returns (bool) {
        account;
        return true;
    }
}
