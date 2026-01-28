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

    // fee receivers for Vault (must be non-zero and distinct)
    performanceFeeReceiver: string;
    protocolFeeReceiver: string;
    performanceFeeBps: number;
    protocolFeeBps: number;

    tranche?: {
        id: number;
        unstakeDelayEpochs: number;
        name: string;
        symbol: string;
        weight: number;
        enabled: boolean;
        polJuniorMode: boolean;
        polPayout: string;
        directWithdrawalMode: boolean;
    };
}

export const DEPLOY_INFO: Record<string, DeployInfo> = {
    mainnet: {
        usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC mainnet
        accessManagerAdmin: "0xYourAdminAddressHere",
        mzusdRedemptionCap: "1000000", // 1m USDC per window
        performanceFeeReceiver: "0xYourPerformanceFeeReceiver",
        protocolFeeReceiver: "0xYourProtocolFeeReceiver",
        performanceFeeBps: 0,
        protocolFeeBps: 0,
        tranche: {
            id: 1,
            unstakeDelayEpochs: 0,
            name: "Senior Tranche",
            symbol: "sMZUSD",
            weight: 10_000,
            enabled: true,
            polJuniorMode: false,
            polPayout: "0x0000000000000000000000000000000000000000",
            directWithdrawalMode: false,
        },
    },

    // example for testnet
    sepolia: {
        usdc: "0x8721514c2d975e6e4366813AF44628E1B5FC06Cb",
        accessManagerAdmin: "0x585B227672f6991D10cfe746c49147205b8a5ABc",
        mzusdRedemptionCap: "1000000",
        performanceFeeReceiver: "0x585B227672f6991D10cfe746c49147205b8a5ABc",
        protocolFeeReceiver: "0x585B227672f6991D10cfe746c49147205b8a5ABc",
        performanceFeeBps: 0,
        protocolFeeBps: 0,
        tranche: {
            id: 1,
            unstakeDelayEpochs: 0,
            name: "Senior Tranche",
            symbol: "sMZUSD",
            weight: 10_000,
            enabled: true,
            polJuniorMode: false,
            polPayout: "0x0000000000000000000000000000000000000000",
            directWithdrawalMode: true,
        },
    },

    buildbear: {
        usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        accessManagerAdmin: "0x92405f3a35f19c8ab4c7892da0250a4ded886e8b",
        mzusdRedemptionCap: "1000000",
        performanceFeeReceiver: "0x92405f3a35f19c8ab4c7892da0250a4ded886e8b",
        protocolFeeReceiver: "0x1111111111111111111111111111111111111111",
        performanceFeeBps: 0,
        protocolFeeBps: 0,
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
            weight: 10_000,
            enabled: true,
            polJuniorMode: false,
            polPayout: "0x0000000000000000000000000000000000000000",
            directWithdrawalMode: true,
        },
    },
};
