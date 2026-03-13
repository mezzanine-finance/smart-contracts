// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import "../interfaces/external/ISanctionsList.sol";

contract MockSanctionsList is ISanctionsList {
    mapping(address => bool) public sanctionedAddresses;

    function add(address addr) external {
        sanctionedAddresses[addr] = true;
    }

    function remove(address addr) external {
        delete sanctionedAddresses[addr];
    }

    function isSanctioned(address addr) external view returns (bool) {
        return sanctionedAddresses[addr] == true;
    }
}
