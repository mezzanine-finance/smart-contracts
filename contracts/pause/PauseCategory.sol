// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Shared pause categories used across the protocol.
enum PauseCategory {
    DEPOSITS,
    WITHDRAWALS,
    TRANSFERS,
    ADMIN,
    PROTOCOL
}
