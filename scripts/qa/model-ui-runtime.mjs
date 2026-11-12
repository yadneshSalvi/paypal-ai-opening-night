import './model-controlled-runtime.mjs';
import { register } from 'node:module';
register('./model-ui-loader.mjs', import.meta.url);
