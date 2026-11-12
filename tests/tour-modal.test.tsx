import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Modal } from "../src/components/ui";
// Import before installing window: next/dynamic remains a loading boundary in
// this suite. Installed-engine components are exercised in tour-native.test.tsx.
import { TourConsole } from "../src/components/tour/tour-console";
import { PersonalTourConsole } from "../src/components/tour/personal-tour";
import { tourUiFixture } from "./tour-ui-fixture";
import { recoveryKey } from "../src/components/tour/recovery";
import { TemplateDialog, InstantiateDialog, TourDialog } from "../src/components/tour/forms";
import { AllocationDialog, ArchiveDialog, EditionDialog, SourceAdmissionDialog, StageDialog } from "../src/components/tour/review-dialogs";
import { ComparisonDialog } from "../src/components/tour/comparison";
import type { TourClient } from "../src/components/tour/use-tour-client";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4561/tour?view=library", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "StorageEvent", "location", "history", "sessionStorage", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected && !this.closest("[hidden]") && getComputedStyle(this).display !== "none" ? [new dom.window.DOMRect(0, 0, 120, 30)] : []) as unknown as DOMRectList; };
// Layout/top-layer shims, not a claim about native dialog rendering.
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.querySelector<HTMLElement>("[autofocus], button:not([disabled]), input:not([disabled])")?.focus(); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
const { createRoot } = await import("react-dom/client");
let root: Root | null = null, container: HTMLDivElement;
const originalFetch = globalThis.fetch;
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const button = (text: string, within: ParentNode = container) => { const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === text || value.getAttribute("aria-label") === text); assert.ok(found, `Missing ${text}`); return found; };
async function click(node: HTMLElement) { await act(async () => { node.focus(); node.click(); }); }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function until(check: () => boolean) { for (let n = 0; n < 80 && !check(); n++) await flush(); assert.ok(check(), "Modal state did not settle"); }
async function mount(node: ReactNode) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); await act(async () => root!.render(node)); }
function assertFocus(target: Element | null) { assert.ok(document.activeElement === target, `Expected focus on ${target?.nodeName} ${target?.textContent?.slice(0, 50)}, got ${document.activeElement?.nodeName}`); }
async function tab(node: HTMLElement, backwards = false) {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: backwards, bubbles: true, cancelable: true });
  await act(async () => { node.focus(); node.dispatchEvent(event); if (!event.defaultPrevented) node.blur(); });
  return event;
}
async function edit(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
}
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = null; } document.body.replaceChildren(); sessionStorage.clear(); globalThis.fetch = originalFetch; history.replaceState(null, "", "/tour?view=library"); });
after(() => dom.window.close());

function ModalHarness({ dismissible = true, children }: { dismissible?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false), opener = useRef<HTMLButtonElement>(null);
  return <><button ref={opener} onClick={() => setOpen(true)}>Open review</button><input aria-label="Another destination" />{open && <Modal title="Exact review" dismissible={dismissible} onClose={() => setOpen(false)} returnFocus={() => opener.current}>{children ?? <><input aria-label="Reason" /><button>Save reviewed change</button></>}</Modal>}</>;
}

