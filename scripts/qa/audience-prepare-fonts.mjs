/** Offline mapping for exactly the three already accepted, immutable public font faces. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { audienceSha256 } from "./audience-inputs.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, ""), directory = resolve(root, ".private/audience-font-cache");
const faces = [
  { family: "Inter", query: "Inter", weights: "100..900", range: "100 900", font: "07c7676b89ed2778-s.p.2bn3s6zvc0dyp.woff2", sha256: "c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4" },
  { family: "Oswald", query: "Oswald", weights: "200..700", range: "200 700", font: "47bc4ee240b788ba-s.p.3nglv5iys3s0a.woff2", sha256: "c36937da4c39049704f1def587f7837a24ad52d3bfd2d27d3b6eb9f4220b2e3a" },
  { family: "JetBrains Mono", query: "JetBrains+Mono", weights: "100..800", range: "100 800", font: "53897e768d329f66-s.p.3t6q91iet4nsy.woff2", sha256: "1e06740a02a443fb7f3eeda8fcaa685a0f6c620e3f01e6666e847295469ce3ad" },
];
export async function audienceFontCache(prepare = false) {
  if (process.cwd() !== root) throw new Error("Use the exact audience checkout for offline fonts");
  const mapping = {}, records = [];
  for (const face of faces) {
    const bytes = await readFile(resolve(root, "public/audience/fonts", face.font)); if (audienceSha256(bytes) !== face.sha256) throw new Error("An accepted public font face changed");
    const publicPath = "/audience/fonts/" + face.font;
    mapping["https://fonts.googleapis.com/css2?family=" + face.query + ":wght@" + face.weights + "&display=swap"] = "/* latin */\n@font-face{font-family:'" + face.family + "';font-style:normal;font-weight:" + face.range + ";font-display:swap;src:url(" + publicPath + ") format('woff2');unicode-range:U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}";
    records.push({ family: face.family, font: face.font, sha256: face.sha256, bytes: bytes.length, publicPath, sourceCommit: "2b80219a17bce80a6705dde4e82e60160f0316e4", provenance: "Opening lead/root approved accepted N2 font bytes, copied with distinct APFS COW inodes" });
  }
  const expected = "module.exports=" + JSON.stringify(mapping) + ";\n";
  if (prepare) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await writeFile(resolve(directory, "responses.cjs"), expected, { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    try { await writeFile(resolve(directory, "provenance.json"), JSON.stringify({ version: 1, records }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (await readFile(resolve(directory, "responses.cjs"), "utf8") !== expected) throw new Error("The original offline font-response mapping differs; it was preserved");
  const provenance = JSON.parse(await readFile(resolve(directory, "provenance.json"), "utf8"));
  if (provenance.records.length !== 3 || records.some(face => !provenance.records.some(saved => saved.family === face.family && saved.font === face.font && saved.sha256 === face.sha256 && saved.bytes === face.bytes))) throw new Error("Offline font provenance does not match its accepted bytes");
  return { directory, records, mockResponseSha256: audienceSha256(expected) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const value = await audienceFontCache(true); console.log(JSON.stringify({ faces: value.records.length, mockResponseSha256: value.mockResponseSha256, networkRequests: 0 })); }
