import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { JUDGE_BEAT_IDS, type JudgeBeat, type JudgeBeatId, type JudgeCrewLink, type JudgeProvenance, type JudgeView } from "../src/domain/judge/contracts";
import { JudgeGuide } from "../src/components/judge/guide-overlay";
import { JudgeLandingEntry, JudgeLandingStrip } from "../src/components/judge/landing-entry";
import { JudgeDeviceBanner, useJudgeDevice } from "../src/components/judge/device-flag";
import { JUDGE_COLLAPSED_STORAGE, JUDGE_REFRESH_EVENT, safeQrSvg } from "../src/components/judge/judge-client";
import { PRODUCTION_SCOPE_HEADER } from "../src/domain/rehearsal-contracts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4105/crew", pretendToBeVisual: true });
for (const name of ["window", "document", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "StorageEvent", "location", "history", "sessionStorage", "localStorage"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
// JSDOM only: next/link schedules its viewport observer through `self`. No navigation or prefetch is exercised here.
Object.defineProperty(globalThis, "self", { configurable: true, value: dom.window });
const { createRoot } = await import("react-dom/client");

// Typed local mock of the director's contract. No server, PayPal or model request is made here.
const TENANT = "tenant-demo-1", NOTICE = "Payment outcomes in this guided demonstration are replayed controlled outcomes. No PayPal request was made.";
const cues: Record<JudgeBeatId, string> = { standby: "STANDBY", options: "OPTIONS", assistant: "ASSISTANT", commit: "COMMIT", delivery: "DELIVERY", crew: "CREW", go: "GO", headliner: "HEADLINER", wrap: "WRAP" };
const hrefs: Record<JudgeBeatId, string> = { standby: "/", options: "/recovery", assistant: "/plan", commit: "/recovery", delivery: "/execution", crew: "/crew", go: "/execution", headliner: "/execution", wrap: "/wrap" };
const step = (id: string, label: string, provenance: JudgeProvenance, done = false, detail?: string) => ({ id, label, provenance, done, ...(detail ? { detail } : {}) });
function beat(id: JudgeBeatId, current: JudgeBeatId | null, overrides: Partial<JudgeBeat> = {}): JudgeBeat {
  const order = JUDGE_BEAT_IDS.indexOf(id), at = current ? JUDGE_BEAT_IDS.indexOf(current) : JUDGE_BEAT_IDS.length;
  const status = order < at ? "done" : order === at ? "current" : "upcoming";
  return { id, cue: cues[id], title: `Title for ${id}`, summary: `Summary for ${id}.`, scenarioTime: "15:10 CST", href: hrefs[id], status, steps: [step(`${id}-1`, `Live step of ${id}`, "live", status === "done")], canAdvance: status === "current", advanceLabel: `Run ${cues[id]}`, ...overrides };
}
function view(current: JudgeBeatId | null, overrides: Partial<JudgeView> = {}, beatOverrides: Partial<Record<JudgeBeatId, Partial<JudgeBeat>>> = {}): JudgeView {
  return { version: 1, active: true, tenantId: TENANT, revision: 10, paymentNotice: NOTICE, beats: JUDGE_BEAT_IDS.map(id => beat(id, current, beatOverrides[id])), currentBeatId: current, crewLinks: [], acknowledged: null, accessExpiresAt: "2026-12-31T00:00:00.000Z", serverAt: "2026-11-14T21:10:00.000Z", ...overrides };
}
const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><path d="M0 0h7v7H0z"/></svg>';
const link = (kind: JudgeCrewLink["kind"], acknowledged = false): JudgeCrewLink => kind === "judge_phone"
  ? { kind, personId: "person-noor", personName: "Noor Haddad", role: "Front of house", url: "http://127.0.0.1:4105/crew/access?device=judge#" + "a".repeat(43), qrSvg: QR, expiresAt: "2026-11-15T03:00:00.000Z", acknowledged }
  : { kind, personId: "person-eli", personName: "Eli Brandt", role: "Stage manager", url: "http://127.0.0.1:4105/crew/access?device=controlled#" + "b".repeat(43), qrSvg: QR, expiresAt: "2026-11-15T03:00:00.000Z", acknowledged };

type Seen = { path: string; method: string; body: any; headers: Headers };
type Route = (request: Seen) => Response | Promise<Response> | undefined;
const originalFetch = globalThis.fetch; let root: Root | null = null, container: HTMLDivElement, requests: Seen[] = [], navigated: string[] = [], opened: string[][] = [];
function stubFetch(route: Route) {
  requests = [];
  globalThis.fetch = async (input, init) => {
    const request = { path: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) };
    requests.push(request); return await route(request) ?? Response.json({ error: "Unexpected request" }, { status: 500 });
  };
}
async function flush(ms = 5) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
async function until(condition: () => boolean, label = "Guide interaction did not settle") { for (let turn = 0; turn < 80 && !condition(); turn++) await flush(); assert.ok(condition(), label); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
const text = () => container.textContent ?? "";
const button = (label: string | RegExp) => { const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => typeof label === "string" ? item.textContent?.trim() === label : label.test(item.getAttribute("aria-label") ?? item.textContent ?? "")); assert.ok(found, `Missing button ${label}`); return found; };
const posts = (action: string) => requests.filter(request => request.method === "POST" && request.body?.action === action);
async function mount(route: Route, props: Partial<Parameters<typeof JudgeGuide>[0]> = {}) {
  container = document.createElement("div"); document.body.append(container); navigated = []; opened = []; stubFetch(route);
  root = createRoot(container);
  const render = (extra: Partial<Parameters<typeof JudgeGuide>[0]> = {}) => act(async () => root!.render(<JudgeGuide tenantId={TENANT} view="show" revision={10} pollMs={20} navigate={url => navigated.push(url)} openWindow={(...args) => { opened.push(args); return {}; }} {...props} {...extra} />));
  await render(); return render;
}
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = null; } document.body.replaceChildren(); sessionStorage.clear(); localStorage.clear(); globalThis.fetch = originalFetch; });
after(() => dom.window.close());

