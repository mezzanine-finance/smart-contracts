// List which workflow IDs to allow or revoke; does not send transactions.
export interface WorkflowPermissionChange {
    id: string;
    allowed: boolean;
}

export function buildWorkflowPermissionChanges(
    activeIds: ReadonlySet<string>,
    desiredIds: ReadonlySet<string>
): WorkflowPermissionChange[] {
    const changes: WorkflowPermissionChange[] = [];
    for (const id of activeIds) {
        if (!desiredIds.has(id)) changes.push({id, allowed: false});
    }
    for (const id of desiredIds) {
        if (!activeIds.has(id)) changes.push({id, allowed: true});
    }
    return changes;
}
