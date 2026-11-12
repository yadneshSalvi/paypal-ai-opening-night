/** CSS-only jsdom adapter. Component logic and actual handlers/storage remain unchanged. Not a layout proof. */
import { readFile } from "node:fs/promises";
export async function load(url, context, nextLoad) {
  if (url.endsWith("/src/components/audience/audience.module.css")) {
    const css = await readFile(new URL(url), "utf8"), names = [...new Set([...css.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map(match => match[1]))];
    return { format: "module", source: `export default ${JSON.stringify(Object.fromEntries(names.map(name => [name, name])))}`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
