import {expect} from "chai";
import {ethers} from "hardhat";

describe("AutomationReceiver", () => {
    const NAV_WORKFLOW_ID = ethers.id("nav-workflow");
    const FINALIZATION_WORKFLOW_ID = ethers.id("finalization-workflow");
    const WORKFLOW_NAME = ethers.dataSlice(ethers.id("workflow-name"), 0, 10);

    let owner: any;
    let forwarder: any;
    let workflowOwner: any;
    let other: any;
    let receiver: any;
    let target: any;

    const metadata = (workflowId: string, author: string) =>
        ethers.solidityPacked(
            ["bytes32", "bytes10", "address"],
            [workflowId, WORKFLOW_NAME, author]
        );

    const report = (targetAddress: string, callData: string) =>
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes"], [targetAddress, callData]);

    beforeEach(async () => {
        [owner, forwarder, workflowOwner, other] = await ethers.getSigners();

        receiver = await ethers.deployContract("AutomationReceiver", [
            owner.address,
            forwarder.address,
            workflowOwner.address,
        ]);
        target = await ethers.deployContract("MockAutomationTarget");

        await receiver.setWorkflowPermission(NAV_WORKFLOW_ID, true);
        await receiver.setWorkflowPermission(FINALIZATION_WORKFLOW_ID, true);
        await receiver.setCallPermission(
            target.target,
            target.interface.getFunction("performUpkeep").selector,
            true
        );
    });

    it("forwards an approved upkeep call", async () => {
        const performData = "0x1234";
        const callData = target.interface.encodeFunctionData("performUpkeep", [performData]);

        await expect(
            receiver
                .connect(forwarder)
                .onReport(
                    metadata(NAV_WORKFLOW_ID, workflowOwner.address),
                    report(target.target, callData)
                )
        )
            .to.emit(receiver, "CallForwarded")
            .withArgs(
                NAV_WORKFLOW_ID,
                target.target,
                target.interface.getFunction("performUpkeep").selector
            );

        expect(await target.calls()).to.equal(1);
        expect(await target.lastPerformData()).to.equal(performData);
    });

    it("accepts both configured workflow IDs", async () => {
        const callData = target.interface.encodeFunctionData("performUpkeep", ["0x"]);

        await receiver
            .connect(forwarder)
            .onReport(
                metadata(FINALIZATION_WORKFLOW_ID, workflowOwner.address),
                report(target.target, callData)
            );

        expect(await target.calls()).to.equal(1);
    });

    it("rejects calls that do not come from the forwarder", async () => {
        const callData = target.interface.encodeFunctionData("performUpkeep", ["0x"]);

        await expect(
            receiver
                .connect(other)
                .onReport(
                    metadata(NAV_WORKFLOW_ID, workflowOwner.address),
                    report(target.target, callData)
                )
        )
            .to.be.revertedWithCustomError(receiver, "InvalidSender")
            .withArgs(other.address, forwarder.address);
    });

    it("rejects malformed metadata", async () => {
        await expect(receiver.connect(forwarder).onReport("0x1234", "0x"))
            .to.be.revertedWithCustomError(receiver, "InvalidMetadataLength")
            .withArgs(2);
    });

    it("rejects zero addresses in the constructor", async () => {
        const factory = await ethers.getContractFactory("AutomationReceiver");

        await expect(
            factory.deploy(owner.address, ethers.ZeroAddress, workflowOwner.address)
        ).to.be.revertedWithCustomError(factory, "ZeroAddress");
        await expect(
            factory.deploy(owner.address, forwarder.address, ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("rejects a different workflow owner", async () => {
        const callData = target.interface.encodeFunctionData("performUpkeep", ["0x"]);

        await expect(
            receiver
                .connect(forwarder)
                .onReport(metadata(NAV_WORKFLOW_ID, other.address), report(target.target, callData))
        )
            .to.be.revertedWithCustomError(receiver, "InvalidWorkflowOwner")
            .withArgs(other.address, workflowOwner.address);
    });

    it("rejects a workflow ID outside the allowlist", async () => {
        const unknownWorkflowId = ethers.id("unknown-workflow");
        const callData = target.interface.encodeFunctionData("performUpkeep", ["0x"]);

        await expect(
            receiver
                .connect(forwarder)
                .onReport(
                    metadata(unknownWorkflowId, workflowOwner.address),
                    report(target.target, callData)
                )
        )
            .to.be.revertedWithCustomError(receiver, "WorkflowNotAllowed")
            .withArgs(unknownWorkflowId);
    });

    it("rejects a target and selector pair outside the allowlist", async () => {
        const callData = target.interface.encodeFunctionData("forbiddenCall");

        await expect(
            receiver
                .connect(forwarder)
                .onReport(
                    metadata(NAV_WORKFLOW_ID, workflowOwner.address),
                    report(target.target, callData)
                )
        )
            .to.be.revertedWithCustomError(receiver, "CallNotAllowed")
            .withArgs(target.target, target.interface.getFunction("forbiddenCall").selector);
    });

    it("rejects a zero target in a report", async () => {
        const callData = target.interface.encodeFunctionData("performUpkeep", ["0x"]);

        await expect(
            receiver
                .connect(forwarder)
                .onReport(
                    metadata(NAV_WORKFLOW_ID, workflowOwner.address),
                    report(ethers.ZeroAddress, callData)
                )
        ).to.be.revertedWithCustomError(receiver, "ZeroAddress");
    });

    it("rejects call data shorter than a function selector", async () => {
        await expect(
            receiver
                .connect(forwarder)
                .onReport(
                    metadata(NAV_WORKFLOW_ID, workflowOwner.address),
                    report(target.target, "0x123456")
                )
        ).to.be.revertedWithCustomError(receiver, "InvalidCallData");
    });

    it("can revoke workflow and call permissions", async () => {
        const selector = target.interface.getFunction("performUpkeep").selector;
        const callData = target.interface.encodeFunctionData("performUpkeep", ["0x"]);
        const encodedReport = report(target.target, callData);

        await receiver.setWorkflowPermission(NAV_WORKFLOW_ID, false);
        await expect(
            receiver
                .connect(forwarder)
                .onReport(metadata(NAV_WORKFLOW_ID, workflowOwner.address), encodedReport)
        ).to.be.revertedWithCustomError(receiver, "WorkflowNotAllowed");

        await receiver.setWorkflowPermission(NAV_WORKFLOW_ID, true);
        await receiver.setCallPermission(target.target, selector, false);
        await expect(
            receiver
                .connect(forwarder)
                .onReport(metadata(NAV_WORKFLOW_ID, workflowOwner.address), encodedReport)
        ).to.be.revertedWithCustomError(receiver, "CallNotAllowed");
    });

    it("restricts configuration changes to the owner", async () => {
        const selector = target.interface.getFunction("performUpkeep").selector;

        await expect(receiver.connect(other).setWorkflowPermission(NAV_WORKFLOW_ID, false))
            .to.be.revertedWithCustomError(receiver, "OwnableUnauthorizedAccount")
            .withArgs(other.address);
        await expect(receiver.connect(other).setForwarder(other.address))
            .to.be.revertedWithCustomError(receiver, "OwnableUnauthorizedAccount")
            .withArgs(other.address);
        await expect(receiver.connect(other).setWorkflowOwner(other.address))
            .to.be.revertedWithCustomError(receiver, "OwnableUnauthorizedAccount")
            .withArgs(other.address);
        await expect(receiver.connect(other).setCallPermission(target.target, selector, false))
            .to.be.revertedWithCustomError(receiver, "OwnableUnauthorizedAccount")
            .withArgs(other.address);
    });

    it("updates the trusted forwarder", async () => {
        const callData = target.interface.encodeFunctionData("performUpkeep", ["0x"]);
        const encodedMetadata = metadata(NAV_WORKFLOW_ID, workflowOwner.address);
        const encodedReport = report(target.target, callData);

        await expect(receiver.setForwarder(other.address))
            .to.emit(receiver, "ForwarderUpdated")
            .withArgs(forwarder.address, other.address);
        expect(await receiver.forwarder()).to.equal(other.address);

        await expect(receiver.connect(forwarder).onReport(encodedMetadata, encodedReport))
            .to.be.revertedWithCustomError(receiver, "InvalidSender")
            .withArgs(forwarder.address, other.address);
        await receiver.connect(other).onReport(encodedMetadata, encodedReport);
        expect(await target.calls()).to.equal(1);
    });

    it("updates the trusted workflow owner", async () => {
        const callData = target.interface.encodeFunctionData("performUpkeep", ["0x"]);
        const encodedReport = report(target.target, callData);

        await expect(receiver.setWorkflowOwner(other.address))
            .to.emit(receiver, "WorkflowOwnerUpdated")
            .withArgs(workflowOwner.address, other.address);
        expect(await receiver.workflowOwner()).to.equal(other.address);

        await expect(
            receiver
                .connect(forwarder)
                .onReport(metadata(NAV_WORKFLOW_ID, workflowOwner.address), encodedReport)
        ).to.be.revertedWithCustomError(receiver, "InvalidWorkflowOwner");
        await receiver
            .connect(forwarder)
            .onReport(metadata(NAV_WORKFLOW_ID, other.address), encodedReport);
        expect(await target.calls()).to.equal(1);
    });

    it("rejects zero addresses in configuration", async () => {
        const selector = target.interface.getFunction("performUpkeep").selector;

        await expect(receiver.setForwarder(ethers.ZeroAddress)).to.be.revertedWithCustomError(
            receiver,
            "ZeroAddress"
        );
        await expect(receiver.setWorkflowOwner(ethers.ZeroAddress)).to.be.revertedWithCustomError(
            receiver,
            "ZeroAddress"
        );
        await expect(
            receiver.setCallPermission(ethers.ZeroAddress, selector, true)
        ).to.be.revertedWithCustomError(receiver, "ZeroAddress");
    });

    it("bubbles up a target revert", async () => {
        const selector = target.interface.getFunction("revertingCall").selector;
        const callData = target.interface.encodeFunctionData("revertingCall");
        await receiver.setCallPermission(target.target, selector, true);

        await expect(
            receiver
                .connect(forwarder)
                .onReport(
                    metadata(NAV_WORKFLOW_ID, workflowOwner.address),
                    report(target.target, callData)
                )
        ).to.be.revertedWithCustomError(target, "ForcedRevert");
    });

    it("uses a receiver error when the target reverts without data", async () => {
        const selector = target.interface.getFunction("revertingWithoutData").selector;
        const callData = target.interface.encodeFunctionData("revertingWithoutData");
        await receiver.setCallPermission(target.target, selector, true);

        await expect(
            receiver
                .connect(forwarder)
                .onReport(
                    metadata(NAV_WORKFLOW_ID, workflowOwner.address),
                    report(target.target, callData)
                )
        ).to.be.revertedWithCustomError(receiver, "TargetCallFailed");
    });

    it("supports the CRE receiver and ERC-165 interfaces", async () => {
        const onReportSelector = receiver.interface.getFunction("onReport").selector;
        expect(await receiver.supportsInterface(onReportSelector)).to.equal(true);
        expect(await receiver.supportsInterface("0x01ffc9a7")).to.equal(true);
        expect(await receiver.supportsInterface("0xffffffff")).to.equal(false);
    });
});
