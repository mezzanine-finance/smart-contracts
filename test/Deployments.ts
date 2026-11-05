import {expect} from "chai";
import {
    type DeploymentsFile,
    getLatestDeployment,
    recordDeployment,
} from "../scripts/deployment/lib/deployments";

describe("deployment records", () => {
    const first = {
        address: "0x0000000000000000000000000000000000000001",
    };
    const second = {
        address: "0x0000000000000000000000000000000000000002",
    };

    it("keeps deployment versions independent across namespaces", () => {
        const deployments: DeploymentsFile = {};

        const vault1 = recordDeployment(deployments, "sepolia", "MZUSD", first, "vault-1");
        const vault2 = recordDeployment(deployments, "sepolia", "MZUSD", second, "vault-2");

        expect(vault1.version).to.equal(1);
        expect(vault2.version).to.equal(1);
        expect(getLatestDeployment(deployments, "sepolia", "MZUSD", "vault-1")?.address).to.equal(
            first.address
        );
        expect(getLatestDeployment(deployments, "sepolia", "MZUSD", "vault-2")?.address).to.equal(
            second.address
        );
    });

    it("stores shared deployments in their own namespace", () => {
        const deployments: DeploymentsFile = {};

        recordDeployment(deployments, "sepolia", "AccessManager", first, "shared");

        expect(
            getLatestDeployment(deployments, "sepolia", "AccessManager", "shared")?.address
        ).to.equal(first.address);
        expect(getLatestDeployment(deployments, "sepolia", "AccessManager", "vault-1")).to.equal(
            undefined
        );
    });

    it("continues to read and append legacy deployment records", () => {
        const deployments: DeploymentsFile = {
            sepolia: {
                MZUSD: [{version: 1, ...first}],
            },
        };

        const appended = recordDeployment(deployments, "sepolia", "MZUSD", second);

        expect(appended.version).to.equal(2);
        expect(getLatestDeployment(deployments, "sepolia", "MZUSD")?.address).to.equal(
            second.address
        );
    });

    it("rejects a namespace that conflicts with a legacy contract key", () => {
        const deployments: DeploymentsFile = {
            sepolia: {
                shared: [{version: 1, ...first}],
            },
        };

        expect(() =>
            recordDeployment(deployments, "sepolia", "AccessManager", second, "shared")
        ).to.throw("Deployment namespace conflicts with legacy contract key: shared");
    });
});
