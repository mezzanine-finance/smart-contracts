module.exports = {
    skipFiles: ["interfaces/", "phase2/", "test/"],
    mocha: {
        fgrep: "[skip-on-coverage]", // Find everything with this tag.
        invert: true, // Run the grep's inverse set.
        enableTimeouts: false,
        parallel: false,
    },
    // measureStatementCoverage: false,
    // measureFunctionCoverage: false,
    // irMinimum causes a Yul stack-too-deep error in IssuanceVault after instrumentation.
    irMinimum: false,
    // Work around "stack too deep".
    configureYulOptimizer: true,
    solcOptimizerDetails: {
        peephole: false,
        inliner: false,
        jumpdestRemover: false,
        orderLiterals: true,
        deduplicate: false,
        cse: false,
        constantOptimizer: false,
        yul: false,
    },
};