test("an ordinary rehearsal shows only the entry pill, which explains the tour and can start one", async () => {
  await mount(request => request.method === "GET" ? Response.json(view(null, { active: false, beats: [], tenantId: null, revision: null })) : Response.json(view("standby", { tenantId: "tenant-new" })));
  await until(() => requests.length === 1);
  assert.equal(requests[0].path, "/api/judge"); assert.equal(requests[0].headers.get(PRODUCTION_SCOPE_HEADER), TENANT);
  assert.equal(container.querySelectorAll("button").length, 1); assert.equal(text().trim(), "Guided tour");
  assert.equal(container.querySelector(".judge-panel"), null); assert.doesNotMatch(text(), /BEAT|Restart/);
  await click(button("Guided tour"));
  assert.match(text(), /private guided rehearsal of the fictional Night Ferries show/); assert.match(text(), /replayed and labeled; no PayPal request is made/); assert.match(text(), /This rehearsal stays saved/);
  await click(button("Start the guided tour")); await until(() => navigated.length === 1);
  assert.deepEqual(posts("start").map(request => request.body), [{ action: "start" }]); assert.deepEqual(navigated, ["/"]);
  assert.equal(JSON.parse(localStorage.getItem("opening-night:active-rehearsal")!).tenantId, "tenant-new");
});

