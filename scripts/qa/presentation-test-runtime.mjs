// No network, database, session authority or provider configuration. Only an
// explicitly supplied project widget license is accepted by installed UI tests.
import "../evaluation/isolate.mjs";
import { register } from "node:module";
register("./bryntum-react-esm-loader.mjs", import.meta.url);
