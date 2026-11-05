// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {PauseManager} from "../pause/PauseManager.sol";

contract PauseManagerV2 is PauseManager {
    function version() external pure returns (uint256) {
        return 2;
    }
}
