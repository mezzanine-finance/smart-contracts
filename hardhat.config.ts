/* eslint @typescript-eslint/no-non-null-assertion: ["off"] */

import dotenv from "dotenv";
dotenv.config();

import {HardhatUserConfig} from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomiclabs/hardhat-solhint";
import "solidity-coverage";
import "solidity-docgen";
import "hardhat-contract-sizer";
import "hardhat-abi-exporter";
import "hardhat-gas-reporter";
import "hardhat-tracer";
import "@openzeppelin/hardhat-upgrades";

const isOptionTrue = (option: string | undefined) => ["true", "1"].includes(option ?? "");
const envs = process.env;

//The solc compiler optimizer is disabled by default to keep the Hardhat stack traces' line numbers the same.
//To enable, set `RUN_OPTIMIZER` to `true` in the `.env` file.
// const optimizerRuns = isOptionTrue(envs.RUN_OPTIMIZER) || isOptionTrue(envs.REPORT_GAS);
const optimizerRuns = true;
const optimizerRunNum = envs.OPTIMIZER_RUN_NUM ? +envs.OPTIMIZER_RUN_NUM : 200;
const enableForking = isOptionTrue(envs.FORKING);

const config: HardhatUserConfig = {
    solidity: {
        compilers: [
            {
                version: "0.8.30",
                settings: {
                    viaIR: true,
                    optimizer: {
                        enabled: optimizerRuns,
                        runs: optimizerRunNum,
                        details: {
                            yulDetails: {
                                optimizerSteps: optimizerRuns ? "u" : undefined,
                            },
                        },
                    },
                    evmVersion: "cancun",
                },
            },
            // { version: "0.7.6" }
        ],
        // overrides: { "contracts/Deployed.sol": { version: "0.8.21" } }
    },
    networks: {
        hardhat: {
            accounts: {
                accountsBalance: envs.ACCOUNT_BALANCE ?? "10000000000000000000000", // 10000 ETH.
                count: envs.NUMBER_OF_ACCOUNTS ? +envs.NUMBER_OF_ACCOUNTS : 20,
            },
            forking: {
                url: envs.FORKING_URL ?? "",
                enabled: enableForking,
            },
        },
        mainnet: {
            url: envs.MAINNET_RPC ?? envs.FORKING_URL ?? "",
            chainId: 1,
            accounts: envs.DEPLOYER_PK
                ? [envs.DEPLOYER_PK]
                : envs.DEV_ACCOUNT
                  ? [envs.DEV_ACCOUNT]
                  : [],
        },
        buildbear: {
            url: "https://rpc.buildbear.io/mezzanine-dev",
            chainId: 1,
            accounts: envs.DEV_ACCOUNT ? [envs.DEV_ACCOUNT] : [],
        },
        sepolia: {
            url: envs.SEPOLIA_RPC ?? "",
            chainId: 11155111,
            accounts: envs.DEPLOYER_PK
                ? [envs.DEPLOYER_PK]
                : envs.DEV_ACCOUNT
                  ? [envs.DEV_ACCOUNT]
                  : [],
        },
    },
    etherscan: {
        apiKey: envs.ETHERSCAN_API_KEY ?? "",
        customChains: [
            {
                network: "buildbear",
                chainId: 1,
                urls: {
                    apiURL: "https://rpc.buildbear.io/verify/etherscan/mezzanine-dev",
                    browserURL: "https://explorer.buildbear.io/mezzanine-dev",
                },
            },
        ],
    },
    // sourcify: {
    //     enabled: true,
    //     apiUrl: "https://rpc.buildbear.io/verify/sourcify/server/male-shatterstar-286313ca",
    // },
    docgen: {
        pages: "files",
        exclude: ["deprecated/"],
    },
    contractSizer: {
        except: ["mocks/", "deprecated/"],
    },
    abiExporter: {
        except: ["interfaces/", "mocks/", "deprecated/", "test/", "@openzeppelin/"],
        spacing: 4,
    },
    gasReporter: {
        enabled: isOptionTrue(envs.REPORT_GAS) || envs.REPORT_GAS_TO_FILE !== undefined,
    },
    mocha: {
        timeout: 400000,
        parallel: false,
    },
};

// By default fork from the latest block.
if (envs.FORKING_BLOCK_NUMBER)
    config.networks!.hardhat!.forking!.blockNumber = +envs.FORKING_BLOCK_NUMBER;

// Extra settings for `hardhat-gas-reporter`.
if (envs.COINMARKETCAP_API_KEY) config.gasReporter!.coinmarketcap = envs.COINMARKETCAP_API_KEY;
if (envs.REPORT_GAS_TO_FILE === "md") {
    config.gasReporter!.outputFile = "reports/gas-report.md";
    config.gasReporter!.reportFormat = "markdown";
    config.gasReporter!.forceTerminalOutput = true;
    config.gasReporter!.forceTerminalOutputFormat = "terminal";
}
if (envs.REPORT_GAS_TO_FILE === "json") {
    config.gasReporter!.outputJSON = true;
    config.gasReporter!.outputJSONFile = "reports/gas-report.json";
    config.gasReporter!.includeBytecodeInJSON = true;
}

export default config;
