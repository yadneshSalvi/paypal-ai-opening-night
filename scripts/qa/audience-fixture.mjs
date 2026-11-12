/** Exact private ready-fixture selection; never replaces an accepted selection or renews authority. */
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { audienceSha256 } from "./audience-inputs.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
export const audienceFixtureBase = mode => { if (!["http", "native"].includes(mode)) throw new Error("Choose the owned HTTP or native audience fixture"); return ".artifacts/audience-" + mode + "-4594"; };
async function readOriginal(filename) {
  const path = resolve(root, filename), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 500000 || await realpath(path) !== path) throw new Error("An original private bounded fixture file is required");
  const bytes = await readFile(path), fixture = JSON.parse(bytes);
  if (fixture.version !== 1 || fixture.state !== "ready" || fixture.origin !== "http://127.0.0.1:4594" || !/^audience_review_[a-f0-9]{32}$/.test(fixture.schema)) throw new Error("The exact original ready audience preparation is required");
  if (!/^[A-Za-z0-9_-]{43}$/.test(fixture.bootstrapKey) || !fixture.access || !fixture.attendees || Object.keys(fixture.access).length > 20 || Object.keys(fixture.attendees).length > 400 || Object.values(fixture.access).some(access => !/^[A-Za-z0-9_-]{43}$/.test(access.token) || !/^[a-f0-9]{64}$/.test(access.sessionHash) || !Number.isFinite(Date.parse(access.expiresAt))) || Object.values(fixture.attendees).some(link => !/^\/attendee#att_[A-Za-z0-9_-]{43}$/.test(link.url) || !Number.isFinite(Date.parse(link.expiresAt)))) throw new Error("The original bounded capability inventory is invalid");
  return { filename, bytes, fixture, directory: relative(root, dirname(path)) };
}
export async function selectedAudienceFixture(mode) {
  if (process.cwd() !== root) throw new Error("Use the exact audience checkout");
  const base = audienceFixtureBase(mode), selectionFile = base + "/selected-fixture.json", stat = await lstat(selectionFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 5000 || await realpath(resolve(root, selectionFile)) !== resolve(root, selectionFile)) throw new Error("The original private fixture selector is required");
  const selection = JSON.parse(await readFile(selectionFile, "utf8"));
  if (selection.version !== 1 || selection.mode !== mode || !/^(?:preparation-[a-f0-9-]{36}\/)?fixture\.json$/.test(selection.fixture)) throw new Error("An exact bounded audience fixture selection is required");
  const original = await readOriginal(base + "/" + selection.fixture);
  if (audienceSha256(original.bytes) !== selection.fixtureSha256 || original.fixture.sourceInputDigest !== selection.sourceInputDigest) throw new Error("The original selected fixture changed; it was not replaced");
  return { ...original, base, selection, selectionFile };
}
export async function publishAudienceFixture(mode, directory) {
  const base = audienceFixtureBase(mode), local = relative(resolve(root, base), resolve(root, directory, "fixture.json"));
  if (!/^(?:preparation-[a-f0-9-]{36}\/)?fixture\.json$/.test(local)) throw new Error("Fixture publication cannot escape this owned review");
  const original = await readOriginal(base + "/" + local), selection = { version: 1, mode, fixture: local, fixtureSha256: audienceSha256(original.bytes), sourceInputDigest: original.fixture.sourceInputDigest, selectedAt: new Date().toISOString(), renewal: false };
  await writeFile(base + "/selected-fixture.json", JSON.stringify(selection, null, 2) + "\n", { flag: "wx", mode: 0o600 }); return selection;
}
