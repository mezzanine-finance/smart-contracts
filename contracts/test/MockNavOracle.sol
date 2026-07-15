// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockNavOracle is AggregatorV3Interface {
    uint256 public constant SCALE = 1e10; // MZUSD 18d -> 8d oracle answer
    // 0.001% precision to allow much smaller per-epoch growth in short test epochs.
    uint256 public constant BPS = 100_000;
    uint256 public constant PREMIUM_BPS = 3; // +0.003% per submission
    uint256 public constant MIN_NAV_DELTA_USDC = 100; // 8d floor (= 1 USDC 6d unit)

    address public mzUSD;

    constructor(address _mzUSD) {
        mzUSD = _mzUSD;
    }

    function decimals() external view returns (uint8) {
        return 8; // oracle answers reported with 8 decimals
    }

    function description() external view returns (string memory) {
        return "mzUSD NAV";
    }

    function version() external view returns (uint256) {
        return 1;
    }

    function getRoundData(
        uint80 _roundId
    )
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        roundId = _roundId;
        answer = int256(_calculateCurrentNav());
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
        answeredInRound = 1;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        roundId = 1;
        answer = int256(_calculateCurrentNav());
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
        answeredInRound = 1;
    }

    function _calculateCurrentNav() internal view returns (uint256) {
        uint256 totalSupply8 = IERC20(mzUSD).totalSupply() / SCALE;
        if (totalSupply8 == 0) {
            return 0;
        }

        uint256 premiumDelta = (totalSupply8 * PREMIUM_BPS + (BPS - 1)) / BPS;
        uint256 delta = premiumDelta >= MIN_NAV_DELTA_USDC ? premiumDelta : MIN_NAV_DELTA_USDC;
        return totalSupply8 + delta;
    }
}