test("every beat renders its cue, title, time, steps and a nine-beat stepper from the view", async () => {
  for (const id of JUDGE_BEAT_IDS) {
    await mount(() => Response.json(view(id)));
    await until(() => Boolean(container.querySelector(".judge-panel")));
    assert.equal(container.querySelector(".judge-cue")!.textContent, cues[id]); assert.match(text(), new RegExp(`Title for ${id}`)); assert.match(text(), new RegExp(`Summary for ${id}\\.`)); assert.match(text(), /15:10 CST/);
    assert.match(text(), new RegExp(`BEAT ${JUDGE_BEAT_IDS.indexOf(id) + 1}/9`));
    const stepper = [...container.querySelectorAll<HTMLButtonElement>(".judge-stepper button")];
    assert.equal(stepper.length, 9); assert.equal(stepper.filter(item => item.getAttribute("aria-current") === "step").length, 1);
    assert.equal(stepper.filter(item => item.classList.contains("done")).length, JUDGE_BEAT_IDS.indexOf(id)); assert.match(stepper[JUDGE_BEAT_IDS.indexOf(id)].getAttribute("aria-label")!, new RegExp(`${cues[id]}, current`));
    assert.equal(button(`Run ${cues[id]}`).disabled, false);
    const show = container.querySelector<HTMLAnchorElement>("a.judge-show-link");
    if (hrefs[id] === "/") { assert.equal(show, null); assert.match(text(), /You are on this view/); } else assert.equal(show!.getAttribute("href"), hrefs[id]);
    await act(async () => root!.unmount()); root = null; document.body.replaceChildren();
  }
});

test("provenance badges are shown per step and the fixed payment notice appears only with replay steps", async () => {
  const steps = [step("a", "Producer approval recorded", "live", true), step("b", "Supplier hold authorized", "replay", true, "$780 hold"), step("c", "Supplier confirmation", "controlled"), step("d", "Run sheet acknowledged", "judge")];
  const render = await mount(() => Response.json(view("commit", {}, { commit: { steps } })));
  await until(() => Boolean(container.querySelector(".judge-steps")));
  const rows = [...container.querySelectorAll(".judge-steps li")];
  assert.deepEqual(rows.map(row => row.querySelector(".judge-provenance")!.firstChild!.textContent), ["LIVE", "REPLAY", "CONTROLLED", "YOU"]);
  assert.deepEqual(rows.map(row => row.classList.contains("done")), [true, true, false, false]); assert.match(rows[1].textContent!, /\$780 hold/);
  assert.match(rows[1].textContent!, /No PayPal request was made/);
  assert.equal(container.querySelector(".judge-payment-notice")!.textContent, "REPLAY: A replayed, controlled payment outcome. No PayPal request was made." + NOTICE);
  await act(async () => root!.unmount()); root = null; document.body.replaceChildren();
  await mount(() => Response.json(view("standby"))); await until(() => Boolean(container.querySelector(".judge-steps")));
  assert.equal(container.querySelector(".judge-payment-notice"), null); assert.doesNotMatch(container.querySelector(".judge-panel-body > :not(details)")!.parentElement!.querySelector(".judge-steps")!.textContent!, /REPLAY/);
  void render;
});

test("advance repeats in chunks while the beat has unfinished steps, shows stored counts and refreshes the console", async () => {
  let done = 0, revision = 10; const keys: string[] = [];
  const state = () => view(done >= 3 ? "delivery" : "commit", { revision }, done >= 3 ? {} : { commit: { steps: [step("a", "Approve commitments", "live", done >= 1), step("b", "Authorize supplier hold", "replay", done >= 2, "$780 hold"), step("c", "Complete VIP refunds", "replay", done >= 3, `${done >= 2 ? 19 : 0}/38 refunds`)] } });
  let refreshes = 0; const refreshed = () => { refreshes++; }; window.addEventListener(JUDGE_REFRESH_EVENT, refreshed);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await mount(async request => {
    if (request.method === "GET") return Response.json(state());
    keys.push(request.body.idempotencyKey); assert.equal(request.body.beatId, "commit"); assert.equal(request.headers.get(PRODUCTION_SCOPE_HEADER), TENANT);
    if (done === 2) await gate;
    done++; revision++; return Response.json(state());
  });
  await until(() => Boolean(container.querySelector(".judge-panel")));
  await click(button("Run COMMIT"));
  await until(() => posts("advance").length === 3);
  // Third chunk is held open: the guide shows progress from the stored view and blocks a second run.
  assert.match(container.querySelector(".judge-progress")!.textContent!, /2\/3/); assert.match(container.querySelector(".judge-progress")!.textContent!, /Complete VIP refunds.*19\/38 refunds/);
  assert.equal(button("Run COMMIT").disabled, true); assert.equal(button(/Restart the tour/).disabled, true);
  release(); await until(() => container.querySelector(".judge-cue")!.textContent === "DELIVERY");
  assert.equal(posts("advance").length, 3); assert.equal(new Set(keys).size, 3); assert.equal(refreshes, 3);
  assert.equal(button("Run DELIVERY").disabled, false);
  window.removeEventListener(JUDGE_REFRESH_EVENT, refreshed);
});

