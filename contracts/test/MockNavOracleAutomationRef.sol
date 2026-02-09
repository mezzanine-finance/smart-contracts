// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract MockNavOracleAutomationRef {
    address public immutable vault;
    address public immutable lossManager;
    address public immutable mzusd;

    constructor(address vault_, address lossManager_, address mzusd_) {
        vault = vault_;
        lossManager = lossManager_;
        mzusd = mzusd_;
    }
}
