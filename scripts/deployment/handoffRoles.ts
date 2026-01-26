import {log} from "./lib/logger";
import {grantRoles, renounceRoles} from "./lib/roleActions";

async function main() {
    log.step("Role handoff");
    await grantRoles();
    await renounceRoles();
    log.success("Role handoff complete");
}

main().catch((err) => {
    log.error(err?.message ?? err);
    process.exitCode = 1;
});
