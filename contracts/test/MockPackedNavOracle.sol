// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @notice Test-only AggregatorV3 oracle with externally settable latest round data.
contract MockPackedNavOracle is AggregatorV3Interface {
    uint8 private immutable _feedDecimals;
    uint256 private immutable _feedVersion;
    string private _feedDescription;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _answeredInRound;

    error InvalidTimestamp();

    constructor(uint8 decimals_, string memory description_) {
        _feedDecimals = decimals_;
        _feedDescription = description_;
        _feedVersion = 1;
    }

    function decimals() external view override returns (uint8) {
        return _feedDecimals;
    }

    function description() external view override returns (string memory) {
        return _feedDescription;
    }

    function version() external view override returns (uint256) {
        return _feedVersion;
    }

    function getRoundData(
        uint80 requestedRoundId
    ) external view override returns (uint80, int256, uint256, uint256, uint80) {
        if (requestedRoundId != _roundId || _roundId == 0) revert("No data present");
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        if (_roundId == 0) revert("No data present");
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }

    function setLatestRoundData(int256 answer_, uint256 updatedAt_) external {
        if (updatedAt_ == 0) revert InvalidTimestamp();
        _roundId += 1;
        _answer = answer_;
        _startedAt = updatedAt_;
        _updatedAt = updatedAt_;
        _answeredInRound = _roundId;
    }
}
