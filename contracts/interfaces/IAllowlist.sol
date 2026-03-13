// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IAllowlist {
    function verifyAccount(address account) external view returns (bool);
}
