/** Synthetic display/security corpus; never contacts a model, database, provider or remote link. */
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { safePlanningMessageHtml } from "../src/components/intelligence/safe-message";
import { planningChecklistHtml, planningPopupBounds } from "../src/components/intelligence/chat-layout";
const fragment = (text: string) => JSDOM.fragment(safePlanningMessageHtml(text));
const assertSafe = (node: DocumentFragment) => {
  const allowed = new Set(["DIV", "P", "BR", "STRONG", "EM", "CODE", "PRE", "UL", "OL", "LI", "H3", "H4", "H5", "H6", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "A"]);
  for (const element of node.querySelectorAll("*")) { assert.ok(allowed.has(element.tagName), element.outerHTML); for (const attribute of element.attributes) assert.ok(!/^on|^style$/i.test(attribute.name)); if (element.tagName === "A") assert.match(element.getAttribute("href")!, /^https?:\/\//); }
};
test("paragraphs, emphasis, code and exact source references remain readable without changing input", () => {
  const raw = "**Synthetic qualification rejected**: use *Priya* only after review.\nSource `crew-policy-v1` and receipt `00000000-0000-4000-8000-000000000001`.\n\nNo assignment changed.", bytes = Buffer.from(raw), value = fragment(raw);
  assert.equal(value.querySelectorAll("p").length, 2); assert.equal(value.querySelector("strong")?.textContent, "Synthetic qualification rejected"); assert.equal(value.querySelector("em")?.textContent, "Priya"); assert.equal(value.querySelector("code")?.textContent, "crew-policy-v1"); assert.match(value.textContent!, /00000000-0000-4000-8000-000000000001/); assert.deepEqual(Buffer.from(raw), bytes);
});
test("headings, ordered and unordered lists retain permission and source words", () => {
  const value = fragment("### Separate review\n- Proposal only\n- Source `offer-sister-1` remains unknown\n\n3. Read first\n4. Explicit review\n");
  assert.equal(value.querySelector("h5")?.textContent, "Separate review"); assert.equal(value.querySelectorAll("ul li").length, 2); assert.equal(value.querySelector("ol")?.getAttribute("start"), "3"); assert.match(value.textContent!, /remains unknown/);
});
test("a forecast table has real header and cell semantics, with escaped/code pipes retained", () => {
  const value = fragment("| Item | Forecast |\n|---|---|\n| Delivery \\| source | **17:15** |\n| `a|b` | Not approved |\n");
  assert.equal(value.querySelectorAll("table").length, 1); assert.equal(value.querySelectorAll('th[scope="col"]').length, 2); assert.equal(value.querySelectorAll("tbody tr").length, 2); assert.equal(value.querySelector("td")?.textContent, "Delivery | source"); assert.equal(value.querySelector("code")?.textContent, "a|b"); assert.equal(value.querySelector(".opening-message-table")?.getAttribute("tabindex"), "0");
});
test("mismatched table rows are kept as plain text rather than losing source cells", () => {
  const raw = "| A | B |\n|---|---|\n| receipt | unapproved | extra-source |", value = fragment(raw); assert.equal(value.querySelector("table"), null); assert.equal(value.querySelector("pre")?.textContent, raw);
});
test("raw HTML and embedded image syntax remain inert visible text", () => {
  const raw = '<img src="https://outside.invalid/a" onerror="alert(1)"><svg onload=alert(1)><script>bad()</script></svg>\n![source](https://outside.invalid/image)', value = fragment(raw);
  assert.equal(value.querySelector("img,svg,script,iframe,style,object,embed,math"), null); assert.match(value.textContent!, /<img/); assert.match(value.textContent!, /!\[source\]/); assertSafe(value);
});
for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>bad</script>", "vbscript:bad", "file:///private/source", "//outside.invalid", "/api/intelligence", "https://user:password@outside.invalid", "javascript&#58;bad", "https:\\outside.invalid", "mailto:person@outside.invalid"]) test("unsafe link stays text: " + url.split(":")[0], () => { const value = fragment("[original source](" + url + ")"); assert.equal(value.querySelector("a"), null); assert.match(value.textContent!, /original source/); assertSafe(value); });
test("a safe HTTPS link keeps its label and uses a no-referrer isolated destination", () => {
  const value = fragment("[Original reference](https://example.invalid/reference?x=1&y=2)"), link = value.querySelector("a")!; assert.equal(link.textContent, "Original reference"); assert.equal(link.getAttribute("href"), "https://example.invalid/reference?x=1&y=2"); assert.equal(link.getAttribute("rel"), "noopener noreferrer"); assert.equal(link.getAttribute("target"), "_blank"); assert.equal(link.getAttribute("referrerpolicy"), "no-referrer");
});
test("fenced and unclosed code show literal content with no executable tags", () => { const value = fragment("```html\n<div onclick='bad()'>source</div>\n```\n\n~~~\nunclosed `receipt`\n"); assert.equal(value.querySelectorAll("pre code").length, 2); assert.equal(value.querySelector("div[onclick]"), null); assert.match(value.textContent!, /unclosed `receipt`/); });
test("large inputs use a complete inert fallback with no truncation", () => { const raw = "source:<tag>&`receipt`\n".repeat(11000), value = fragment(raw); assert.equal(value.querySelector("pre")?.textContent, raw); assert.equal(value.querySelectorAll("tag").length, 0); });
test("mixed adversarial delimiters never produce non-allowlisted DOM", () => { const fragments = ["<script>alert(1)</script>", "[s](javascript:bad)", "**<img onerror=bad>**", "`<svg/>`", "![x](https://x.invalid)", "[source-v1]", "[x](https://safe.invalid/\"'><img>)"]; for (let index = 0; index < 100; index++) { const raw = fragments.map((_, part) => fragments[(index * 7 + part * 3) % fragments.length]).join(index % 2 ? "\n" : " | "); assertSafe(fragment(raw)); } });
test("checklist is collapsed by default and retains exact pending and saved evidence without approval", () => {
  const plan = { goal: "Synthetic <script>goal</script>", steps: [{ id: 1, description: "Read source <img>", completed: true }, { id: 2, description: "Prepare a reviewed alternative", completed: false }] }, before = JSON.stringify(plan), node = JSDOM.fragment(planningChecklistHtml(plan));
  assert.equal(node.querySelector("details")?.hasAttribute("open"), false); assert.match(node.querySelector("summary")!.textContent!, /1\/2 saved/); assert.match(node.querySelector("summary")!.textContent!, /1 pending · not approval/); assert.equal(node.querySelectorAll("li").length, 2); assert.equal(node.querySelector("script,img"), null); assert.equal(JSON.stringify(plan), before); assert.equal(JSDOM.fragment(planningChecklistHtml(plan, true)).querySelector("details")?.open, true);
});
for (const [width, height] of [[1280, 720], [390, 844], [320, 568], [390, 300], [1024, 768]]) test("finite popup bounds fit viewport " + width + "×" + height, () => { const bounds = planningPopupBounds({ width: width!, height: height!, offsetLeft: 3, offsetTop: 9 }); for (const value of Object.values(bounds)) assert.ok(Number.isFinite(value)); assert.ok(bounds.x >= 3); assert.ok(bounds.y >= 9); assert.ok(bounds.x + bounds.width <= width! + 3); assert.ok(bounds.y + bounds.height <= height! + 9); assert.ok(bounds.height > 200); assert.ok(bounds.minHeight <= bounds.height); });
test("invalid viewport measurements fall back to finite constrained sizes", () => { const value = planningPopupBounds({ width: NaN, height: Infinity }); assert.equal(value.width, 296); assert.equal(value.height, 544); });
