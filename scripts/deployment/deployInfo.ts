export interface DeployInfo {
    // address of real (or mock) USDC for this network
    usdc: string;

    // who will be the admin of AccessManager
    accessManagerAdmin: string;

    // global redemption cap for MZUSD in USDC (without 6 decimals)
    // for example 1_000_000 = 1_000_000 USDC, 0 = cap disabled
    mzusdRedemptionCap: string;

    // emergency level roles (optional, defaults to accessManagerAdmin)
    emergencyEscalate?: string;
    emergencyRelax?: string;

    // emergency delays in seconds (optional, defaults to 48h for relax/upgrade/admin)
    relaxDelaySeconds?: number;
    upgradeDelaySeconds?: number;
    adminDelaySeconds?: number;

    tranche?: {
        id: number;
        unstakeDelayEpochs: number;
        name: string;
        symbol: string;
        weightBps: number;
        enabled: boolean;
        polJuniorMode: boolean;
        polPayout: string;
    };
}

export const DEPLOY_INFO: Record<string, DeployInfo> = {
    mainnet: {
        usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC mainnet
        accessManagerAdmin: "0xYourAdminAddressHere",
        mzusdRedemptionCap: "1000000", // 1m USDC per window
        tranche: {
            id: 1,
            unstakeDelayEpochs: 0,
            name: "Senior Tranche",
            symbol: "sMZUSD",
            weightBps: 10_000,
            enabled: true,
            polJuniorMode: false,
            polPayout: "0x0000000000000000000000000000000000000000",
        },
    },

    // example for testnet
    sepolia: {
        usdc: "0xYourMockOrUSDCOnSepolia",
        accessManagerAdmin: "0xYourSepoliaAdmin",
        mzusdRedemptionCap: "0",
        tranche: {
            id: 1,
            unstakeDelayEpochs: 0,
            name: "Senior Tranche",
            symbol: "sMZUSD",
            weightBps: 10_000,
            enabled: true,
            polJuniorMode: false,
            polPayout: "0x0000000000000000000000000000000000000000",
        },
    },

    buildbear: {
        usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        accessManagerAdmin: "0x92405f3a35f19c8ab4c7892da0250a4ded886e8b",
        mzusdRedemptionCap: "1000000",
        emergencyEscalate: "0x92405f3a35f19c8ab4c7892da0250a4ded886e8b",
        emergencyRelax: "0x92405f3a35f19c8ab4c7892da0250a4ded886e8b",
        relaxDelaySeconds: 2 * 24 * 60 * 60,
        upgradeDelaySeconds: 2 * 24 * 60 * 60,
        adminDelaySeconds: 2 * 24 * 60 * 60,
        tranche: {
            id: 1,
            unstakeDelayEpochs: 0,
            name: "Senior Tranche",
            symbol: "sMZUSD",
            weightBps: 10_000,
            enabled: true,
            polJuniorMode: false,
            polPayout: "0x0000000000000000000000000000000000000000",
        },
    },
};
