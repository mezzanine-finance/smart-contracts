// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface ITranche {
    function totalAssets() external view returns (uint256 assets);
    function notifyYield(uint256 amount) external;
    function burnMZUSD(uint256 amount) external;
    function vault() external view returns (address vaultAddress);
    function pauseManager() external view returns (address pauseManagerAddress);
    function umbrellaSharesByEpoch(uint256) external view returns (uint256 shares);
    function finalizedEpochs(
        uint256
    ) external view returns (uint256 totalShares, uint256 totalAssets, uint256 finalizationPrice);
    function finalizeEpoch(uint256) external;
}
