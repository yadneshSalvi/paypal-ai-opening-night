/** Theme rules, pre-paint script and mounted toggle in jsdom. Colour pairs are computed from globals.css itself. */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { THEME_ATTRIBUTE, THEME_BOOT_SCRIPT, THEME_BOOT_SCRIPT_CSP_HASH, THEME_STORAGE_KEY, applyTheme, currentTheme, readStoredTheme, resolveTheme, storeTheme, themedRoute } from "../src/components/theme";
import { DARK_CHART_PALETTE, chartPalette } from "../src/components/charts/palette";

const dom = new JSDOM("<!doctype html><html data-theme=\"dark\"><head></head><body></body></html>", { url: "http://127.0.0.1/plan", pretendToBeVisual: true, runScripts: "outside-only" });
for (const name of ["window", "document", "HTMLElement", "Element", "Node", "Event", "StorageEvent", "MutationObserver", "localStorage"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { ThemeRoute, ThemeToggle } = await import("../src/components/theme-toggle");

let root: Root | null = null;
async function mount(pathname: string) { const host = document.body.appendChild(document.createElement("div")); root = createRoot(host); await act(async () => root!.render(<PathnameContext.Provider value={pathname}><ThemeRoute /><ThemeToggle /></PathnameContext.Provider>)); return host; }
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); localStorage.clear(); document.documentElement.setAttribute(THEME_ATTRIBUTE, "dark"); });
const attribute = () => document.documentElement.getAttribute(THEME_ATTRIBUTE);

test("dark is the default; light applies only to console views and only when chosen", () => {
  for (const path of ["/", "/show", "/plan", "/plan/", "/resources", "/calendar", "/recovery", "/crew", "/wrap", "/tour"]) { assert.equal(themedRoute(path), true, path); assert.equal(resolveTheme("light", path), "light", path); assert.equal(resolveTheme(null, path), "dark", path); }
  for (const path of ["/attendee", "/crew/access", "/supplier/access", "/delivery/access", "/tour/crew", "/evaluation", "/approvals/review", "/presentation", "/plan/extra"]) { assert.equal(themedRoute(path), false, path); assert.equal(resolveTheme("light", path), "dark", path); }
  for (const stored of [undefined, null, "", "LIGHT", "system", "dark", 1, {}]) assert.equal(resolveTheme(stored, "/plan"), "dark");
});

test("storage failures never throw and fall back to dark", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  assert.equal(readStoredTheme(throwing), "dark"); assert.equal(readStoredTheme(null), "dark");
  // A refused write is reported, and the choice then lasts only for this page load.
  assert.equal(storeTheme("light", throwing), false); assert.equal(readStoredTheme(throwing), "light"); assert.equal(storeTheme("dark", null), false); assert.equal(readStoredTheme(null), "dark");
  const memory = new Map<string, string>(), storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
  assert.equal(storeTheme("light", storage), true); assert.equal(memory.get(THEME_STORAGE_KEY), "light"); assert.equal(readStoredTheme(storage), "light");
  memory.set(THEME_STORAGE_KEY, "<script>"); assert.equal(readStoredTheme(storage), "dark");
});

