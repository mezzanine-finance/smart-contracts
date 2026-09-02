export function hasCurrentRuntimeBytecode(
    deployedCode: string,
    expectedRuntimeCode: string
): boolean {
    return (
        deployedCode !== "0x" &&
        expectedRuntimeCode !== "0x" &&
        deployedCode.toLowerCase() === expectedRuntimeCode.toLowerCase()
    );
}

export function shouldConfigureReceiver(prepareOnly: boolean, newlyDeployed: boolean): boolean {
    return !prepareOnly && !newlyDeployed;
}