test("actual Modal contains forward Tab from its last enabled control", async () => {
  await mount(<ModalHarness />); await click(button("Open review"));
  const event = await tab(button("Save reviewed change"));
  assert.equal(event.defaultPrevented, true); assertFocus(button("Close dialog"));
});
test("actual Modal contains backward Tab from its first enabled control", async () => {
  await mount(<ModalHarness />); await click(button("Open review"));
  const event = await tab(button("Close dialog"), true);
  assert.equal(event.defaultPrevented, true); assertFocus(button("Save reviewed change"));
});
test("Tab endpoints ignore disabled, inert, hidden and collapsed-details controls", async () => {
  await mount(<ModalHarness><input aria-label="Visible reason" /><button>Last enabled</button><button disabled>Disabled</button><span hidden><button>Hidden</button></span><span style={{ display: "none" }}><button>CSS hidden</button></span><span inert><button>Inert</button></span><fieldset disabled><button>Disabled fieldset</button></fieldset><details><summary tabIndex={-1}>Closed details</summary><button>Collapsed</button></details></ModalHarness>);
  await click(button("Open review")); await tab(button("Last enabled")); assertFocus(button("Close dialog"));
  await tab(button("Close dialog"), true); assertFocus(button("Last enabled"));
});
test("a pending change to tabbable controls is evaluated on the next Tab in either direction", async () => {
  function Pending() { const [busy, setBusy] = useState(false); return <><input aria-label="Reason" /><button onClick={() => setBusy(true)}>Start pending</button><button disabled={busy}>Send reviewed change</button></>; }
  await mount(<ModalHarness><Pending /></ModalHarness>); await click(button("Open review")); await click(button("Start pending"));
  await tab(button("Start pending")); assertFocus(button("Close dialog"));
  await tab(button("Close dialog"), true); assertFocus(button("Start pending"));
});
test("Tab recovers focus from BODY while the modal remains open", async () => {
  await mount(<ModalHarness />); await click(button("Open review")); button("Close dialog").blur();
  await tab(document.body); assertFocus(button("Close dialog"));
  button("Close dialog").blur(); await tab(document.body, true); assertFocus(button("Save reviewed change"));
});
test("a nondismissible loading dialog with no enabled controls retains Tab on the dialog", async () => {
  await mount(<ModalHarness dismissible={false}><p role="status">Waiting for the original receipt</p><button disabled>Saving</button></ModalHarness>); await click(button("Open review"));
  const dialog = container.querySelector("dialog")!;
  await tab(dialog); assertFocus(dialog);
  await tab(dialog, true); assertFocus(dialog);
  await act(async () => dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
  assert.ok(container.querySelector("dialog[open]"));
});
test("Escape cancels once, retains caller ownership and returns focus to the real opener", async () => {
  await mount(<ModalHarness />); const opener = button("Open review"); await click(opener);
  const event = new Event("cancel", { bubbles: true, cancelable: true }); await act(async () => container.querySelector("dialog")!.dispatchEvent(event));
  assert.equal(event.defaultPrevented, true); assert.equal(container.querySelector("dialog"), null); assertFocus(opener);
});
test("unmounting a review does not steal deliberately moved focus from another destination", async () => {
  await mount(<ModalHarness />); await click(button("Open review"));
  const destination = document.createElement("input"); document.body.append(destination); destination.focus();
  await act(async () => root!.unmount()); root = null; assertFocus(destination);
});

test("an active-production archive refusal is absent when a different template review opens", async () => {
  const f = tourUiFixture(); let posts = 0;
  globalThis.fetch = async (_input, init) => init?.method === "POST" ? (posts++, Response.json({ code: "TOUR_ACTIVE_MEMBER", error: "Remove this show from its active tour before archiving." }, { status: 409 })) : Response.json(f.data);
  await mount(<TourConsole licenseKey="" />); await until(() => Boolean(container.querySelector(".tour-production-list article")));
  const production = [...container.querySelectorAll("article")].find(node => node.parentElement?.classList.contains("tour-production-list") && node.textContent?.includes("Denver"))!;
  await click(button(`Archive ${f.productions[0]!.name}`, production)); await edit(container.querySelector<HTMLTextAreaElement>("dialog textarea")!, "Controlled refusal reproduction");
  await click(button("Archive with history retained", container.querySelector("dialog")!)); await until(() => container.querySelector("dialog")!.textContent!.includes("Remove this show"));
  assert.match(container.textContent!, /The server rejected this instruction before saving any change/);
  await click(button("Close", container.querySelector("dialog")!));
  await click(button("Archive", container.querySelector(".tour-template-card")!));
  assert.doesNotMatch(container.querySelector("dialog")!.textContent!, /Remove this show from its active tour/);
  assert.doesNotMatch(container.textContent!, /The server rejected this instruction before saving any change/);
  assert.equal(posts, 1, "Opening the unrelated review must not send a new command");
  const newOpener = button("Archive", container.querySelector(".tour-template-card")!);
  await act(async () => container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
  assertFocus(newOpener);
});

for (const kind of ["new template", "template edition", "production edition", "blank production", "fictional production", "template instantiation", "new tour", "tour edition", "allocation", "stage", "production archive", "template archive", "source admission", "retained edition", "route alternatives"] as const) {
  test(`the actual ${kind} review contains Tab in both directions and returns on Escape`, async () => {
    const f = tourUiFixture();
    const client = { data: f.data, blocked: false, busy: null, error: null, request: async (path: string) => ({ response: Response.json({}), value: path === "/api/sources" ? { documents: [], compilations: [] } : f.template }) } as unknown as TourClient;
    function Review() {
      const [open, setOpen] = useState(false), opener = useRef<HTMLButtonElement>(null);
      const shared = { client, close: () => setOpen(false), fallback: () => opener.current };
      const dialog = kind === "new template" ? <TemplateDialog {...shared} />
        : kind === "template edition" ? <TemplateDialog value={f.template} {...shared} />
        : kind === "production edition" ? <TemplateDialog production={f.productions[0]!} {...shared} />
        : kind === "blank production" ? <InstantiateDialog {...shared} />
        : kind === "fictional production" ? <InstantiateDialog demo {...shared} />
        : kind === "template instantiation" ? <InstantiateDialog template={f.template} {...shared} />
        : kind === "new tour" ? <TourDialog data={f.data} {...shared} />
        : kind === "tour edition" ? <TourDialog tour={f.tour} data={f.data} {...shared} />
        : kind === "allocation" ? <AllocationDialog production={f.productions[0]!} tour={f.tour} {...shared} />
        : kind === "stage" ? <StageDialog production={f.productions[0]!} {...shared} />
        : kind === "production archive" ? <ArchiveDialog record={f.productions[0]!} {...shared} />
        : kind === "template archive" ? <ArchiveDialog record={f.template} {...shared} />
        : kind === "source admission" ? <SourceAdmissionDialog {...shared} />
        : kind === "retained edition" ? <EditionDialog record={f.template} data={f.data} {...shared} />
        : <ComparisonDialog tour={f.tour} productions={f.productions} {...shared} />;
      return <><button ref={opener} onClick={() => setOpen(true)}>Open concrete review</button>{open && dialog}</>;
    }
    await mount(<Review />); const opener = button("Open concrete review"); await click(opener); await flush();
    const dialog = container.querySelector("dialog")!;
    const first = button("Close dialog", dialog);
    const last = [...dialog.querySelectorAll<HTMLButtonElement>(".tour-dialog-footer button:not(:disabled)")].at(-1)!;
    assert.ok(last, `${kind} must have an enabled footer action`);
    await tab(last); assertFocus(first);
    await tab(first, true); assertFocus(last);
    await act(async () => dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
    assert.equal(container.querySelector("dialog"), null); assertFocus(opener);
  });
}

test("closing a review preserves the exact unresolved instruction and its recovery affordance", async () => {
  const f = tourUiFixture();
  globalThis.fetch = async (_input, init) => init?.method === "POST" ? Promise.reject(new TypeError("Controlled committed response loss")) : Response.json(f.data);
  await mount(<TourConsole licenseKey="" />); await until(() => Boolean(container.querySelector(".tour-template-card")));
  await click(button("Archive", container.querySelector(".tour-template-card")!)); await edit(container.querySelector<HTMLTextAreaElement>("dialog textarea")!, "Controlled unknown result");
  await click(button("Archive with history retained", container.querySelector("dialog")!)); await until(() => Boolean(sessionStorage.getItem(recoveryKey(f.data))));
  const raw = sessionStorage.getItem(recoveryKey(f.data)); await click(button("Close", container.querySelector("dialog")!));
  assert.equal(sessionStorage.getItem(recoveryKey(f.data)), raw); assert.ok(button("Check original receipt")); assert.equal(button("Retry exact instruction").disabled, true);
});

test("real personal request dialog wraps its enabled submit and preserves late completion focus guards", async () => {
  const f = tourUiFixture(), response = deferred<Response>(); history.replaceState(null, "", `/tour/crew#token=${"T".repeat(43)}`);
  let command: { commandId: string } | null = null;
  globalThis.fetch = async (_input, init) => { if (init?.method === "POST") { command = JSON.parse(String(init.body)); return response.promise; } return Response.json(f.personal); };
  await mount(<PersonalTourConsole licenseKey="" />); await until(() => Boolean(container.querySelector(".tour-personal-call-actions")));
  const opener = button("Request swap"); await click(opener);
  await edit(container.querySelector<HTMLTextAreaElement>("dialog textarea")!, "Synthetic personal request");
  const select = container.querySelector<HTMLSelectElement>("dialog select")!; await act(async () => { select.value = "priya"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click(container.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!);
  const submit = button("Send my swap request"); assert.equal(submit.disabled, false);
  await tab(submit); assertFocus(button("Close dialog"));
  await click(submit); await until(() => Boolean(command));
  const destination = container.querySelector<HTMLTextAreaElement>("dialog textarea")!; destination.focus();
  response.resolve(Response.json({ error: "Controlled review refused", code: "TOUR_STALE" }, { status: 409 }));
  await until(() => !submit.disabled); assertFocus(destination);
  await click(button("Close", container.querySelector("dialog")!)); assertFocus(opener);
  await click(opener);
  assert.doesNotMatch(container.textContent!, /The server rejected this instruction before saving any change|Controlled review refused/);
});
