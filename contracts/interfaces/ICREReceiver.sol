// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title Chainlink CRE report receiver interface
/// @notice Mirrors Chainlink IReceiver using the repository's OpenZeppelin import path.
/// @dev Chainlink contracts 1.5.0 uses a versioned Foundry import in its IReceiver,
///      which this repository's Hardhat resolver cannot load directly.
interface ICREReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
