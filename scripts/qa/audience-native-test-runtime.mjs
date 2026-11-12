import "./audience-controlled-wire-runtime.mjs";
import { register } from "node:module";
register("./audience-css-loader.mjs", import.meta.url);
register("./bryntum-react-esm-loader.mjs", import.meta.url);