test("an advance that makes no progress stops instead of looping", async () => {
  await mount(request => Response.json(view("options", {}, { options: { steps: [step("a", "Generate candidates", "live")] } })));
  await until(() => Boolean(container.querySelector(".judge-panel")));
  await click(button("Run OPTIONS")); await until(() => button("Run OPTIONS").disabled === false && posts("advance").length > 0); await flush(30);
  assert.equal(posts("advance").length, 2);
});

test("a failed advance shows the server message and retries an unanswered chunk under the same identity", async () => {
  let attempt = 0;
  await mount(request => {
    if (request.method === "GET") return Response.json(view("standby"));
    attempt++; if (attempt === 1) return Response.json({ error: "The engine is still computing the cascade.", code: "JUDGE_BUSY" }, { status: 503 });
    return Response.json(view("options", { revision: 11 }));
  });
  await until(() => Boolean(container.querySelector(".judge-panel")));
  await click(button("Run STANDBY")); await until(() => Boolean(container.querySelector(".judge-error")));
  assert.equal(container.querySelector(".judge-error")!.textContent, "The engine is still computing the cascade."); assert.equal(container.querySelector(".judge-error")!.getAttribute("role"), "alert");
  assert.equal(container.querySelector(".judge-cue")!.textContent, "STANDBY");
  await click(button("Run STANDBY")); await until(() => container.querySelector(".judge-cue")!.textContent === "OPTIONS");
  const sent = posts("advance"); assert.equal(sent.length, 2); assert.equal(sent[0].body.idempotencyKey, sent[1].body.idempotencyKey); assert.equal(container.querySelector(".judge-error"), null);
});

test("a failed first read stays an unobtrusive pill with the server message and a retry", async () => {
  let fail = true;
  await mount(() => fail ? Response.json({ error: "The guided tour store is unavailable." }, { status: 500 }) : Response.json(view("standby")));
  await until(() => requests.length === 1); await flush();
  assert.equal(container.querySelector(".judge-panel"), null); await click(button("Guided tour"));
  assert.match(text(), /The guided tour store is unavailable\./);
  fail = false; await click(button("Try again")); await until(() => Boolean(container.querySelector(".judge-cue")));
  assert.equal(container.querySelector(".judge-cue")!.textContent, "STANDBY");
});

test("an ended session offers a new start instead of the beats", async () => {
  await mount(request => request.method === "GET" ? Response.json({ error: "Session expired." }, { status: 401 }) : Response.json(view("standby", { tenantId: "tenant-next" })));
  await until(() => /Guided tour ended/.test(text()));
  await click(button("Guided tour ended")); assert.match(text(), /This guided session has ended\./);
  await click(button("Start the guided tour")); await until(() => navigated.length === 1); assert.equal(posts("start").length, 1);
});

