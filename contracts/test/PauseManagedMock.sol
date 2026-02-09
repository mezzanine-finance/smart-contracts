// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {PauseCategory} from "../pause/PauseCategory.sol";
import {PauseManagedUpgradeable} from "../pause/PauseManagedUpgradeable.sol";

contract PauseManagedMock is PauseManagedUpgradeable, UUPSUpgradeable {
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public transfers;
    uint256 public adminOps;
    uint256 public protocolOps;

    function initialize(address pauseManager_) external initializer {
        __PauseManaged_init(pauseManager_);
    }

    function deposit() external whenNotPaused(PauseCategory.DEPOSITS) {
        deposits += 1;
    }

    function withdraw() external whenNotPaused(PauseCategory.WITHDRAWALS) {
        withdrawals += 1;
    }

    function transferAction() external whenNotPaused(PauseCategory.TRANSFERS) {
        transfers += 1;
    }

    function adminAction() external whenNotPaused(PauseCategory.ADMIN) {
        adminOps += 1;
    }

    function protocolAction() external whenNotPaused(PauseCategory.PROTOCOL) {
        protocolOps += 1;
    }

    function forcePauseManagerInit(address pauseManager_) external {
        __PauseManaged_init(pauseManager_);
    }

    // aderyn-fp-next-line(empty-block)
    function _authorizeUpgrade(address) internal override {}
}
