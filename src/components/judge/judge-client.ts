import type { JudgeBeat, JudgeRequest, JudgeView } from "@/domain/judge/contracts";
import { productionFetch } from "../production-fetch";

/** The console re-reads `/api/show` when the guide reports a change it caused or observed. */
export const JUDGE_REFRESH_EVENT = "opening-night:judge-refresh";
export const JUDGE_COLLAPSED_STORAGE = "opening-night:judge-guide-collapsed";
export const JUDGE_ENDPOINT = "/api/judge";

/** One honest description, shared by the landing page and the in-console offer. */
export const TOUR_DESCRIPTION = "A private guided rehearsal of the fictional Night Ferries show. The schedule, engine, AI and crew flows run live. PayPal outcomes inside the tour are replayed and labeled; no PayPal request is made. It takes about five minutes.";

export class JudgeRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "JudgeRequestError"; }
}
/** The session behind this guide no longer exists; only a new start can continue. */
export const sessionEnded = (error: unknown) => error instanceof JudgeRequestError && [401, 403, 410].includes(error.status);
export const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

function isJudgeView(value: unknown): value is JudgeView {
  const view = value as JudgeView | null;
  return Boolean(view && typeof view === "object" && view.version === 1 && typeof view.active === "boolean" && Array.isArray(view.beats) && Array.isArray(view.crewLinks) && typeof view.paymentNotice === "string");
}
async function readView(response: Response): Promise<JudgeView> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new JudgeRequestError(typeof payload?.error === "string" && payload.error ? payload.error : `The guided tour is not available right now (HTTP ${response.status}).`, response.status, typeof payload?.code === "string" ? payload.code : undefined);
  if (!isJudgeView(payload)) throw new JudgeRequestError("The guided tour returned a state this page cannot read.", response.status);
  return payload;
}
/** `tenantId` binds the request to the production this tab shows; the landing page has none yet. */
export async function readJudge(tenantId: string) { return readView(await productionFetch(tenantId, JUDGE_ENDPOINT, { cache: "no-store" })); }
export async function postJudge(tenantId: string | null, request: JudgeRequest) {
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) };
  return readView(tenantId ? await productionFetch(tenantId, JUDGE_ENDPOINT, init) : await fetch(JUDGE_ENDPOINT, init));
}

export const beatProgress = (beat: JudgeBeat) => ({ done: beat.steps.filter(step => step.done).length, total: beat.steps.length });
/** Whether an advance call changed anything a judge could see for this beat. */
export function beatFingerprint(view: JudgeView | null, beatId: string) {
  return JSON.stringify([view?.revision ?? null, view?.currentBeatId ?? null, view?.acknowledged ?? null, view?.beats.find(beat => beat.id === beatId)?.steps.map(step => [step.id, step.done, step.detail ?? ""]) ?? null]);
}
/** Only same-origin-style http(s) links from the server are ever rendered as targets. */
export function safeHttpUrl(value: string) {
  try { const url = new URL(value, typeof location === "undefined" ? "http://localhost" : location.href); return url.protocol === "http:" || url.protocol === "https:" ? url.href : null; }
  catch { return null; }
}
/** The QR is server-rendered SVG. Anything that is not plain SVG markup is not injected. */
export function safeQrSvg(value: string) {
  const markup = value.trim().replace(/^<\?xml[^>]*\?>\s*/i, "");
  return /^<svg[\s>]/i.test(markup) && !/<script|<foreignObject|\son[a-z]+\s*=|javascript:/i.test(markup) ? markup : null;
}
export const pathOf = (href: string) => href.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