test("the pre-paint script sets light before React runs, only for a stored choice on a console view", () => {
  const run = (path: string, stored: string | null, broken = false) => {
    const page = new JSDOM("<!doctype html><html data-theme=\"dark\"><head></head><body></body></html>", { url: "http://127.0.0.1" + path, runScripts: "outside-only" });
    if (stored !== null) page.window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    if (broken) Object.defineProperty(page.window, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
    page.window.eval(THEME_BOOT_SCRIPT);
    return page.window.document.documentElement.getAttribute(THEME_ATTRIBUTE);
  };
  assert.equal(run("/plan", "light"), "light"); assert.equal(run("/", "light"), "light"); assert.equal(run("/calendar", "light"), "light");
  assert.equal(run("/plan", null), "dark"); assert.equal(run("/plan", "dark"), "dark"); assert.equal(run("/plan", "sepia"), "dark");
  assert.equal(run("/attendee", "light"), "dark"); assert.equal(run("/crew/access", "light"), "dark"); assert.equal(run("/evaluation", "light"), "dark");
  assert.equal(run("/plan", "light", true), "dark");
  // Static text: no interpolation of request data, and the published CSP hash is the hash of exactly this script.
  assert.equal(THEME_BOOT_SCRIPT_CSP_HASH, "sha256-" + createHash("sha256").update(THEME_BOOT_SCRIPT).digest("base64"));
  assert.doesNotMatch(THEME_BOOT_SCRIPT, /<\/script|<!--/i);
  const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<html lang="en" data-theme="dark" suppressHydrationWarning/); assert.match(layout, /<head><script id="opening-night-theme" dangerouslySetInnerHTML=\{\{ __html: THEME_BOOT_SCRIPT \}\} \/><\/head>/);
  assert.doesNotMatch(layout, /cookies\(\)|headers\(\)/);
});

test("the toggle is a labelled switch that persists the choice and restores it on the next mount", async () => {
  let host = await mount("/plan"), toggle = host.querySelector<HTMLButtonElement>("button[role=switch]")!;
  assert.equal(attribute(), "dark"); assert.equal(toggle.getAttribute("aria-checked"), "false"); assert.match(toggle.textContent!, /Light theme/); assert.equal(toggle.disabled, false);
  await act(async () => toggle.click());
  assert.equal(attribute(), "light"); assert.equal(localStorage.getItem(THEME_STORAGE_KEY), "light"); assert.equal(toggle.getAttribute("aria-checked"), "true"); assert.equal(currentTheme(), "light");
  await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); document.documentElement.setAttribute(THEME_ATTRIBUTE, "dark");
  host = await mount("/resources"); toggle = host.querySelector<HTMLButtonElement>("button[role=switch]")!;
  assert.equal(attribute(), "light"); assert.equal(toggle.getAttribute("aria-checked"), "true");
  await act(async () => toggle.click());
  assert.equal(attribute(), "dark"); assert.equal(localStorage.getItem(THEME_STORAGE_KEY), "dark"); assert.equal(toggle.getAttribute("aria-checked"), "false");
});

