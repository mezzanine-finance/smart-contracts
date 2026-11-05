import {expect} from "chai";
import {
    resolveWorkflowReceivers,
    syncWorkflowReceivers,
    type CREWorkflowConfig,
} from "../scripts/deployment/lib/creWorkflowConfig";

describe("CRE workflow receiver config synchronization", () => {
    const config = (): CREWorkflowConfig => ({
        schedule: "0 */5 * * * *",
        vaults: [
            {id: "vault-1", receiver: "0xold1", target: "0xtarget1"},
            {id: "vault-2", receiver: "0xold2", target: "0xtarget2"},
        ],
    });

    it("updates receiver addresses without changing other workflow settings", () => {
        const result = syncWorkflowReceivers(
            config(),
            new Map([
                ["vault-1", "0xnew1"],
                ["vault-2", "0xnew2"],
            ])
        );

        expect(result.changed).to.equal(true);
        expect(result.config).to.deep.equal({
            schedule: "0 */5 * * * *",
            vaults: [
                {id: "vault-1", receiver: "0xnew1", target: "0xtarget1"},
                {id: "vault-2", receiver: "0xnew2", target: "0xtarget2"},
            ],
        });
    });

    it("does nothing when receiver addresses already match", () => {
        const current = config();
        const result = syncWorkflowReceivers(
            current,
            new Map([
                ["vault-1", "0xold1"],
                ["vault-2", "0xold2"],
            ])
        );

        expect(result.changed).to.equal(false);
        expect(result.config).to.equal(current);
    });

    it("rejects incomplete or unknown vault mappings", () => {
        expect(() => syncWorkflowReceivers(config(), new Map([["vault-1", "0xnew1"]]))).to.throw(
            "Workflow vault has no receiver deployment: vault-2"
        );
        expect(() =>
            syncWorkflowReceivers(
                config(),
                new Map([
                    ["vault-1", "0xnew1"],
                    ["vault-2", "0xnew2"],
                    ["vault-3", "0xnew3"],
                ])
            )
        ).to.throw("Receiver deployment has no matching workflow vault: vault-3");
    });
});

describe("CRE workflow receiver config validation", () => {
    it("resolves matching receiver addresses across workflows", () => {
        const first: CREWorkflowConfig = {
            vaults: [
                {id: "vault-1", receiver: "0xAa"},
                {id: "vault-2", receiver: "0xBb"},
            ],
        };
        const second: CREWorkflowConfig = {
            vaults: [
                {id: "vault-1", receiver: "0xaa"},
                {id: "vault-2", receiver: "0xbb"},
            ],
        };

        expect([...resolveWorkflowReceivers([first, second])]).to.deep.equal([
            ["vault-1", "0xAa"],
            ["vault-2", "0xBb"],
        ]);
    });

    it("rejects receiver and vault-set mismatches", () => {
        const first: CREWorkflowConfig = {
            vaults: [
                {id: "vault-1", receiver: "0xAa"},
                {id: "vault-2", receiver: "0xBb"},
            ],
        };

        expect(() =>
            resolveWorkflowReceivers([first, {vaults: [{id: "vault-1", receiver: "0xDifferent"}]}])
        ).to.throw("Workflow receiver mismatch for vault-1");
        expect(() =>
            resolveWorkflowReceivers([first, {vaults: [{id: "vault-1", receiver: "0xAa"}]}])
        ).to.throw("Workflow configs contain different vault sets");
    });

    it("rejects a missing receiver", () => {
        expect(() => resolveWorkflowReceivers([{vaults: [{id: "vault-1"}]}])).to.throw(
            "Workflow vault has no receiver: vault-1"
        );
    });
});
