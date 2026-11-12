/** Actual mounted React message projection. Controlled strings; no app/API/database/model requests. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { PlanningMessage } from "../src/components/intelligence/planning-message";
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true, url: "http://127.0.0.1:4606/plan" });
for (const name of ["window", "self", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const css = document.createElement("style"); css.textContent = await readFile(new URL("../src/app/intelligence.css", import.meta.url), "utf8"); document.head.append(css);
const { createRoot } = await import("react-dom/client"); let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); assert.equal((globalThis as any).openingModelPresentationGuard.counts.blocked, 0); }); after(() => dom.window.close());
async function render(text: string) { const container = document.createElement("div"); document.body.append(container); root = createRoot(container); await act(async () => root!.render(<PlanningMessage text={text} />)); return container; }
test("mounted saved-history projection has paragraphs, strong, code, list and table semantics", async () => {
  const raw = "**Proposal only.**\n\nSource `crew-policy-v1`.\n- Review source\n- Separate approval\n\n| Call | Status |\n|---|---|\n| Focus | Pending |", before = Buffer.from(raw), node = await render(raw);
  assert.equal(node.querySelector("strong")?.textContent, "Proposal only."); assert.equal(node.querySelector("code")?.textContent, "crew-policy-v1"); assert.equal(node.querySelectorAll("li").length, 2); assert.equal(node.querySelectorAll("table").length, 1); assert.deepEqual(Buffer.from(raw), before);
});
test("mounted raw provider HTML and unsafe model links stay inert visible source text", async () => { const node = await render('<img src="https://outside.invalid" onerror="bad()"> [source](javascript:bad)'); assert.equal(node.querySelector("img,script,svg,a"), null); assert.match(node.textContent!, /<img/); assert.match(node.textContent!, /javascript:bad/); });
test("changing the displayed saved response removes earlier source content without mutating it", async () => { const old = "Old source `source-v1`.", next = "**New current response**\nSource `source-v2`.", node = await render(old); await act(async () => root!.render(<PlanningMessage text={next} />)); assert.equal(node.textContent!.includes("source-v1"), false); assert.match(node.textContent!, /source-v2/); assert.equal(old, "Old source `source-v1`."); });
test("long hashes remain complete and tables own their horizontal scroll region", async () => { const hash = "a".repeat(64), node = await render("| Exact source | Digest |\n|---|---|\n| `source-v1` | `" + hash + "` |"); assert.match(node.textContent!, new RegExp(hash)); const table = node.querySelector<HTMLElement>(".opening-message-table")!; assert.equal(dom.window.getComputedStyle(table).overflowX, "auto"); assert.equal(table.tabIndex, 0); assert.equal(table.getAttribute("role"), "region"); });
