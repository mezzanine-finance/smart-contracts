// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICREReceiver} from "../interfaces/ICREReceiver.sol";

/// @title CRE automation receiver
/// @notice Validates CRE workflow reports and forwards approved upkeep calls.
/// @dev Deploy one instance per vault and allow only that vault's automation targets.
///      Reports are encoded as abi.encode(target, callData). CRE identity metadata is packed as
///      workflowId (32 bytes), workflowName (10 bytes), and workflowOwner (20 bytes).
contract AutomationReceiver is ICREReceiver, Ownable {
    uint256 private constant IDENTITY_METADATA_LENGTH = 62;
    uint256 private constant FORWARDER_METADATA_LENGTH = 64;

    address public forwarder;
    address public workflowOwner;

    mapping(bytes32 workflowId => bool allowed) public allowedWorkflowIds;
    mapping(address target => mapping(bytes4 selector => bool allowed)) public allowedCalls;

    error ZeroAddress();
    error InvalidMetadataLength(uint256 received);
    error InvalidSender(address received, address expected);
    error InvalidWorkflowOwner(address received, address expected);
    error WorkflowNotAllowed(bytes32 workflowId);
    error InvalidCallData();
    error CallNotAllowed(address target, bytes4 selector);
    error TargetCallFailed();

    event ForwarderUpdated(address indexed previousForwarder, address indexed newForwarder);
    event WorkflowOwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event WorkflowPermissionUpdated(bytes32 indexed workflowId, bool allowed);
    event CallPermissionUpdated(address indexed target, bytes4 indexed selector, bool allowed);
    event CallForwarded(
        bytes32 indexed workflowId,
        address indexed target,
        bytes4 indexed selector
    );

    constructor(
        address initialOwner,
        address forwarder_,
        address workflowOwner_
    ) Ownable(initialOwner) {
        if (forwarder_ == address(0) || workflowOwner_ == address(0)) revert ZeroAddress();
        forwarder = forwarder_;
        workflowOwner = workflowOwner_;
    }

    /// @notice Accept a verified CRE report and forward its approved call.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        if (
            metadata.length != IDENTITY_METADATA_LENGTH &&
            metadata.length != FORWARDER_METADATA_LENGTH
        ) revert InvalidMetadataLength(metadata.length);

        (bytes32 workflowId, address reportWorkflowOwner) = _decodeMetadata(metadata);
        if (reportWorkflowOwner != workflowOwner)
            revert InvalidWorkflowOwner(reportWorkflowOwner, workflowOwner);
        if (!allowedWorkflowIds[workflowId]) revert WorkflowNotAllowed(workflowId);

        (address target, bytes memory callData) = abi.decode(report, (address, bytes));
        if (target == address(0)) revert ZeroAddress();
        if (callData.length < 4) revert InvalidCallData();

        bytes4 selector = _selector(callData);
        if (!allowedCalls[target][selector]) revert CallNotAllowed(target, selector);

        (bool success, bytes memory returnData) = target.call(callData);
        if (!success) {
            if (returnData.length == 0) revert TargetCallFailed();
            assembly ("memory-safe") {
                revert(add(returnData, 32), mload(returnData))
            }
        }

        emit CallForwarded(workflowId, target, selector);
    }

    function setForwarder(address newForwarder) external onlyOwner {
        if (newForwarder == address(0)) revert ZeroAddress();
        address previousForwarder = forwarder;
        forwarder = newForwarder;
        emit ForwarderUpdated(previousForwarder, newForwarder);
    }

    function setWorkflowOwner(address newWorkflowOwner) external onlyOwner {
        if (newWorkflowOwner == address(0)) revert ZeroAddress();
        address previousOwner = workflowOwner;
        workflowOwner = newWorkflowOwner;
        emit WorkflowOwnerUpdated(previousOwner, newWorkflowOwner);
    }

    function setWorkflowPermission(bytes32 workflowId, bool allowed) external onlyOwner {
        allowedWorkflowIds[workflowId] = allowed;
        emit WorkflowPermissionUpdated(workflowId, allowed);
    }

    function setCallPermission(address target, bytes4 selector, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedCalls[target][selector] = allowed;
        emit CallPermissionUpdated(target, selector, allowed);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(ICREReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    function _decodeMetadata(
        bytes calldata metadata
    ) private pure returns (bytes32 workflowId, address reportWorkflowOwner) {
        workflowId = bytes32(metadata[0:32]);
        reportWorkflowOwner = address(bytes20(metadata[42:62]));
    }

    function _selector(bytes memory callData) private pure returns (bytes4 selector) {
        selector = bytes4(callData);
    }
}
