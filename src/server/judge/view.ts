/** Read model of a guided demonstration. Every count is read from stored state. */
import QRCode from "qrcode";
import type { Actor, ShowSnapshot } from "@/domain/contracts";
import { isDemonstration, JUDGE_BEAT_IDS, JUDGE_PAYMENT_NOTICE, type JudgeBeat, type JudgeBeatId, type JudgeCrewLink, type JudgeView } from "@/domain/judge/contracts";
import { ownCurrentReadback } from "@/domain/crew/policy";
import { localTime } from "@/domain/time";
import { getShow, pool } from "../store";
import { acknowledgedCount, crewLinkToken, DIRECTOR_STEPS, ensureCrewLinks, readDirectorState, sheetCurrent, type DirectorState } from "./director";

const BEATS: Record<JudgeBeatId, { cue: string; title: string; summary: string; href: string; advanceLabel: string }> = {
  standby: { cue: "STANDBY", title: "Under four hours to doors", href: "/plan", advanceLabel: "Run the cascade",
    summary: "Eighty tickets are already sold when the headliner's flight slips and the lighting console fails. The scheduling engine cascades both through the plan." },
  options: { cue: "OPTIONS", title: "Three ways to save the night", href: "/recovery", advanceLabel: "Request quotes and compute options",
    summary: "Three enrolled suppliers answer a signed quote request, and the engine turns them into recovery plans. Impossible ones are rejected with a reason." },
  assistant: { cue: "ASSISTANT", title: "Ask the plan a question", href: "/plan", advanceLabel: "Continue",
    summary: "Open the AI panel on the plan and try “Put Tom on LX programming”. This step is yours: the model call is live, and the qualification rule answers it. Continue when you are ready." },
  commit: { cue: "COMMIT", title: "Approve, hold, authorize, publish", href: "/execution", advanceLabel: "Approve and commit Protect doors",
    summary: "The producer approves Protect doors. Brightline holds the console, a $780 authorization is replayed, the supplier confirms and the new run sheet is published." },
  delivery: { cue: "DELIVERY", title: "17:15 — the console arrives", href: "/execution", advanceLabel: "Skip to 17:15 and accept delivery",
    summary: "The driver's handoff is scanned and Priya accepts the console. The $480 fee capture and the 38 VIP perk refunds are replayed against their original captures." },
  crew: { cue: "CREW", title: "Eleven people must say “seen”", href: "/crew", advanceLabel: "Bring in nine crew acknowledgments",
    summary: "Nine controlled crew clients acknowledge the new calls and the lighting sign-offs are recorded. The last two acknowledgments are yours: one on a controlled device, one on your own phone." },
  go: { cue: "GO", title: "DOORS GO, then HOUSE OPEN", href: "/", advanceLabel: "Advance the scenario clock",
    summary: "Readiness is the application's own eight-gate report. The stage manager issues DOORS GO and front of house confirms HOUSE OPEN from their own crew clients — the two you opened." },
  headliner: { cue: "HEADLINER", title: "20:40 — she made it", href: "/", advanceLabel: "Skip to the headliner",
    summary: "Controlled crew clients record the support act, the headliner's check-in, quiet preparation and changeover, then call HEADLINER START as a separate cue." },
  wrap: { cue: "WRAP", title: "Bring the night to balance", href: "/wrap", advanceLabel: "Close out the night",
    summary: "After strike the console is returned, the residual $300 hold is released (replayed) and a reported hour becomes an approved payable. No payout is sent in a demonstration." },
};

function publicOrigin(requestOrigin: string) {
  const configured = process.env.VERCEL ? process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : null) : null;
  try { return new URL(configured ?? requestOrigin).origin; } catch { return new URL(requestOrigin).origin; }
}
async function crewLinks(show: ShowSnapshot, links: DirectorState["crewLinks"], requestOrigin: string): Promise<JudgeCrewLink[]> {
  const origin = publicOrigin(requestOrigin), result: JudgeCrewLink[] = [];
  for (const kind of ["controlled_device", "judge_phone"] as const) {
    const record = links[kind], person = record && show.resources.find(resource => resource.id === record.personId); if (!record || !person) continue;
    const url = `${origin}/crew/access?device=${kind === "judge_phone" ? "judge" : "controlled"}#${crewLinkToken(show.tenantId, record)}`;
    result.push({ personId: person.id, personName: person.name, role: person.role, url, qrSvg: await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 }), expiresAt: record.expiresAt, acknowledged: Boolean(sheetCurrent(show) && ownCurrentReadback(show, person.id)), kind });
  }
  return result;
}
export const inactiveJudgeView = (): JudgeView => ({ version: 1, active: false, tenantId: null, revision: null, paymentNotice: JUDGE_PAYMENT_NOTICE, beats: [], currentBeatId: null, crewLinks: [], acknowledged: null, accessExpiresAt: null, busy: false, serverAt: new Date().toISOString() });

export async function judgeView(actor: Actor | null, requestOrigin: string): Promise<JudgeView> {
  if (!actor || !actor.roles.includes("producer") || actor.personId || actor.executionId || actor.supplierId) return inactiveJudgeView();
  const show = await getShow(actor.tenantId).catch(() => null); if (!show || !isDemonstration(show)) return inactiveJudgeView();
  const stored = await readDirectorState(actor.tenantId); if (!stored) return inactiveJudgeView();
  const { state, busy } = stored, pending = DIRECTOR_STEPS.find(step => !step.done(show, state)) ?? null, currentBeatId = pending?.beat ?? null;
  const beats: JudgeBeat[] = JUDGE_BEAT_IDS.map(id => {
    const steps = DIRECTOR_STEPS.filter(step => step.beat === id), index = JUDGE_BEAT_IDS.indexOf(id), current = currentBeatId === id;
    const done = currentBeatId === null || index < JUDGE_BEAT_IDS.indexOf(currentBeatId);
    return { id, cue: BEATS[id].cue, title: BEATS[id].title, summary: BEATS[id].summary, href: BEATS[id].href, advanceLabel: BEATS[id].advanceLabel,
      scenarioTime: localTime(show.clock) + " CST", status: done ? "done" : current ? "current" : "upcoming",
      steps: steps.map(step => { const detail = step.detail?.(show, state); return { id: step.id, label: step.label, done: step.done(show, state), provenance: step.provenance, ...(detail ? { detail } : {}) }; }),
      canAdvance: current && Boolean(pending?.run) && !busy,
      ...(current && pending && !pending.run && pending.waitingOn ? { waitingOn: pending.waitingOn } : current && pending?.run && busy ? { waitingOn: `The server is working on this step: ${pending.label}${pending.detail?.(show, state) ? ` (${pending.detail(show, state)})` : ""}.` } : {}) };
  });
  // A poll writes only when a link was never issued or has expired; otherwise this is a read.
  const links = await ensureCrewLinks(actor);
  const session = (await pool.query<{ expires_at: Date }>("SELECT expires_at FROM on_sessions WHERE tenant_id=$1 AND actor->>'id'=$2 AND expires_at>now() ORDER BY expires_at DESC LIMIT 1", [actor.tenantId, actor.id])).rows[0];
  return { version: 1, active: true, tenantId: show.tenantId, revision: show.revision, paymentNotice: JUDGE_PAYMENT_NOTICE, beats, currentBeatId,
    crewLinks: await crewLinks(show, links, requestOrigin), acknowledged: sheetCurrent(show) ? { current: acknowledgedCount(show), required: show.policy.criticalCrewCount } : null,
    accessExpiresAt: session?.expires_at.toISOString() ?? null, busy, serverAt: new Date().toISOString() };
}
