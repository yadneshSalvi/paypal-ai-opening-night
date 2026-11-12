import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AssistantMessage } from "../src/components/wrap/assistant-message";

const bindings = [{ ref: "L1", lineIds: ["owned-original-entry"] }];
const render = (text: string) => new JSDOM(renderToStaticMarkup(<AssistantMessage text={text} bindings={bindings} onSources={() => {}} />)).window.document;

test("retained financial explanation keeps exact amounts while making emphasis and lists readable", () => {
  const doc = render("All amounts are **USD minor units**.\n\n- **Approved entry:** 100 approved and 100 outstanding. [L1]\n- **Cancelled claim:** 0.\n- **Collected cash:** 0.\n- **Fees:** Known fees are 0; no unknown-fee items are flagged.");
  assert.equal(doc.querySelectorAll("ul > li").length, 4);
  assert.equal(doc.querySelector("strong")?.textContent, "USD minor units");
  assert.match(doc.body.textContent ?? "", /100 approved and 100 outstanding/);
  assert.equal(doc.querySelectorAll("button[aria-label='Inspect account source L1']").length, 1);
  assert.doesNotMatch(doc.body.textContent ?? "", /\*\*/);
});

test("untrusted HTML, images, unknown references and Markdown URLs never become executable content", () => {
  const text = '<script>steal()</script> <img src=x onerror="steal()">\n\n[Open](javascript:steal()) ![receipt](https://untrusted.invalid/pixel) [L99] [L1](https://untrusted.invalid)';
  const doc = render(text);
  assert.equal(doc.querySelectorAll("script,img,a,iframe,button").length, 0);
  assert.ok(doc.body.textContent?.includes('<script>steal()</script>'));
  assert.ok(doc.body.textContent?.includes("[L99]"));
  assert.ok(doc.body.textContent?.includes("[L1](https://untrusted.invalid)"));
});

test("source buttons use only retained bindings and cannot mutate their original identity", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://127.0.0.1" });
  const names = ["window", "document", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const original = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name] });
  const selected: string[][] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<AssistantMessage text="Inspect [L1], then [L99]." bindings={bindings} onSources={ids => { selected.push([...ids]); ids.push("untrusted-new-entry"); }} />));
    const button = dom.window.document.querySelector("button")!;
    assert.equal(button.type, "button");
    assert.equal(button.getAttribute("aria-label"), "Inspect account source L1");
    await act(async () => button.click());
    assert.deepEqual(selected, [["owned-original-entry"]]);
    assert.deepEqual(bindings[0].lineIds, ["owned-original-entry"]);
    assert.equal(dom.window.document.querySelectorAll("button").length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