test("the crew beat shows the scannable QR, the stand-in statement, the controlled-device window and a live counter", async () => {
  let acknowledged = 9, phone = false, controlled = false, revision = 10; let refreshes = 0; const refreshed = () => { refreshes++; }; window.addEventListener(JUDGE_REFRESH_EVENT, refreshed);
  const state = () => view("crew", { revision, crewLinks: [link("controlled_device", controlled), link("judge_phone", phone)], acknowledged: { current: acknowledged, required: 11 } }, { crew: { canAdvance: false, waitingOn: "Acknowledge the run sheet on both devices.", steps: [step("p", "Phone acknowledgment", "judge", phone), step("c", "Controlled device acknowledgment", "controlled", controlled)] } });
  await mount(() => Response.json(state()));
  await until(() => Boolean(container.querySelector(".judge-crew")));
  const cards = [...container.querySelectorAll<HTMLElement>(".judge-crew-card")]; assert.deepEqual(cards.map(card => card.dataset.kind), ["controlled_device", "judge_phone"]);
  cards.reverse();
  assert.ok(cards[0].querySelector(".judge-qr svg path")); assert.match(cards[0].querySelector(".judge-qr")!.getAttribute("aria-label")!, /Noor Haddad/);
  assert.match(cards[0].textContent!, /Scan with your own phone to acknowledge the run sheet as Noor Haddad\. You are standing in for this fictional crew member in your private rehearsal; the acknowledgment is real and made by you\./);
  assert.match(cards[0].textContent!, /Front of house/);
  const same = cards[0].querySelector<HTMLAnchorElement>("a.judge-text-link")!; assert.match(same.textContent!, /Open on this device instead/); assert.equal(same.target, "_blank"); assert.match(same.href, /\/crew\/access\?device=judge#a{43}$/);
  assert.match(cards[1].textContent!, /CONTROLLED DEVICE - phone-sized window on this computer, not a physical phone/); assert.equal(cards[1].querySelector(".judge-qr"), null); assert.equal(container.querySelector("iframe"), null);
  await click(button("Acknowledge on the controlled device"));
  assert.deepEqual(opened, [[link("controlled_device").url, "opening-night-controlled-device", "popup,width=390,height=844"]]);
  assert.equal(container.querySelector(".judge-ack strong")!.textContent, "9/11"); assert.match(text(), /Waiting on you\..*Acknowledge the run sheet on both devices\./);
  assert.equal([...container.querySelectorAll("button")].some(item => /^Run CREW$/.test(item.textContent ?? "")), false);
  const before = requests.length; await until(() => requests.length > before + 1, "The waiting beat is polled");
  assert.ok(requests.every(request => request.method === "GET")); assert.equal(refreshes, 0);
  acknowledged = 10; phone = true; revision = 11; await until(() => container.querySelector(".judge-ack strong")!.textContent === "10/11");
  assert.match(container.querySelector(".judge-crew-card.phone .judge-crew-status")!.textContent!, /Acknowledged as Noor Haddad/); assert.equal(refreshes, 1);
  acknowledged = 11; controlled = true; revision = 12; await until(() => container.querySelector(".judge-ack strong")!.textContent === "11/11");
  assert.match(container.querySelector(".judge-crew-card.controlled .judge-crew-status")!.textContent!, /Acknowledged as Eli Brandt/); assert.equal(refreshes, 2);
  // Both acknowledged and nothing left to wait for: the next view ends the polling.
  const settle = () => view("go", { revision: 13, acknowledged: { current: 11, required: 11 } }, { go: { canAdvance: false, steps: [step("g", "GO issued", "judge")] } });
  globalThis.fetch = async (input, init) => { requests.push({ path: String(input), method: init?.method ?? "GET", body: null, headers: new Headers(init?.headers) }); return Response.json(settle()); };
  await until(() => container.querySelector(".judge-cue")!.textContent === "GO"); const quiet = requests.length; await flush(90); assert.equal(requests.length, quiet);
  window.removeEventListener(JUDGE_REFRESH_EVENT, refreshed);
});

test("polling pauses while the document is hidden", async () => {
  await mount(() => Response.json(view("crew", { crewLinks: [link("judge_phone")], acknowledged: { current: 9, required: 11 } }, { crew: { canAdvance: false, waitingOn: "Acknowledge on your phone." } })));
  await until(() => requests.length > 2);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await flush(30); const paused = requests.length; await flush(90); assert.equal(requests.length, paused);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await until(() => requests.length > paused + 1);
});

test("a QR that is not plain SVG markup is never injected", () => {
  assert.equal(safeQrSvg('<svg onload="x()"></svg>'), null); assert.equal(safeQrSvg("<img src=x>"), null); assert.equal(safeQrSvg("<svg><script>1</script></svg>"), null);
  assert.equal(safeQrSvg(`<?xml version="1.0"?>\n${QR}`), QR);
});

test("the QR markup the server library produces for a crew link is accepted", async () => {
  const { default: QRCode } = await import("qrcode");
  const svg = await QRCode.toString(link("judge_phone").url, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  assert.equal(safeQrSvg(svg), svg.trim()); assert.match(svg, /viewBox/);
});

test("the GO beat explains the gates and offers no alternative GO or HOUSE OPEN control", async () => {
  await mount(() => Response.json(view("go", {}, { go: { canAdvance: false, waitingOn: "Press GO, then HOUSE OPEN, in the Execution view.", steps: [step("r", "Readiness gates current", "live", true, "8/8 gates"), step("g", "GO issued", "judge"), step("h", "HOUSE OPEN confirmed", "judge")] } })));
  await until(() => container.querySelector(".judge-cue")?.textContent === "GO");
  assert.match(text(), /Readiness is computed from eight gates; GO only enables when all are current\. You issue DOORS GO and confirm HOUSE OPEN yourself, through the same commands the crew use\./);
  assert.equal(container.querySelector<HTMLAnchorElement>("a.judge-show-link")!.getAttribute("href"), "/execution");
  const labels = [...container.querySelectorAll("button")].map(item => (item.getAttribute("aria-label") ?? item.textContent ?? "").trim());
  assert.deepEqual(labels.filter(label => !/^Beat \d of 9/.test(label)), ["Collapse the guided tour", "Restart the tour"]);
  assert.equal(posts("advance").length, 0);
});

test("the GO beat keeps both crew clients openable after acknowledgment, because the cues are issued there", async () => {
  await mount(() => Response.json(view("go", { crewLinks: [link("controlled_device", true), link("judge_phone", true)], acknowledged: { current: 11, required: 11 } }, { go: { canAdvance: false, waitingOn: "In the phone crew client, open Your duties and issue DOORS GO." } })));
  await until(() => Boolean(container.querySelector(".judge-crew")));
  assert.match(container.querySelector(".judge-crew-card.phone")!.textContent!, /open the crew client as Noor Haddad\. You are standing in for this fictional crew member in your private rehearsal; the cue is real and issued by you\./);
  assert.ok(container.querySelector(".judge-crew-card.phone a.judge-text-link")); assert.match(container.querySelector(".judge-crew-card.controlled")!.textContent!, /not a physical phone/);
  await click(button("Open the controlled device")); assert.equal(opened.length, 1); assert.equal(opened[0][2], "popup,width=390,height=844");
  assert.equal(container.querySelector(".judge-ack"), null); assert.equal(posts("advance").length, 0);
});

test("a beat the server reports as still working is polled and offers no second run", async () => {
  let busy = true;
  await mount(() => Response.json(view("delivery", { busy, revision: busy ? 10 : 11 }, { delivery: { canAdvance: !busy } })));
  await until(() => /This beat is still working/.test(text()));
  assert.equal([...container.querySelectorAll("button")].some(item => /^Run /.test(item.textContent ?? "")), false);
  const before = requests.length; await until(() => requests.length > before + 1); busy = false;
  await until(() => !/still working/.test(text())); assert.equal(button("Run DELIVERY").disabled, false);
});

test("the guide reads again when the console revision moves, without asking the console to refresh", async () => {
  let current: JudgeBeatId = "go", revision = 10, refreshes = 0; const refreshed = () => { refreshes++; }; window.addEventListener(JUDGE_REFRESH_EVENT, refreshed);
  const render = await mount(() => Response.json(view(current, { revision }, { go: { canAdvance: false } })));
  await until(() => container.querySelector(".judge-cue")?.textContent === "GO"); const before = requests.length;
  current = "headliner"; revision = 12; await render({ revision: 12 });
  await until(() => container.querySelector(".judge-cue")!.textContent === "HEADLINER"); assert.equal(requests.length, before + 1); assert.equal(refreshes, 0);
  window.removeEventListener(JUDGE_REFRESH_EVENT, refreshed);
});

test("restart asks for confirmation inside the panel before it calls reset", async () => {
  const original = window.confirm; let dialogs = 0; window.confirm = () => { dialogs++; return true; };
  await mount(request => request.method === "GET" ? Response.json(view("delivery")) : Response.json(view("standby", { revision: 1 })));
  await until(() => Boolean(container.querySelector(".judge-panel")));
  await click(button(/Restart the tour/)); assert.equal(posts("reset").length, 0); assert.match(text(), /Restart from the first beat\?/);
  await click(button("Keep going")); assert.doesNotMatch(text(), /Restart from the first beat\?/); assert.equal(posts("reset").length, 0);
  await click(button(/Restart the tour/)); await click(button("Restart now")); await until(() => navigated.length === 1);
  assert.deepEqual(posts("reset").map(request => request.body), [{ action: "reset" }]); assert.equal(posts("reset")[0].headers.get(PRODUCTION_SCOPE_HEADER), TENANT); assert.deepEqual(navigated, ["/"]); assert.equal(dialogs, 0);
  window.confirm = original;
});

test("Escape collapses the panel to a pill, the choice is remembered, and focus is not trapped", async () => {
  const render = await mount(() => Response.json(view("options")));
  await until(() => Boolean(container.querySelector(".judge-panel")));
  assert.equal(container.querySelector("dialog,[aria-modal]"), null); assert.equal(container.querySelector("aside")!.getAttribute("inert"), null);
  const collapse = button(/^Collapse the guided tour$/); collapse.focus();
  await act(async () => { collapse.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(container.querySelector(".judge-panel"), null); assert.equal(sessionStorage.getItem(JUDGE_COLLAPSED_STORAGE), "1");
  const pill = container.querySelector<HTMLButtonElement>(".judge-pill")!; assert.match(pill.textContent!, /Guided tour2\/9OPTIONS/); assert.equal(document.activeElement, pill);
  await act(async () => root!.unmount()); root = null; document.body.replaceChildren();
  await mount(() => Response.json(view("options"))); await until(() => Boolean(container.querySelector(".judge-pill b")));
  assert.equal(container.querySelector(".judge-panel"), null);
  await click(container.querySelector<HTMLButtonElement>(".judge-pill")!); assert.ok(container.querySelector(".judge-panel")); assert.equal(sessionStorage.getItem(JUDGE_COLLAPSED_STORAGE), "0");
  await render({ hidden: true }); assert.equal(container.innerHTML, "");
});

test("a past beat can be reviewed without an advance control, and a finished tour says so", async () => {
  await mount(() => Response.json(view("commit")));
  await until(() => Boolean(container.querySelector(".judge-panel")));
  await click(button(/^Beat 1 of 9/)); assert.equal(container.querySelector(".judge-cue")!.textContent, "STANDBY"); assert.match(text(), /This beat is done/);
  assert.equal([...container.querySelectorAll("button")].some(item => /^Run /.test(item.textContent ?? "")), false);
  await click(button("Back to the current beat")); assert.equal(container.querySelector(".judge-cue")!.textContent, "COMMIT");
  await act(async () => root!.unmount()); root = null; document.body.replaceChildren();
  await mount(() => Response.json(view(null))); await until(() => /The tour is complete/.test(text()));
  assert.match(text(), /GUIDED TOUR COMPLETE/); assert.equal([...container.querySelectorAll("button")].some(item => /^Run /.test(item.textContent ?? "")), false);
});

test("the landing entry leads with the guided tour, states what is replayed, and keeps the blank rehearsal second", async () => {
  container = document.createElement("div"); document.body.append(container); navigated = []; let blank = 0, fail = true;
  stubFetch(() => fail ? Response.json({ error: "Guided demonstrations are at capacity." }, { status: 503 }) : Response.json(view("standby", { tenantId: "tenant-landing" })));
  root = createRoot(container); await act(async () => root!.render(<><JudgeLandingEntry blankBusy={false} onBlank={() => { blank++; }} navigate={url => navigated.push(url)} /><JudgeLandingStrip /></>));
  const buttons = [...container.querySelectorAll("button")].map(item => item.textContent!.trim()); assert.deepEqual(buttons, ["Start the guided tour", "Open the blank Alder Hall rehearsal"]);
  assert.match(text(), /private guided rehearsal of the fictional Night Ferries show\. The schedule, engine, AI and crew flows run live\. PayPal outcomes inside the tour are replayed and labeled; no PayPal request is made\. It takes about five minutes\./);
  assert.match(text(), /actual PayPal sandbox requests that need your own sandbox buyer login/);
  assert.deepEqual([...container.querySelectorAll(".judge-strip strong")].map(item => item.textContent), ["STANDBY", "OPTIONS", "COMMIT", "GO"]); assert.match(text(), /What you will see/);
  await click(button("Start the guided tour")); await until(() => Boolean(container.querySelector("[role=alert]")));
  assert.match(container.querySelector("[role=alert]")!.textContent!, /Guided demonstrations are at capacity\./); assert.deepEqual(navigated, []);
  assert.equal(requests[0].path, "/api/judge"); assert.deepEqual(requests[0].body, { action: "start" }); assert.equal(requests[0].headers.get(PRODUCTION_SCOPE_HEADER), null);
  fail = false; await click(button("Start the guided tour")); await until(() => navigated.length === 1); assert.deepEqual(navigated, ["/"]);
  await click(button("Open the blank Alder Hall rehearsal")); assert.equal(blank, 0, "a tour that is starting is not raced by the blank rehearsal");
});

test("the crew client labels a guided device and never calls it a crew member's phone", async () => {
  assert.equal(renderToStaticMarkup(<JudgeDeviceBanner device={null} />), "");
  assert.match(renderToStaticMarkup(<JudgeDeviceBanner device="controlled" />), /CONTROLLED DEVICE - guided demonstration/);
  assert.match(renderToStaticMarkup(<JudgeDeviceBanner device="judge" personName="Noor Haddad" />), /JUDGE DEVICE - you are standing in for Noor Haddad/);
  function Probe({ personId }: { personId?: string }) { const device = useJudgeDevice(personId); return <JudgeDeviceBanner device={device} personName="Noor Haddad" />; }
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  history.replaceState(null, "", "/crew/access?device=judge"); await act(async () => root!.render(<Probe personId="person-noor" />));
  assert.match(text(), /JUDGE DEVICE - you are standing in for Noor Haddad/); assert.equal(container.querySelector("button"), null);
  // The flag survives a reload without the query, for the same person only.
  history.replaceState(null, "", "/crew/access"); await act(async () => root!.unmount()); root = createRoot(container); await act(async () => root!.render(<Probe personId="person-noor" />));
  assert.match(text(), /JUDGE DEVICE/);
  await act(async () => root!.unmount()); root = createRoot(container); await act(async () => root!.render(<Probe personId="person-other" />)); assert.equal(text(), "");
  history.replaceState(null, "", "/crew/access?device=phone"); await act(async () => root!.unmount()); root = createRoot(container); await act(async () => root!.render(<Probe personId="person-noor" />)); assert.match(text(), /JUDGE DEVICE/);
  history.replaceState(null, "", "/crew");
});
