import {log} from "./lib/logger";
import {grantRoles} from "./lib/roleActions";

grantRoles().catch((err) => {
    log.error(err?.message ?? err);
    process.exitCode = 1;
});
