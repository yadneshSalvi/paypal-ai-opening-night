import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createHash } from "node:crypto";
export const audienceSha256 = value => createHash("sha256").update(value).digest("hex");
async function walk(directory) { const files = []; for (const item of await readdir(directory, { withFileTypes: true })) { if (item.isSymbolicLink()) throw new Error("Audience production inputs cannot follow symbolic links"); const filename = resolve(directory, item.name); if (item.isDirectory()) files.push(...await walk(filename)); else if (item.isFile()) files.push(filename); } return files; }
export async function audienceProductionInputs(root) {
  const files = [...await walk(resolve(root, "src")), ...await walk(resolve(root, "public")), ...["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "next-env.d.ts"].map(file => resolve(root, file))].sort();
  const records = []; for (const filename of files) { const bytes = await readFile(filename); records.push({ path: relative(root, filename), bytes: bytes.length, sha256: audienceSha256(bytes) }); }
  return { records, digest: audienceSha256(JSON.stringify(records)) };
}
