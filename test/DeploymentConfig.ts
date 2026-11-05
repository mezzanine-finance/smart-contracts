import {expect} from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import {loadConfig} from "../scripts/deployment/lib/config";
import {readConfigProfile, mergeConfig} from "../scripts/deployment/lib/configProfiles";
import {resolveDeploymentScope} from "../scripts/deployment/lib/deploymentScope";
import {buildDeploymentPlan} from "../scripts/deployment/lib/deploymentPlan";
import {loadDeployments} from "../scripts/deployment/lib/deployments";

describe("deployment config profiles", () => {
    it("inherits objects but replaces complete tranche and role lists", () => {
        const base = {
            vault: {fee: 10, duration: 60},
            tranches: ["senior", "junior"],
            roles: {oracles: ["old"]},
        };
        const result = mergeConfig(base, {
            vault: {duration: 120},
            tranches: ["custom"],
            roles: {oracles: []},
        });
        expect(result).to.deep.equal({
            vault: {fee: 10, duration: 120},
            tranches: ["custom"],
            roles: {oracles: []},
        });
        expect(base.tranches).to.deep.equal(["senior", "junior"]);
    });

    it("rejects prototype keys", () => {
        expect(() => mergeConfig({}, JSON.parse('{"__proto__":{"polluted":true}}'))).to.throw(
            "Invalid configuration key"
        );
    });

    it("resolves parent paths relative to the child and rejects inheritance cycles", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mezzanine-config-test-"));
        try {
            fs.writeFileSync(path.join(dir, "base.json"), JSON.stringify({vault: {fee: 10}}));
            fs.writeFileSync(
                path.join(dir, "child.json"),
                JSON.stringify({extends: "./base.json", vault: {duration: 60}})
            );
            expect(readConfigProfile(path.join(dir, "child.json"))).to.deep.equal({
                vault: {fee: 10, duration: 60},
            });
            fs.writeFileSync(
                path.join(dir, "base.json"),
                JSON.stringify({extends: "./child.json"})
            );
            expect(() => readConfigProfile(path.join(dir, "child.json"))).to.throw(
                "Circular config inheritance"
            );
        } finally {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    });

    it("preserves legacy scope and supports shared or independent infrastructure", () => {
        expect(resolveDeploymentScope({})).to.deep.equal({
            vaultNamespace: undefined,
            sharedNamespace: undefined,
        });
        expect(resolveDeploymentScope({deploymentId: "vault-3"})).to.deep.equal({
            vaultNamespace: "vault-3",
            sharedNamespace: "shared",
        });
        expect(
            resolveDeploymentScope({deploymentId: "vault-3", infrastructureId: "platform-b"})
        ).to.deep.equal({vaultNamespace: "vault-3", sharedNamespace: "platform-b"});
        expect(() =>
            resolveDeploymentScope({deploymentId: "same", infrastructureId: "same"})
        ).to.throw("must be different");
        expect(() => resolveDeploymentScope({infrastructureId: "platform-b"})).to.throw(
            "requires a deploymentId"
        );
    });

    it("plans reuse of existing Sepolia vaults without falling back to legacy records", () => {
        const records = loadDeployments();
        for (const id of ["vault-1", "vault-2"]) {
            const config = loadConfig("sepolia", `scripts/deployment/config/sepolia-${id}.json`);
            const plan = buildDeploymentPlan(config, "sepolia", records);
            expect(plan.contracts.every((item) => item.action === "reuse")).to.equal(true);
            expect(plan.contracts.find((item) => item.key === "AccessManager")?.namespace).to.equal(
                "shared"
            );
            expect(plan.contracts.find((item) => item.key === "IssuanceVault")?.namespace).to.equal(
                id
            );
            expect(() =>
                buildDeploymentPlan(config, "sepolia", records, {freshShared: true})
            ).to.throw("Cannot replace shared infrastructure");
        }
    });

    it("plans a third vault using shared infrastructure and its own tranche set", () => {
        const config = loadConfig("sepolia", "scripts/deployment/config/sepolia-vault-1.json");
        const plan = buildDeploymentPlan(config, "sepolia", loadDeployments(), {
            deploymentId: "vault-3",
        });
        expect(
            plan.contracts
                .filter((item) => item.namespace === "shared")
                .every((item) => item.action === "reuse")
        ).to.equal(true);
        expect(
            plan.contracts
                .filter((item) => item.namespace === "vault-3")
                .every((item) => item.action === "deploy")
        ).to.equal(true);
        const independent = buildDeploymentPlan(
            {...config, deploymentId: "vault-3", infrastructureId: "platform-b"},
            "sepolia",
            loadDeployments()
        );
        expect(independent.contracts.every((item) => item.action === "deploy")).to.equal(true);
    });
});
