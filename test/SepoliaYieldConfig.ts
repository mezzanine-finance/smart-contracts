import {expect} from "chai";
import {ethers} from "hardhat";
import {loadConfig} from "../scripts/deployment/lib/config";

const SECONDS_PER_YEAR = 31_536_000;
const BPS = 10_000;

describe("Sepolia test vault yield configuration", () => {
    for (const vaultId of ["vault-1", "vault-2"]) {
        it(`${vaultId} seeds all MZUSD into tranches and projects 10-20% APY`, async () => {
            const config = loadConfig(
                "sepolia",
                `scripts/deployment/config/sepolia-${vaultId}.json`
            );
            const mockNavOracleFactory = await ethers.getContractFactory("MockNavOracle");
            const mockMzusd = await ethers.deployContract("MockUSDC");
            const mockNavOracle = await mockNavOracleFactory.deploy(await mockMzusd.getAddress());
            const mockSubmitter = await ethers.deployContract("MockNavSubmitterAutomation", [
                await mockMzusd.getAddress(),
            ]);

            expect(await mockNavOracle.PREMIUM_BPS()).to.equal(2n);
            expect(await mockSubmitter.PREMIUM_BPS()).to.equal(await mockNavOracle.PREMIUM_BPS());
            expect(await mockSubmitter.BPS()).to.equal(await mockNavOracle.BPS());

            const issuedMzusd = Number(config.seed?.mzusdDepositUSDC ?? 0);
            const deadShares = new Map(
                (config.seed?.deadShares ?? []).map((seed) => [seed.key, Number(seed.amountMZUSD)])
            );
            const deposits = new Map(
                (config.seed?.trancheDeposits ?? []).map((seed) => [
                    seed.key,
                    Number(seed.amountMZUSD),
                ])
            );
            const trancheTvls = config.tranches.map(
                (tranche) => (deadShares.get(tranche.key) ?? 0) + (deposits.get(tranche.key) ?? 0)
            );
            const totalTrancheTvl = trancheTvls.reduce((sum, tvl) => sum + tvl, 0);

            expect(totalTrancheTvl).to.equal(issuedMzusd);

            const epochDuration = config.vault.epochDurationSec ?? 0;
            const periodsPerYear = SECONDS_PER_YEAR / epochDuration;
            const premiumRate =
                Number(await mockNavOracle.PREMIUM_BPS()) / Number(await mockNavOracle.BPS());
            const feeRate = (config.vault.performanceFeeBps + config.vault.protocolFeeBps) / BPS;
            const allocatableYield = issuedMzusd * premiumRate * (1 - feeRate);
            const totalRiskPremiumBps = config.tranches.reduce(
                (sum, tranche) => sum + tranche.riskPremiumBps,
                0
            );
            const baseRewardRate = (BPS - totalRiskPremiumBps) / BPS;

            for (const [index, tranche] of config.tranches.entries()) {
                const trancheTvl = trancheTvls[index];
                const baseShare =
                    allocatableYield * baseRewardRate * (trancheTvl / totalTrancheTvl);
                const riskPremiumShare = allocatableYield * (tranche.riskPremiumBps / BPS);
                const epochRate = (baseShare + riskPremiumShare) / trancheTvl;
                const apr = epochRate * periodsPerYear;
                const apy = (1 + epochRate) ** periodsPerYear - 1;

                expect(apy, `${vaultId} ${tranche.key} APY`).to.be.gte(0.1).and.lte(0.2);
                expect(apr, `${vaultId} ${tranche.key} APR`).to.be.gte(0.1).and.lte(0.2);

                const tvlLimitBps = tranche.depositLimits?.tvlBps;
                if (tranche.depositLimits?.enabled && tvlLimitBps !== undefined) {
                    expect(trancheTvl).to.be.lte((issuedMzusd * tvlLimitBps) / BPS);
                }
            }
        });
    }
});
