/** Actual installed8 widgets and committed models. Geometry is controlled; browser acceptance stays separate. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { dom, pause, viewport } from "./presentation-dom";
import { presentationFixture } from "./presentation-fixture";
import type { PresentationCanvasProps } from "../src/components/presentation/native-canvas";
const { createRoot } = await import("react-dom/client"), { default: NativeCanvas } = await import("../src/components/presentation/native-canvas");
const { Widget } = await import("@bryntum/core-enterprise"), { Gantt, ProjectModel } = await import("@bryntum/gantt-enterprise"), { Scheduler, PresetManager } = await import("@bryntum/scheduler-enterprise");
const initialPresets = ["hourAndDay", "dayAndWeek"].map(id => ({ id, value: PresetManager.getById(id).get("useForSmoothZoom") }));
let root: Root | null = null, container: HTMLDivElement, failures: unknown[] = [], strict = false;
function props(): PresentationCanvasProps { const data = presentationFixture(); return { show: data.show, licenseKey: process.env.BRYNTUM_LICENSE_KEY!, selection: null, selectedTaskIds: [], selectedResourceIds: [], onSelect() {} }; }
async function flush() { await act(async () => { await pause(); }); }
async function until(condition: () => boolean) { for (let index = 0; index < 100 && !condition(); index++) await flush(); assert.ok(condition(), failures.map(String).join("\n") || "Native presentation did not settle"); }
async function render(input: PresentationCanvasProps) { await act(async () => root!.render(strict ? <StrictMode><NativeCanvas {...input} /></StrictMode> : <NativeCanvas {...input} />)); }
async function mount(input: PresentationCanvasProps) { container = document.createElement("div"); document.body.append(container); root = createRoot(container, { onUncaughtError: error => { failures.push(error); } }); await render(input); await until(() => Boolean(container.querySelector('[data-native-ready="true"]')) || failures.length > 0); assert.deepEqual(failures, []); }
function widgets(split = true) { const first = container.querySelector<HTMLElement>(".b-gantt"), second = container.querySelector<HTMLElement>(".b-scheduler:not(.b-gantt)"); assert.ok(second); const scheduler = Widget.fromElement(second) as InstanceType<typeof Scheduler>; assert.ok(scheduler instanceof Scheduler); const gantt = first ? Widget.fromElement(first) as InstanceType<typeof Gantt> : null; if (split) assert.ok(gantt instanceof Gantt); return { gantt, scheduler }; }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); failures = []; strict = false; assert.equal((globalThis as any).openingNightEvaluationGuard.state.networkAttemptsBlocked, 0); });
after(() => { console.log(JSON.stringify({ qualification: "actual_installed_presentation_widgets", nativeVersion: "8.0.0", browserGeometry: "pending_root", ...((globalThis as any).openingNightEvaluationGuard.state) })); dom.window.close(); });

test("Gantt and Scheduler share the real committed model and partnered time axis", async () => {
  const input = props(), original = JSON.stringify(input.show); await mount(input); const { gantt, scheduler } = widgets(); assert.ok(gantt!.project instanceof ProjectModel); assert.equal(gantt!.project, scheduler.project); assert.equal(gantt!.isPartneredWith(scheduler), true); assert.equal(scheduler.isPartneredWith(gantt!), true); assert.equal(gantt!.rowHeight, 56); assert.equal(scheduler.rowHeight, 56); assert.equal(gantt!.subGrids.locked.width, 310); assert.equal(gantt!.readOnly, true); assert.equal(scheduler.readOnly, true); assert.equal(JSON.stringify(input.show), original); assert.ok(!gantt!.features.taskEdit || gantt!.features.taskEdit.disabled); assert.ok(!scheduler.features.eventDrag || scheduler.features.eventDrag.disabled);
});
test("external canonical selection updates both real widgets without a synthetic click", async () => {
  const input = props(); await mount(input); const original = widgets(), project = original.gantt!.project;
  input.selection = { kind: "task", id: "lx-focus" }; input.selectedTaskIds = ["lx-focus"]; input.selectedResourceIds = ["priya", "tom"]; await render(input); await flush();
  const current = widgets(); assert.equal(current.gantt!.project, project); assert.deepEqual(current.gantt!.selectedRecords.map(row => String(typeof row === "object" ? row.id : row)), ["lx-focus"]); assert.deepEqual(current.scheduler.selectedEvents.map(row => String(typeof row === "object" ? row.id : row)), ["lx-focus"]); assert.deepEqual(current.scheduler.selectedRecords.map(row => String(typeof row === "object" ? row.id : row)).sort(), ["priya", "tom"]);
});
test("native task and resource selections emit exact typed current IDs", async () => {
  const input = props(), received: unknown[] = []; input.onSelect = selection => received.push(selection); await mount(input); const { gantt, scheduler } = widgets();
  await act(async () => { gantt!.selectedRecords = [gantt!.taskStore.getById("lx-focus")]; }); await flush(); assert.ok(received.some(value => JSON.stringify(value) === JSON.stringify({ kind: "task", id: "lx-focus" })));
  await act(async () => { scheduler.selectedRecords = [scheduler.resourceStore.getById("tom")]; }); await flush(); assert.ok(received.some(value => JSON.stringify(value) === JSON.stringify({ kind: "resource", id: "tom" })));
});
test("new scope and revision destroy the old model and retain no foreign native selection", async () => {
  const input = props(); input.selection = { kind: "task", id: "lx-focus" }; input.selectedTaskIds = ["lx-focus"]; await mount(input); const old = widgets(), oldProject = old.gantt!.project;
  const foreign = props(); foreign.show.id = "separate-controlled-production"; await render(foreign); await until(() => container.querySelector('[data-native-ready="true"]')?.getAttribute("data-production") === foreign.show.tenantId + ":" + foreign.show.id); const next = widgets(); assert.notEqual(next.gantt!.project, oldProject); assert.equal(oldProject.isDestroyed, true); assert.deepEqual(next.gantt!.selectedRecords, []); assert.deepEqual(next.scheduler.selectedEvents, []); assert.equal(next.gantt!.project.taskStore.getById("lx-focus")!.get("name"), foreign.show.tasks.find(row => row.id === "lx-focus")!.name);
});
test("supplier ghost arrival is a real native time-range record and creates no canonical call", async () => {
  const input = props(), offer = input.show.offers[0]!, before = JSON.stringify(input.show); input.selection = { kind: "supplier", id: offer.id }; await mount(input); const { gantt, scheduler } = widgets(); const project = gantt!.project as InstanceType<typeof ProjectModel>, count = project.taskStore.count; const range = project.timeRangeStore.getById("presentation-offer:" + offer.id) as import("@bryntum/scheduler-enterprise").TimeRangeModel; assert.ok(range); assert.equal(range.startDate.getTime(), Date.parse(offer.deliveryAt)); assert.equal(range.endDate.getTime(), range.startDate.getTime()); assert.equal(range.duration, 0); assert.ok(range.name.startsWith("PROPOSED DELIVERY")); assert.equal(scheduler.project.timeRangeStore, project.timeRangeStore); assert.match(container.textContent!, /No task, hold, delivery or approval/); assert.equal(JSON.stringify(input.show), before);
  input.selection = null; await render(input); await flush(); assert.equal(project.timeRangeStore.count, 0); assert.equal(project.taskStore.count, count);
});
test("native narrow layout uses actual150px frozen columns without changing global presets", async () => {
  viewport(320, 780); const input = props(); input.narrow = true; input.mode = "scheduler"; await mount(input); const { gantt, scheduler } = widgets(false); assert.equal(gantt, null); assert.equal(scheduler.subGrids.locked.width, 150); assert.equal(scheduler.subGrids.normal.minWidth, 100); assert.equal(scheduler.rowHeight, 56); assert.equal(typeof scheduler.viewPreset === "string" ? scheduler.viewPreset : scheduler.viewPreset.id, "opening-presentation-hours"); assert.deepEqual(["hourAndDay", "dayAndWeek"].map(id => ({ id, value: PresetManager.getById(id).get("useForSmoothZoom") })), initialPresets);
});
test("StrictMode replacement retains a live projection and immutable source arrays", async () => {
  strict = true; const input = props(), original = JSON.stringify(input.show); await mount(input); assert.equal(widgets().gantt!.project.isDestroyed, false); input.show = structuredClone(input.show); input.show.revision++; input.full = true; await render(input); await until(() => container.querySelector('[data-native-ready="true"]')?.getAttribute("data-revision") === String(input.show.revision)); assert.equal(widgets().gantt!.project.isDestroyed, false); input.show.revision--; assert.equal(JSON.stringify(input.show), original);
});
test("untrusted call, resource and supplier labels stay native text without executable elements", async () => {
  const input = props(), marker = '<img src="https://blocked.invalid/controlled-name" onerror="window.shouldNeverRun=1">'; input.show.tasks[0]!.name = marker; input.show.resources[0]!.name = marker; input.show.offers[0]!.supplier = marker; input.selection = { kind: "supplier", id: input.show.offers[0]!.id }; const original = JSON.stringify(input.show); await mount(input); assert.equal(container.querySelector('img[src="https://blocked.invalid/controlled-name"]'), null); assert.match(container.textContent!, /blocked.invalid\/controlled-name/); assert.equal((window as unknown as { shouldNeverRun?: number }).shouldNeverRun, undefined); assert.equal(JSON.stringify(input.show), original);
});
test("a resource-linked external selection never feeds a synthetic task callback back into its owner", async () => {
  const input = props(), received: unknown[] = []; input.onSelect = selection => received.push(selection); await mount(input); const data = presentationFixture(); input.selection = { kind: "resource", id: "tom" }; input.selectedTaskIds = data.show.tasks.filter(row => row.resources.includes("tom")).map(row => row.id); input.selectedResourceIds = ["tom"]; await render(input); await flush(); assert.deepEqual(received, []); assert.ok(widgets().scheduler.selectedRecords.some(row => String(typeof row === "object" ? row.id : row) === "tom"));
});
