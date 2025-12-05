export interface DeployInfo {
    // address of real (or mock) USDC for this network
    usdc: string;

    // who will be the admin of AccessManager
    accessManagerAdmin: string;

    // global hourly cap for MZUSD in USDC (without 6 decimals)
    // for example 1_000_000 = 1_000_000 USDC, 0 = cap disabled
    mzusdHourlyCap: string;
}

export const DEPLOY_INFO: Record<string, DeployInfo> = {
    mainnet: {
        usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC mainnet
        accessManagerAdmin: "0xYourAdminAddressHere",
        mzusdHourlyCap: "1000000", // 1m USDC per hour
    },

    // example for testnet
    sepolia: {
        usdc: "0xYourMockOrUSDCOnSepolia",
        accessManagerAdmin: "0xYourSepoliaAdmin",
        mzusdHourlyCap: "0",
    },

    buildbear: {
        usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        accessManagerAdmin: "0x92405f3a35f19c8ab4c7892da0250a4ded886e8b",
        mzusdHourlyCap: "1000000",
    }
};
