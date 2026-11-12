import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { tourUiFixture } from "./tour-ui-fixture";
import { plusMinutes, zoned } from "../src/domain/tour/time";
import { canonicalCallId } from "../src/components/tour/selection";
import type { NativeTourProps } from "../src/components/tour/native-tour";

// Real installed widgets/React wrappers and engine. Only browser layout APIs are
// supplied here; real keyboard, rendering and third-zone browser QA belong to root.
process.env.TZ = "Asia/Kolkata";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:4558/tour", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "navigator", "DOMTokenList", "HTMLDocument", "Document", "Window", "ShadowRoot", "HTMLStyleElement", "CSSStyleSheet", "CSSStyleDeclaration", "Text", "Comment", "CharacterData", "HTMLImageElement", "screen", "pageXOffset", "pageYOffset", "innerWidth", "innerHeight", "devicePixelRatio", "HTMLElement", "HTMLDivElement", "HTMLInputElement", "HTMLButtonElement", "HTMLCanvasElement", "SVGElement", "Element", "Node", "NodeFilter", "DocumentFragment", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "MutationObserver", "DOMParser", "XMLSerializer", "Range", "DOMRect", "location", "history", "sessionStorage", "localStorage"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
for (const name of ["addEventListener", "removeEventListener", "dispatchEvent"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name].bind(dom.window) });
Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const media = (query: string) => ({ media: query, matches: false, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: media });
Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: media });
for (const name of ["requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name].bind(dom.window) });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: TestResizeObserver });
Object.defineProperty(globalThis, "CSS", { configurable: true, value: { supports: () => false, escape: (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`) } });
Object.defineProperty(dom.window, "CSS", { configurable: true, value: globalThis.CSS });
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const height = Number.parseFloat(this.style.height) || 400;
  const width = Number.parseFloat(this.style.width) || 1200;
  return new dom.window.DOMRect(0, 0, width, height);
};
dom.window.HTMLElement.prototype.getClientRects = function () { return (this.isConnected && !this.closest("[hidden]") ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList; };
for (const [name, dimension] of [["offsetWidth", "width"], ["clientWidth", "width"], ["offsetHeight", "height"], ["clientHeight", "height"]] as const) Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true, get() { return this.getBoundingClientRect()[dimension]; } });
dom.window.Range.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 80, 20); };
dom.window.Range.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve(), status: "loaded", check: () => true, addEventListener() {}, removeEventListener() {} } });
const license = parse(readFileSync(".env")).BRYNTUM_LICENSE_KEY ?? "";
Object.assign(globalThis, { bryntum: { licenseKey: license } });
const { createRoot } = await import("react-dom/client");
const { default: NativeTour } = await import("../src/components/tour/native-tour");
const { Widget } = await import("@bryntum/core-enterprise");
const { Gantt, ProjectModel } = await import("@bryntum/gantt-enterprise");
const { Scheduler } = await import("@bryntum/scheduler-enterprise");

let root: Root | null = null, container: HTMLDivElement, strict = false;
const errors: unknown[] = [];
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
async function until(condition: () => boolean) { for (let step = 0; step < 100 && !condition(); step++) await flush(); assert.ok(condition(), "Native component did not settle"); }
function widgets() {
  const ganttElement = container.querySelector<HTMLElement>(".b-gantt"), schedulerElement = container.querySelector<HTMLElement>(".b-scheduler:not(.b-gantt)");
  assert.ok(ganttElement && schedulerElement, "Both installed native widgets must mount");
  const gantt = Widget.fromElement(ganttElement) as InstanceType<typeof Gantt>, scheduler = Widget.fromElement(schedulerElement) as InstanceType<typeof Scheduler>;
  assert.ok(gantt instanceof Gantt); assert.ok(scheduler instanceof Scheduler);
  return { gantt, scheduler };
}
function describe(error: unknown): string { return error instanceof AggregateError ? error.errors.map(describe).join("\n") : error instanceof Error ? error.stack ?? error.message : String(error); }
async function render(props: NativeTourProps) { try { await act(async () => root!.render(strict ? <StrictMode><NativeTour {...props} /></StrictMode> : <NativeTour {...props} />)); } catch (error) { throw new Error(describe(error)); } }
async function mount(props: NativeTourProps) {
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container, { onUncaughtError: error => errors.push(error) });
  await render(props);
  await until(() => Boolean(container.querySelector('[data-native-ready="true"]')) || errors.length > 0);
  assert.deepEqual(errors, []);
}
function props(): NativeTourProps {
  const fixture = tourUiFixture();
  return { productions: fixture.productions, baseline: fixture.productions, resources: fixture.tour.resources, zone: "America/Denver", licenseKey: license, mode: "timeline", selection: { productionId: fixture.productions[0]!.id, callId: "load-in", resourceId: "tom", pinId: null }, onSelect() {} };
}
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = null; } document.body.replaceChildren(); errors.length = 0; strict = false; });
after(() => dom.window.close());

test("real mounted native projections retain live shared stores through preview, baseline, zone and mode replacement", async () => {
  const input = props(); await mount(input);
  const first = widgets(), firstProject = first.gantt.project as InstanceType<typeof ProjectModel>;
  assert.ok(Object.is(first.gantt.project, first.scheduler.project), "Widgets share the exact project instance");
  const next = structuredClone(input.productions);
  next[0]!.calls[0]!.start = plusMinutes(next[0]!.calls[0]!.start, 30);
  next[0]!.calls[0]!.end = plusMinutes(next[0]!.calls[0]!.end, 30);
  await render({ ...input, productions: next });
  await until(() => errors.length > 0 || Boolean(container.querySelector('[data-native-ready="true"]')));
  assert.deepEqual(errors, [], "A projection change must not read a destroyed project/store");
  assert.ok(firstProject.isDestroyed, "The replaced project must be released");
  const second = widgets(); assert.ok(Object.is(second.gantt.project, second.scheduler.project), "Replacement widgets share the exact project instance");
  assert.equal((second.gantt.selectedRecords[0] as { id: string } | undefined)?.id, canonicalCallId(next[0]!.id, "load-in"));
  await render({ ...input, productions: next, zone: "America/Chicago", mode: "calendar" });
  await until(() => Boolean(container.querySelector(".b-calendar")));
  assert.ok(second.gantt.isDestroyed && second.scheduler.isDestroyed);
  assert.ok(second.gantt.project == null || second.gantt.project.isDestroyed);
  const calendarWidget = Widget.fromElement(container.querySelector<HTMLElement>(".b-calendar")!) as import("@bryntum/calendar-enterprise").Calendar;
  assert.equal(calendarWidget.selectedEvents[0]?.id, canonicalCallId(next[0]!.id, "load-in"));
  const calendarProject = calendarWidget.project as import("@bryntum/calendar-enterprise").ProjectModel;
  await render({ ...input, zone: "America/Chicago", mode: "timeline" });
  await until(() => errors.length > 0 || Boolean(container.querySelector('[data-native-ready="true"]')));
  assert.deepEqual(errors, []);
  assert.ok(calendarWidget.isDestroyed && calendarProject.isDestroyed, "Calendar releases its own project after widget disposal");
});

test("native event and time-axis accessible names use the selected clock in a third-zone runtime", async () => {
  const input = props(); await mount(input); const { gantt, scheduler } = widgets();
  const id = canonicalCallId(input.productions[0]!.id, "load-in");
  const event = scheduler.eventStore.getById(id)! as import("@bryntum/gantt-enterprise").TaskModel;
  const eventLabels = [...scheduler.element.querySelectorAll('[data-event-id]')].filter(node => node.getAttribute("data-event-id") === id).map(node => node.getAttribute("aria-label")).filter(Boolean);
  assert.ok(eventLabels.length > 0, "The actual Scheduler must render the selected event label");
  for (const label of eventLabels) { assert.match(label!, /America\/Denver/); assert.match(label!, /UTC-07:00/); assert.match(label!, /2026-11-20.*10:00/); assert.match(label!, new RegExp(id)); }
  assert.equal(new Date(event.startDate).toISOString(), input.productions[0]!.calls[0]!.start.instant.replace("Z", ".000Z"));
  for (const widget of [gantt, scheduler]) {
    const header = widget.timeAxisColumn.element;
    const labelledBy = header.getAttribute("aria-labelledby");
    const label = labelledBy ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ") : header.getAttribute("aria-label");
    assert.match(label ?? "", /America\/Denver/); assert.match(label ?? "", /UTC-07:00/);
  }
});

test("Strict Mode and rapid preview replacements release widgets before their shared project", async () => {
  strict = true;
  const input = props(); await mount(input);
  const warnings: string[] = [], warn = console.warn;
  console.warn = (...values) => { warnings.push(values.join(" ")); warn(...values); };
  try {
    for (let iteration = 0; iteration < 5; iteration++) {
      const prior = widgets(), project = prior.gantt.project;
      const destroy = project.destroy.bind(project); let observedOrder = false;
      project.destroy = () => { observedOrder = prior.gantt.isDestroyed && prior.scheduler.isDestroyed; destroy(); };
      const productions = structuredClone(input.productions);
      productions[0]!.calls[0]!.start = plusMinutes(productions[0]!.calls[0]!.start, iteration * 15);
      productions[0]!.calls[0]!.end = plusMinutes(productions[0]!.calls[0]!.end, iteration * 15);
      await render({ ...input, productions, zone: iteration % 2 ? "America/Denver" : "America/Chicago" });
      await until(() => Boolean(container.querySelector('[data-native-ready="true"]')));
      assert.ok(observedOrder, "Both real widgets must already be destroyed when project cleanup runs");
      assert.ok(project.isDestroyed); assert.deepEqual(errors, []);
      const current = widgets(); assert.ok(Object.is(current.gantt.project, current.scheduler.project), "Rapid replacements share the exact project instance");
      assert.equal((current.gantt.selectedRecords[0] as { id: string } | undefined)?.id, canonicalCallId(productions[0]!.id, "load-in"));
    }
    assert.equal(warnings.filter(value => /Preset.*smooth zoom/.test(value)).length, 0);
    const current = widgets();
    assert.equal((current.gantt as unknown as { zoomOnMouseWheel: boolean }).zoomOnMouseWheel, true);
    const beforeZoom = current.gantt.tickSize;
    await act(async () => { current.gantt.zoomIn(); }); await flush();
    assert.notEqual(current.gantt.tickSize, beforeZoom, "Native zoom remains available with distinct scale presets");
    assert.equal(current.gantt.timeAxis.startDate.getTime(), current.scheduler.timeAxis.startDate.getTime(), "Partner time-axis starts stay synchronized");
    assert.equal(current.gantt.timeAxis.endDate.getTime(), current.scheduler.timeAxis.endDate.getTime(), "Partner time-axis ends stay synchronized");
    assert.equal(warnings.filter(value => /Preset.*smooth zoom/.test(value)).length, 0);
  } finally { console.warn = warn; }
});

test("an obsolete installed-engine commit cannot replace the newer projection", async () => {
  const original = ProjectModel.prototype.commitAsync;
  let held: InstanceType<typeof ProjectModel> | null = null, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  ProjectModel.prototype.commitAsync = function () {
    const result = original.call(this); held ??= this;
    return this === held ? result.then(async value => { await gate; return value; }) : result;
  };
  try {
    const input = props(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container, { onUncaughtError: error => errors.push(error) });
    await render(input); assert.ok(held); assert.equal(container.querySelector(".b-gantt"), null);
    await render({ ...input, zone: "America/Chicago" });
    await until(() => Boolean(container.querySelector('[data-native-ready="true"]')));
    const current = widgets().gantt.project;
    assert.ok((held as InstanceType<typeof ProjectModel> | null)?.isDestroyed); assert.notEqual(current, held);
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(widgets().gantt.project, current); assert.equal(widgets().gantt.timeZone, "America/Chicago");
    assert.deepEqual(errors, []);
  } finally { release(); ProjectModel.prototype.commitAsync = original; }
});

test("equal refreshed data and canonical selection changes retain the model and use the current callback", async () => {
  const input = props(); let oldCalls = 0, newCalls = 0;
  await mount({ ...input, onSelect: () => oldCalls++ });
  const before = widgets().gantt.project;
  const selection = { ...input.selection!, callId: "line-check" };
  await render({ ...input, productions: structuredClone(input.productions), baseline: structuredClone(input.baseline), resources: structuredClone(input.resources), selection, onSelect: value => { assert.equal(value.callId, "load-in"); newCalls++; } });
  assert.equal(widgets().gantt.project, before);
  assert.equal(widgets().scheduler.selectedEvents[0]?.id, canonicalCallId(input.productions[0]!.id, "line-check"));
  await act(async () => { widgets().gantt.selectedRecords = [before.eventStore.getById(canonicalCallId(input.productions[0]!.id, "load-in"))!]; });
  assert.equal(oldCalls, 0); assert.equal(newCalls, 1);
});

test("native display and accessible clocks keep exact instants through DST folds and gaps", async () => {
  assert.equal(new Date("2026-11-20T17:00:00Z").getTimezoneOffset(), -330, "The runtime must be in the independent third zone");
  const cases = [
    { start: "2026-11-01T01:30", end: "2026-11-01T01:30", startChoice: "earlier", endChoice: "later", denverStart: "2026-11-01 01:30", denverEnd: "2026-11-01 01:30", startOffset: "-06:00", endOffset: "-07:00", chicagoStart: "2026-11-01 01:30", chicagoEnd: "2026-11-01 02:30", chicagoOffset: "-06:00" },
    { start: "2026-03-08T01:30", end: "2026-03-08T03:30", startChoice: "reject", endChoice: "reject", denverStart: "2026-03-08 01:30", denverEnd: "2026-03-08 03:30", startOffset: "-07:00", endOffset: "-06:00", chicagoStart: "2026-03-08 03:30", chicagoEnd: "2026-03-08 04:30", chicagoOffset: "-05:00" },
  ] as const;
  for (const sample of cases) {
    const input = props(), production = structuredClone(input.productions[0]!);
    const call = production.calls[0]!; production.calls = [call]; production.dependencies = [];
    call.start = zoned({ local: sample.start, zone: "America/Denver", disambiguation: sample.startChoice });
    call.end = zoned({ local: sample.end, zone: "America/Denver", disambiguation: sample.endChoice });
    const id = canonicalCallId(production.id, call.id);
    for (const zone of ["America/Denver", "America/Chicago"]) {
      const next = { ...input, productions: [production], baseline: [production], zone };
      if (root) await render(next); else await mount(next);
      await until(() => Boolean(container.querySelector('[data-native-ready="true"]')));
      const { gantt, scheduler } = widgets(), event = scheduler.eventStore.getById(id)! as import("@bryntum/gantt-enterprise").TaskModel;
      const expectedStart = zone === "America/Denver" ? sample.denverStart : sample.chicagoStart;
      const expectedEnd = zone === "America/Denver" ? sample.denverEnd : sample.chicagoEnd;
      const startOffset = zone === "America/Denver" ? sample.startOffset : sample.chicagoOffset;
      const endOffset = zone === "America/Denver" ? sample.endOffset : sample.chicagoOffset;
      assert.equal(scheduler.dateHelper.format(event.startDate, "YYYY-MM-DD HH:mm"), expectedStart);
      assert.equal(scheduler.dateHelper.format(event.endDate, "YYYY-MM-DD HH:mm"), expectedEnd);
      assert.equal(new Date(event.startDate).getTime(), Date.parse(call.start.instant));
      assert.equal(new Date(event.endDate).getTime(), Date.parse(call.end.instant));
      const label = [...scheduler.element.querySelectorAll('[data-event-id]')].find(node => node.getAttribute("data-event-id") === id && node.hasAttribute("aria-label"))?.getAttribute("aria-label") ?? "";
      assert.ok(label.includes(`Display start ${expectedStart} ${zone} (UTC${startOffset})`), label);
      assert.ok(label.includes(`end ${expectedEnd} ${zone} (UTC${endOffset})`), label);
      assert.ok(label.includes("Venue Lantern Theatre")); assert.ok(label.includes(`Canonical ${id}`));
      for (const widget of [gantt, scheduler]) {
        const header = widget.timeAxisColumn.element;
        await act(async () => { header.focus(); });
        const accessible = document.getElementById(header.getAttribute("aria-labelledby")!)?.textContent ?? "";
        assert.ok(accessible.includes(zone));
        assert.ok(accessible.includes(widget.dateHelper.format(widget.visibleDateRange.startDate!, "YYYY-MM-DD HH:mm")));
      }
    }
  }
});
