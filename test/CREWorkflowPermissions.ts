import {expect} from "chai";
import {buildWorkflowPermissionChanges} from "../scripts/deployment/lib/creWorkflowPermissions";
import {hasCurrentRuntimeBytecode} from "../scripts/deployment/lib/creReceiverDeployment";

describe("CRE workflow permission reconciliation", () => {
    it("does nothing when active permissions match the desired state", () => {
        const ids = new Set(["0xnav", "0xfinalization"]);

        expect(buildWorkflowPermissionChanges(ids, ids)).to.deep.equal([]);
    });

    it("revokes the previous ID and allows its replacement", () => {
        const active = new Set(["0xold-nav", "0xfinalization"]);
        const desired = new Set(["0xnew-nav", "0xfinalization"]);

        expect(buildWorkflowPermissionChanges(active, desired)).to.deep.equal([
            {id: "0xold-nav", allowed: false},
            {id: "0xnew-nav", allowed: true},
        ]);
    });

    it("revokes every tracked permission that is no longer desired", () => {
        const active = new Set(["0xold-nav", "0xtemporary", "0xfinalization"]);
        const desired = new Set(["0xfinalization"]);

        expect(buildWorkflowPermissionChanges(active, desired)).to.deep.equal([
            {id: "0xold-nav", allowed: false},
            {id: "0xtemporary", allowed: false},
        ]);
    });
});

describe("CRE receiver deployment selection", () => {
    it("reuses a deployment only when its runtime bytecode matches", () => {
        expect(hasCurrentRuntimeBytecode("0xABCD", "0xabcd")).to.equal(true);
        expect(hasCurrentRuntimeBytecode("0xabcd", "0x1234")).to.equal(false);
    });

    it("does not reuse an address without deployed bytecode", () => {
        expect(hasCurrentRuntimeBytecode("0x", "0xabcd")).to.equal(false);
        expect(hasCurrentRuntimeBytecode("0xabcd", "0x")).to.equal(false);
    });
});
