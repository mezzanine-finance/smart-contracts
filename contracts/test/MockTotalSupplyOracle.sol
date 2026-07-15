// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockTotalSupplyOracle is AggregatorV3Interface {
    uint256 public constant SCALE = 1e10; // MZUSD 18d -> 8d oracle answer
    address public mzUSD;

    constructor(address _mzUSD) {
        mzUSD = _mzUSD;
    }

    function decimals() external view returns (uint8) {
        return 8; // oracle answers reported with 8 decimals
    }

    function description() external view returns (string memory) {
        return "mzUSD Total Supply";
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
        answer = int256(IERC20(mzUSD).totalSupply() / SCALE);
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
        answer = int256(IERC20(mzUSD).totalSupply() / SCALE);
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
        answeredInRound = 1;
    }
}
