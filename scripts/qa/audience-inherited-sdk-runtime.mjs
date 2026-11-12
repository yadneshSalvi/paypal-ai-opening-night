/** Preserve inherited virtual Request origins without authorizing any listener or connection on them. */
import "./audience-controlled-wire-runtime.mjs";
const entry = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/tests\/supplier-recovery-(api|store)\.test\.ts$/.test(entry) || /^tests\/supplier-recovery-(api|store)\.test\.ts$/.test(entry)) {
  process.env.APP_BASE_URL = "http://127.0.0.1:4586";
  process.env.SUPPLIER_SERVICE_BASE_URL = "http://127.0.0.1:4586";
  process.env.OPENING_NIGHT_SUPPLIER_RECOVERY_QA = "1";
}
else if (/\/tests\/rental-closeout-(api|store)\.test\.ts$/.test(entry) || /^tests\/rental-closeout-(api|store)\.test\.ts$/.test(entry)) process.env.APP_BASE_URL = "http://127.0.0.1:4580";
// audience-disabled-runtime's transport policy still blocks both of these ports.
// Existing test adapters route synthetic Requests directly to owned handler functions.
