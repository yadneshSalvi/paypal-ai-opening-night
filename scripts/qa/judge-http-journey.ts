/**
 * Drives one guided demonstration over HTTP against a running local server and
 * prints per-call timings. Usage: npx tsx scripts/qa/judge-http-journey.ts [origin] [--stop-after=<beat>] [--no-wait]
 * It plays the judge's own steps (two acknowledgments, DOORS GO, HOUSE OPEN)
 * through the ordinary crew HTTP API with the two scoped links the guide returns.
 * No provider request is made by this script; it only talks to the given origin.
 */
export {};
const origin = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:4105";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("This journey script targets a local server only");
const stopAfter = process.argv.find(value => value.startsWith("--stop-after="))?.split("=")[1] ?? null, noWait = process.argv.includes("--no-wait");
let cookie = "", tenantId = "";
type View = { active: boolean; tenantId: string | null; revision: number | null; currentBeatId: string | null; busy?: boolean; acknowledged: { current: number; required: number } | null;
  beats: { id: string; canAdvance: boolean; waitingOn?: string; steps: { id: string; done: boolean; detail?: string; provenance: string }[] }[]; crewLinks: { kind: string; url: string; personName: string; acknowledged: boolean; qrSvg: string }[] };
async function call(path: string, init: { method?: string; body?: unknown; bearer?: string } = {}) {
  const started = Date.now();
  const response = await fetch(origin + path, { method: init.method ?? "GET", headers: { Origin: origin, "Content-Type": "application/json", ...(init.bearer ? { Authorization: "Bearer " + init.bearer } : { Cookie: cookie, ...(tenantId ? { "X-Opening-Night-Production": tenantId } : {}) }) }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
  const set = response.headers.getSetCookie?.().find(value => value.includes("session=")); if (set && !init.bearer) cookie = set.split(";")[0]!;
  const json = await response.json().catch(() => null);
  return { status: response.status, json, ms: Date.now() - started };
}
const row = (label: string, ms: number, note = "") => console.log(label.padEnd(34), String(ms).padStart(6) + " ms ", note);
const summary = (view: View, beat: string) => view.beats.find(item => item.id === beat)!.steps.map(step => `${step.id}${step.done ? "✓" : "…"}${step.detail ? `(${step.detail})` : ""}`).join(" ");

const start = await call("/api/judge", { method: "POST", body: { action: "start" } });
if (start.status !== 200) throw new Error("start failed: " + JSON.stringify(start.json));
let view = start.json as View; tenantId = view.tenantId!; row("start", start.ms, "tenant ••••" + tenantId.slice(-6));
if (!noWait) for (let poll = 0; poll < 40; poll++) { // background preparation of the sold tickets
  const read = await call("/api/judge"); view = read.json as View; if (!view.busy) break; await new Promise(resolve => setTimeout(resolve, 1500));
  if (poll % 4 === 0) row("  (background) " + summary(view, "standby").slice(0, 40), read.ms);
}
const totals = new Map<string, number>();
for (let turn = 0; turn < 120; turn++) {
  view = (await call("/api/judge")).json as View; const beat = view.beats.find(item => item.id === view.currentBeatId);
  if (!beat) { console.log("demonstration complete"); break; }
  if (beat.canAdvance) {
    const result = await call("/api/judge", { method: "POST", body: { action: "advance", beatId: beat.id, idempotencyKey: crypto.randomUUID() } });
    if (result.status !== 200) { row(beat.id + " advance", result.ms, `HTTP ${result.status} ${result.json?.code}`); if (result.json?.code === "DEMONSTRATION_BUSY") { await new Promise(resolve => setTimeout(resolve, 2000)); continue; } throw new Error(JSON.stringify(result.json)); }
    totals.set(beat.id, (totals.get(beat.id) ?? 0) + result.ms); row(beat.id + " advance", result.ms, summary(result.json as View, beat.id));
    if (stopAfter === beat.id && (result.json as View).currentBeatId !== beat.id) break;
    continue;
  }
  if (view.busy) { await new Promise(resolve => setTimeout(resolve, 1500)); continue; }
  const step = beat.steps.find(item => !item.done)!, kind = ["controlled-device", "house-open"].includes(step.id) ? "controlled_device" : "judge_phone", link = view.crewLinks.find(item => item.kind === kind);
  if (!link) throw new Error("No crew link for " + step.id);
  const url = new URL(link.url), token = url.hash.slice(1); if (!url.searchParams.get("device") || !link.qrSvg.startsWith("<svg")) throw new Error("Crew link shape");
  const page = await fetch(origin + url.pathname + url.search); if (page.status !== 200) throw new Error("Crew access page " + page.status);
  const crew = await call("/api/crew", { bearer: token }); if (crew.status !== 200) throw new Error("crew read " + JSON.stringify(crew.json));
  const data = crew.json as { show: { revision: number }; sheet: { version: number; digest: string; changes: { taskId: string }[] }; review: unknown; cues: { kind: string; reportId: string; precedingCueId: string | null; available: boolean; blockers: string[] }[] };
  const kindOfCue = step.id === "doors-go" ? "DOORS_GO" : "HOUSE_OPEN", option = data.cues.find(item => item.kind === kindOfCue);
  const command = beat.id === "crew" ? { type: "acknowledge", sheetVersion: data.sheet.version, sheetDigest: data.sheet.digest, seenTaskIds: data.sheet.changes.map(change => change.taskId), offline: false }
    : { type: "cue", kind: kindOfCue, review: data.review, reportId: option!.reportId, precedingCueId: option!.precedingCueId, detail: "Performed through the judge's own scoped crew link in the HTTP journey check.", confirmed: true };
  const done = await call("/api/crew", { method: "POST", bearer: token, body: { idempotencyKey: crypto.randomUUID(), expectedRevision: data.show.revision, command } });
  row(`${step.id} via ${kind}`, done.ms, done.status === 200 ? `as ${link.personName} (${url.pathname}${url.search})` : JSON.stringify(done.json));
  if (done.status !== 200) throw new Error("judge step failed");
}
const show = (await call("/api/show")).json as { controlledQa?: boolean; demonstration?: boolean; paymentNotice?: string; show: { state: string; clock: string; revision: number; tickets: unknown[]; financialEvidence: { kind: string; purpose: string; amountMinor: number; source: string; provenance?: string }[]; crewCues?: { kind: string }[] } };
const evidence = show.show.financialEvidence, total = (kind: string, purpose: string) => evidence.filter(entry => entry.kind === kind && entry.purpose === purpose).reduce((sum, entry) => sum + entry.amountMinor, 0);
console.log(JSON.stringify({ perBeatMs: Object.fromEntries(totals), controlledQa: show.controlledQa, demonstration: show.demonstration, paymentNotice: show.paymentNotice, state: show.show.state, revision: show.show.revision,
  tickets: show.show.tickets.length, ticketCapturesMinor: total("capture", "ticket"), vipRefundsMinor: total("refund", "vip_remedy"), authorizationMinor: total("authorization", "rental"), feeMinor: total("capture", "rental"), releasedMinor: total("void", "deposit"),
  evidenceRows: evidence.length, replayRows: evidence.filter(entry => entry.provenance === "replay").length, cues: show.show.crewCues?.map(item => item.kind), acknowledged: view.acknowledged }, null, 1));
