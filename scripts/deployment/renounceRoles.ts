import {log} from "./lib/logger";
import {renounceRoles} from "./lib/roleActions";

renounceRoles().catch((err) => {
    log.error(err?.message ?? err);
    process.exitCode = 1;
});
