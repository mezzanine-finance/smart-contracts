import fs from "fs";
import path from "path";
import {expect} from "chai";

const TARGET_SOURCES: Record<string, string> = {
    MZUSD: "contracts/MZUSD.sol",
    PolJuniorTranche: "contracts/PolJuniorTranche.sol",
    ReservoirUSDC: "contracts/ReservoirUSDC.sol",
    Vault: "contracts/Vault.sol",
    Tranche: "contracts/Tranche.sol",
    LossManager: "contracts/LossManager.sol",
};

const RULE_FUNCTION_TARGETS: Record<string, string> = {
    rulesMZUSD: "MZUSD",
    rulesReservoir: "ReservoirUSDC",
    rulesVault: "Vault",
    rulesTranche: "Tranche",
    rulesLossManager: "LossManager",
    rulesPolJunior: "PolJuniorTranche",
};

function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function getRestrictedFunctionNames(source: string): Set<string> {
    const stripped = stripComments(source);
    const restricted = new Set<string>();
    const fnRegex = /function\s+([A-Za-z0-9_]+)\s*\(/g;
    let match;
    while ((match = fnRegex.exec(stripped)) !== null) {
        const name = match[1];
        const start = match.index;
        const brace = stripped.indexOf("{", start);
        const semi = stripped.indexOf(";", start);
        const endCandidates = [brace, semi].filter((value) => value !== -1);
        if (endCandidates.length === 0) continue;
        const end = Math.min(...endCandidates);
        const header = stripped.slice(start, end);
        if (!/\b(public|external)\b/.test(header)) continue;
        if (!/\brestricted\b/.test(header)) continue;
        restricted.add(name);
    }
    return restricted;
}

function extractFunctionBody(source: string, functionName: string): string {
    const start = source.indexOf(`function ${functionName}`);
    if (start === -1) {
        throw new Error(`Function ${functionName} not found in EmergencyPolicyV1.sol`);
    }
    const braceStart = source.indexOf("{", start);
    if (braceStart === -1) {
        throw new Error(`Function ${functionName} has no body start.`);
    }
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
        const char = source[i];
        if (char === "{") depth++;
        if (char === "}") depth--;
        if (depth === 0) {
            return source.slice(braceStart + 1, i);
        }
    }
    throw new Error(`Function ${functionName} body not closed.`);
}

function getPolicyFunctionNames(source: string): Record<string, Set<string>> {
    const policy: Record<string, Set<string>> = {};
    for (const target of Object.values(RULE_FUNCTION_TARGETS)) {
        policy[target] = new Set<string>();
    }

    for (const [ruleFn, target] of Object.entries(RULE_FUNCTION_TARGETS)) {
        const body = extractFunctionBody(source, ruleFn);
        const ruleRegex = /RuleDef\(([^,]+),/g;
        let match;
        while ((match = ruleRegex.exec(body)) !== null) {
            const firstArg = match[1].replace(/\s+/g, "");
            const withoutSelector = firstArg.replace(/\.selector$/, "");
            const parts = withoutSelector.split(".");
            const functionName = parts[parts.length - 1];
            policy[target].add(functionName);
        }
    }

    return policy;
}

describe("EmergencyPolicyV1 coverage", () => {
    it("covers all restricted entrypoints for configured targets", () => {
        const policySource = fs.readFileSync(
            path.join(__dirname, "..", "contracts", "access", "EmergencyPolicyV1.sol"),
            "utf8"
        );
        const policyFunctions = getPolicyFunctionNames(policySource);

        for (const [contractName, sourcePath] of Object.entries(TARGET_SOURCES)) {
            const contractSource = fs.readFileSync(path.join(__dirname, "..", sourcePath), "utf8");
            const restricted = getRestrictedFunctionNames(contractSource);
            const policy = policyFunctions[contractName] ?? new Set<string>();

            const missing = [...restricted].filter((name) => !policy.has(name)).sort();
            expect(missing, `${contractName} missing in EmergencyPolicyV1: ${missing.join(", ")}`)
                .to.be.empty;
        }
    });
});
