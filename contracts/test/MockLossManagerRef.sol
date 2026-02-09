// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

contract MockLossManagerRef {
    address public immutable vault;
    address public immutable mzusd;

    constructor(address vault_, address mzusd_) {
        vault = vault_;
        mzusd = mzusd_;
    }
}
