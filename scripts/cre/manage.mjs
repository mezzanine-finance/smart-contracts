import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const creRoot = path.join(repositoryRoot, "cre");
const network = process.argv[3] ?? "sepolia";
const action = process.argv[2];

if (network !== "sepolia") {
    throw new Error(`Unsupported CRE environment: ${network}`);
}

const configPath = path.join(
    repositoryRoot,
    "scripts/deployment/config/cre-automation.sepolia.json"
);
const deploymentConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
const bunDirectory = path.join(os.homedir(), ".bun/bin");
const commandEnvironment = {
    ...process.env,
    PATH: fs.existsSync(bunDirectory)
        ? `${bunDirectory}${path.delimiter}${process.env.PATH ?? ""}`
        : process.env.PATH,
};

function resolveCreCommand() {
    const candidates = [process.env.CRE_CLI, "cre", path.join(os.homedir(), ".cre/bin/cre")].filter(
        Boolean
    );
    for (const candidate of candidates) {
        const result = spawnSync(candidate, ["version"], {
            env: commandEnvironment,
            stdio: "ignore",
        });
        if (!result.error) return candidate;
    }
    throw new Error("CRE CLI was not found. Install it or set CRE_CLI to its executable path.");
}

const cre = resolveCreCommand();

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        env: commandEnvironment,
        encoding: "utf8",
        stdio: options.capture ? "pipe" : "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        if (options.capture) process.stderr.write(result.stderr || result.stdout || "");
        throw new Error(`${command} exited with status ${result.status}`);
    }
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function workflowPermission(name) {
    const permission = deploymentConfig.workflowPermissions.find((entry) => entry.name === name);
    if (!permission) throw new Error(`Missing ${name} permission in ${configPath}`);
    return permission;
}

function readWorkflowIdentity(folder, permissionName) {
    const output = run(
        cre,
        [
            "-e",
            ".env",
            "workflow",
            "hash",
            `./${folder}`,
            "--target",
            "staging-settings",
            "--non-interactive",
            "--verbose",
        ],
        {cwd: creRoot, capture: true}
    );
    const workflowHash = output.match(/Workflow hash:\s*([0-9a-fA-F]{64})/)?.[1];
    const derivedOwner = output.match(/derivedWorkflowOwners[^\n]*?([0-9a-fA-F]{40})/)?.[1];
    if (!workflowHash || !derivedOwner) {
        throw new Error(`Could not derive CRE identity for ${folder}`);
    }

    const actualId = `0x${workflowHash}`.toLowerCase();
    const expected = workflowPermission(permissionName);
    return {
        name: permissionName,
        id: actualId,
        expectedId: expected.id.toLowerCase(),
        owner: `0x${derivedOwner}`.toLowerCase(),
    };
}

function readIdentities() {
    const identities = [
        readWorkflowIdentity("nav-workflow", "nav-staging"),
        readWorkflowIdentity("finalization-workflow", "finalization-staging"),
    ];
    const owners = new Set(identities.map(({owner}) => owner));
    if (owners.size !== 1)
        throw new Error("CRE workflows resolved to different organization owners");
    return {identities, owner: identities[0].owner};
}

function assertIdentityMatchesConfig({identities, owner}) {
    const errors = [];
    if (owner !== deploymentConfig.workflowOwner.toLowerCase()) {
        errors.push(
            `CRE organization owner mismatch: config=${deploymentConfig.workflowOwner}, actual=${owner}`
        );
    }
    for (const identity of identities) {
        if (identity.id !== identity.expectedId) {
            errors.push(
                `${identity.name} ID mismatch: config=${identity.expectedId}, actual=${identity.id}`
            );
        }
    }
    if (errors.length > 0) throw new Error(errors.join("\n"));
}

function printIdentity({identities, owner}) {
    console.log(`CRE organization owner: ${owner}`);
    for (const identity of identities) console.log(`${identity.name}: ${identity.id}`);
}

function runOnchainStatus(strict) {
    run("npx", ["hardhat", "run", "scripts/cre/statusCREAutomation.ts", "--network", network], {
        cwd: repositoryRoot,
        ...(strict ? {env: undefined} : {}),
    });
}

function runValidation() {
    run("npm", ["run", `deploy:cre-receivers:${network}:validate`]);
}

function runWorkflow(folder, broadcast) {
    const mode = broadcast ? "BROADCAST" : "SIMULATION";
    console.log(`\n[${mode}] ${folder}`);
    console.log(
        broadcast
            ? "Real Sepolia writes are enabled. Successful writes should return a transaction hash."
            : "Using live Sepolia reads, but reports and writes are simulated; on-chain state will not change."
    );
    const args = [
        "-e",
        ".env",
        "workflow",
        "simulate",
        `./${folder}`,
        "--target",
        "staging-settings",
        "--trigger-index",
        "0",
        "--non-interactive",
    ];
    if (broadcast) args.push("--broadcast");
    run(cre, args, {cwd: creRoot});
    console.log(
        broadcast
            ? `[${mode}] ${folder} finished. Check each ready target's txHash above.`
            : `[${mode}] ${folder} finished without broadcasting transactions.`
    );
}

switch (action) {
    case "check": {
        console.log("=== CRE preflight — Sepolia ===");
        const identity = readIdentities();
        assertIdentityMatchesConfig(identity);
        printIdentity(identity);
        runValidation();
        commandEnvironment.CRE_STATUS_STRICT = "true";
        runOnchainStatus(true);
        console.log("CRE Sepolia preflight passed.");
        break;
    }
    case "setup": {
        console.log("=== CRE setup — Sepolia ===");
        const identity = readIdentities();
        assertIdentityMatchesConfig(identity);
        printIdentity(identity);
        run("npm", ["run", `deploy:cre-receivers:${network}`]);
        commandEnvironment.CRE_STATUS_STRICT = "true";
        runOnchainStatus(true);
        break;
    }
    case "simulate":
        console.log("=== CRE local simulation against Sepolia ===");
        runWorkflow("nav-workflow", false);
        runWorkflow("finalization-workflow", false);
        break;
    case "broadcast": {
        console.log("=== CRE BROADCAST — Sepolia ===");
        console.log("This command can change Sepolia contract state.");
        const identity = readIdentities();
        assertIdentityMatchesConfig(identity);
        commandEnvironment.CRE_STATUS_STRICT = "true";
        runOnchainStatus(true);
        runWorkflow("nav-workflow", true);
        runWorkflow("finalization-workflow", true);
        break;
    }
    case "status": {
        console.log("=== CRE status — Sepolia ===");
        const account = run(cre, ["whoami"], {cwd: creRoot, capture: true});
        const accountLines = account
            .split("\n")
            .filter((line) => /Organization|Deploy Access/.test(line));
        for (const line of accountLines) console.log(line.trim());
        try {
            const identity = readIdentities();
            printIdentity(identity);
            for (const item of identity.identities) {
                console.log(
                    `${item.name} config: ${item.id === item.expectedId ? "OK" : "MISMATCH"}`
                );
            }
            console.log(
                `organization owner config: ${identity.owner === deploymentConfig.workflowOwner.toLowerCase() ? "OK" : "MISMATCH"}`
            );
        } catch (error) {
            console.log(`Workflow identity: unavailable (${error.message})`);
        }
        runOnchainStatus(false);
        break;
    }
    default:
        throw new Error(
            "Usage: node scripts/cre/manage.mjs <check|setup|simulate|broadcast|status> sepolia"
        );
}
