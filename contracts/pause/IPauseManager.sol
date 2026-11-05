// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {PauseCategory} from "./PauseCategory.sol";

interface IPauseManager {
    function isPaused(address target, PauseCategory category) external view returns (bool);

    function globalPaused(PauseCategory category) external view returns (bool);

    function contractPaused(address target, PauseCategory category) external view returns (bool);
}
