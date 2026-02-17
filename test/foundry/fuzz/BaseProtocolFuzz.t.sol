// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {PauseManager} from "contracts/pause/PauseManager.sol";
import {ReservoirUSDC} from "contracts/ReservoirUSDC.sol";
import {MZUSD} from "contracts/MZUSD.sol";
import {IssuanceVault} from "contracts/IssuanceVault.sol";
import {MockUSDC} from "contracts/test/MockUSDC.sol";

abstract contract BaseProtocolFuzzTest is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SCALE = 1e12;
    uint64 internal constant RESERVOIR_WITHDRAW_ROLE = 42;

    AccessManager internal accessManager;
    PauseManager internal pauseManager;
    MockUSDC internal usdc;
    ReservoirUSDC internal reservoir;
    MZUSD internal mzusd;
    IssuanceVault internal vault;

    function setUp() public virtual {
        usdc = new MockUSDC();
        accessManager = new AccessManager(address(this));

        PauseManager pauseImpl = new PauseManager();
        pauseManager = PauseManager(
            _deployProxy(
                address(pauseImpl),
                abi.encodeCall(PauseManager.initialize, (address(accessManager)))
            )
        );

        ReservoirUSDC reservoirImpl = new ReservoirUSDC(address(usdc));
        reservoir = ReservoirUSDC(
            _deployProxy(
                address(reservoirImpl),
                abi.encodeCall(
                    ReservoirUSDC.initialize,
                    (address(accessManager), address(pauseManager))
                )
            )
        );

        MZUSD mzusdImpl = new MZUSD(address(usdc));
        mzusd = MZUSD(
            _deployProxy(
                address(mzusdImpl),
                abi.encodeCall(
                    MZUSD.initialize,
                    (address(accessManager), address(pauseManager), type(uint128).max)
                )
            )
        );

        IssuanceVault vaultImpl = new IssuanceVault(address(mzusd), address(reservoir));
        vault = IssuanceVault(
            _deployProxy(
                address(vaultImpl),
                abi.encodeCall(IssuanceVault.initialize, (0, address(this), 0, address(this)))
            )
        );

        uint64 adminRole = accessManager.ADMIN_ROLE();

        bytes4[] memory mzusdSelectors = new bytes4[](1);
        mzusdSelectors[0] = MZUSD.setVault.selector;
        accessManager.setTargetFunctionRole(address(mzusd), mzusdSelectors, adminRole);

        bytes4[] memory reservoirSetSelectors = new bytes4[](1);
        reservoirSetSelectors[0] = ReservoirUSDC.setVault.selector;
        accessManager.setTargetFunctionRole(address(reservoir), reservoirSetSelectors, adminRole);

        bytes4[] memory reservoirWithdrawSelectors = new bytes4[](1);
        reservoirWithdrawSelectors[0] = ReservoirUSDC.withdraw.selector;
        accessManager.setTargetFunctionRole(
            address(reservoir),
            reservoirWithdrawSelectors,
            RESERVOIR_WITHDRAW_ROLE
        );
        accessManager.grantRole(RESERVOIR_WITHDRAW_ROLE, address(vault), 0);

        mzusd.setVault(address(vault));
        reservoir.setVault(address(vault));
    }

    function _deployProxy(
        address implementation,
        bytes memory initData
    ) internal returns (address) {
        return address(new ERC1967Proxy(implementation, initData));
    }
}
