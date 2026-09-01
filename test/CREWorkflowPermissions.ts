import {expect} from "chai";
import {buildWorkflowPermissionChanges} from "../scripts/deployment/lib/creWorkflowPermissions";

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
