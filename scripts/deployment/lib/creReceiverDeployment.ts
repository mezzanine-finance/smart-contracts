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
