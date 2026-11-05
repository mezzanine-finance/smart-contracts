// Minimal ABIs for reading readiness and encoding approved upkeep calls.
// Maintained manually, not generated: update both workflows' contracts.ts files
// if the Solidity upkeep function inputs or outputs change.
export const CHECK_UPKEEP_ABI = [
    {
        type: "function",
        name: "checkUpkeep",
        stateMutability: "view",
        inputs: [{name: "checkData", type: "bytes"}],
        outputs: [
            {name: "upkeepNeeded", type: "bool"},
            {name: "performData", type: "bytes"},
        ],
    },
] as const;

export const PERFORM_UPKEEP_ABI = [
    {
        type: "function",
        name: "performUpkeep",
        stateMutability: "nonpayable",
        inputs: [{name: "performData", type: "bytes"}],
        outputs: [],
    },
] as const;