test("a stored light choice does not follow the visitor onto pages with their own theme, and another tab's change is adopted", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light"); document.documentElement.setAttribute(THEME_ATTRIBUTE, "light");
  const host = await mount("/attendee"), toggle = host.querySelector<HTMLButtonElement>("button[role=switch]")!;
  assert.equal(attribute(), "dark"); assert.equal(toggle.disabled, true); assert.equal(localStorage.getItem(THEME_STORAGE_KEY), "light");
  await act(async () => root!.unmount()); root = null; document.body.replaceChildren();
  await mount("/calendar"); assert.equal(attribute(), "light");
  localStorage.setItem(THEME_STORAGE_KEY, "dark"); await act(async () => { window.dispatchEvent(new dom.window.StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" })); });
  assert.equal(attribute(), "dark");
});

test("the toggle still switches the page when storage is unavailable", async () => {
  const original = dom.window.Storage.prototype.setItem; dom.window.Storage.prototype.setItem = () => { throw new Error("QuotaExceededError"); };
  try { const host = await mount("/plan"), toggle = host.querySelector<HTMLButtonElement>("button[role=switch]")!; await act(async () => toggle.click()); assert.equal(attribute(), "light"); assert.equal(toggle.getAttribute("aria-checked"), "true"); assert.equal(localStorage.getItem(THEME_STORAGE_KEY), null); await act(async () => toggle.click()); assert.equal(attribute(), "dark"); }
  finally { dom.window.Storage.prototype.setItem = original; storeTheme("dark"); }
});

test("applyTheme is idempotent and chart colours fall back to the dark palette when styles cannot be resolved", () => {
  const element = document.createElement("html"); applyTheme("light", element); applyTheme("light", element); assert.equal(element.getAttribute(THEME_ATTRIBUTE), "light"); assert.equal(currentTheme(element), "light"); assert.equal(currentTheme(null), "dark");
  assert.deepEqual(chartPalette(null), DARK_CHART_PALETTE); assert.deepEqual(Object.keys(chartPalette()).sort(), Object.keys(DARK_CHART_PALETTE).sort());
});

// ---- colours: read the shipped stylesheet, not a copy ----
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8"), rootRule = css.match(/:root, \.stage-map, \.theme-dark \{ color-scheme: dark;[^}]*\}/)![0];
const channel = (value: number) => (value /= 255) <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const luminance = (hex: string) => { const value = hex.replace("#", ""); return 0.2126 * channel(parseInt(value.slice(0, 2), 16)) + 0.7152 * channel(parseInt(value.slice(2, 4), 16)) + 0.0722 * channel(parseInt(value.slice(4, 6), 16)); };
const ratio = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function token(name: string, theme: "light" | "dark") {
  const value = rootRule.match(new RegExp(`--${name}:([^;]+);`))![1].trim(), pair = value.match(/^light-dark\((#[0-9a-f]{6}),(#[0-9a-f]{6})\)$/);
  if (pair) return theme === "light" ? pair[1] : pair[2];
  assert.match(value, /^#[0-9a-f]{6}$/, name); return value;
}

test("one attribute switches color-scheme, which Bryntum's Svalbard theme and every light-dark() colour follow", () => {
  assert.match(css, /:root\[data-theme="light"\], :root\.b-print-root \{ color-scheme: light; \}/);
  assert.match(css, /@import '@bryntum\/gantt-enterprise\/svalbard\.css';/);
  const svalbard = readFileSync(new URL("../node_modules/@bryntum/gantt-enterprise/svalbard.css", import.meta.url), "utf8");
  assert.ok((svalbard.match(/light-dark\(/g) ?? []).length > 50); assert.doesNotMatch(svalbard, /\.b-theme-dark|\[data-theme/);
  assert.ok((css.match(/light-dark\(/g) ?? []).length > 500);
});

test("text tokens meet WCAG AA on every standard surface in both themes", () => {
  for (const theme of ["dark", "light"] as const) for (const surface of ["bg", "panel", "panel-up"]) for (const text of ["text", "muted", "subtle", "amber-text", "green-text", "blue-text", "focus", "chart-text", "chart-axis"]) {
    const value = ratio(token(text, theme), token(surface, theme)); assert.ok(value >= 4.5, `${theme}: --${text} ${token(text, theme)} on --${surface} ${token(surface, theme)} is ${value.toFixed(2)}:1`);
  }
  // Text carried by accent fills keeps AA in both themes; chart lines hold 3:1 against the chart surface.
  for (const theme of ["dark", "light"] as const) { assert.ok(ratio(token("on-accent", theme), token("amber", theme)) >= 4.5); assert.ok(ratio(token("on-accent", theme), token("green", theme)) >= 4.5); for (const line of ["chart-baseline", "chart-plan", "chart-preview", "chart-hold"]) assert.ok(ratio(token(line, theme), token("chart-surface", theme)) >= 3, `${theme} ${line}`); }
});

test("standby red stays a shape colour: it is never a text colour and has no text token", () => {
  assert.equal(token("red", "light"), "#ff3b30"); assert.equal(token("red", "dark"), "#ff3b30"); assert.doesNotMatch(rootRule, /--red-text/);
  const screen = css.replace(/@media print\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  assert.doesNotMatch(screen, /[{;]\s*color:\s*var\(--red\)/);
  assert.doesNotMatch(screen, /[{;]\s*color:\s*(?:light-dark\([^)]*)?#ff3b30/i);
  // Text beside a red shape is the body ink of the current theme.
  assert.match(css, /\.badge\.red\{color:var\(--text\);border-left:3px solid var\(--red\)/);
});
