import "./isolate.mjs";
import { register } from "node:module";
// Mounted behavior only. This loader preserves CSS hook names;it does not simulate layout or native rendering.
register("./dom-loader.mjs",import.meta.url);
