// The published wrappers declare a bundler `module` entry but omit `type`.
// Next consumes their ESM normally. Node's installed-engine component tests
// read those same files as ESM, without modifying or replacing vendor code.
import { readFile } from 'node:fs/promises';
export async function load(url, context, nextLoad) {
  if (/\/node_modules\/@bryntum\/[^/]+-react-enterprise\/lib\/.*\.js$/.test(url)) {
    return { format: 'module', source: await readFile(new URL(url), 'utf8'), shortCircuit: true };
  }
  return nextLoad(url, context);
}
