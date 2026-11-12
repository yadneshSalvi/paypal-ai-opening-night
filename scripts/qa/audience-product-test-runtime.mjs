// Compatibility with the original product assertions, beneath the strict owned-PG guard.
import "./audience-disabled-runtime.mjs";
import "./disabled-providers.mjs";
import { register } from "node:module";
register("./bryntum-react-esm-loader.mjs", import.meta.url);
