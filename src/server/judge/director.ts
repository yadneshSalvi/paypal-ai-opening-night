/**
 * Guided demonstration director.
 *
 * Each beat drives the application's ordinary domain commands and services for
 * one part of the hero story inside a demonstration tenant, so every existing
 * view shows real application state afterwards. Payment-provider outcomes are
 * REPLAYED through the installed SDK on an in-process transport; no PayPal
 * request is made. People are never impersonated as real: controlled crew,
 * supplier and delivery clients are declared as controlled in their records.
 *
 * Progress is derived from stored state, so a beat can be re-advanced after a
 * timeout and resumes without repeating a completed money record.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { applyCommand, recordRescueRun, type Command } from "@/domain/commands";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import type { CrewCueKind, CrewDutyKind } from "@/domain/crew/contracts";
import { cueEarliest, currentAttestation, currentCrewReview, currentCue, dutyEarliest, ownCurrentReadback } from "@/domain/crew/policy";
import { digest } from "@/domain/hash";
import type { DemonstrationMarker, JudgeBeatId } from "@/domain/judge/contracts";
import { currentRentalExecution } from "@/domain/supplier-contracts";
import { atVenue, compareInstants, localTime } from "@/domain/time";
import { env } from "../env";
import { SESSION_ADMISSION_SCOPE } from "../session-admission";
import { insertProducerRehearsal, sessionTokenHash } from "../session-records";
import { createCrewCapability, createDeliveryCapability, createSupplierCapability, getActor, getShow, migrate, pool, transactCommand } from "../store";
import { verifyCrewRecord } from "../crew/signatures";
import { providerEgress, rememberDemonstrationTenant, withReplayScope, type ReplayScope } from "./scope";

export const TICKET_COUNT = 80, STANDARD_COUNT = 42, VIP_COUNT = 38;
export const CONTROLLED_DEVICE_PERSON = "avery", JUDGE_PHONE_PERSON = "sam";
const LEASE_SECONDS = 70, CALL_BUDGET_MS = 18_000;
const CONTROLLED_NOTE = "Guided demonstration: controlled client declaration. No real person, performed work, physical inspection or safety clearance is claimed.";

export interface CrewLinkRecord { personId: string; generation: number; expiresAt: string }
export interface DirectorState {
  version: 1;
  /** Steps whose completion is not derivable from the production snapshot. */
  marks: Record<string, string>;
  refs: { rfqId?: string; rfqRevision?: number; closeoutIntentId?: string; payee?: string };
  crewLinks: Partial<Record<"controlled_device" | "judge_phone", CrewLinkRecord>>;
  /** Completed advance requests, newest last. */
  requests: { key: string; beatId: JudgeBeatId; at: string }[];
  /** Diagnostics: provider-shaped requests answered in process, and requests this server process forwarded to the network while a step ran. */
  egress: { replayed: number; forwardedDuringSteps: number; refused: number };
}
export interface DirectorAuthority { actor: Actor; sessionHash: string }
export interface StepContext extends DirectorAuthority { origin: string; scope: ReplayScope; deadline: number; state: DirectorState; save: () => Promise<void> }
export interface DirectorStep {
  id: string; beat: JudgeBeatId; label: string; provenance: "live" | "replay" | "controlled" | "judge";
  done: (show: ShowSnapshot, state: DirectorState) => boolean;
  detail?: (show: ShowSnapshot, state: DirectorState) => string | undefined;
  /** Absent for a step only the judge can perform. */
  run?: (context: StepContext) => Promise<void>;
  waitingOn?: string;
}

const emptyState = (): DirectorState => ({ version: 1, marks: {}, refs: {}, crewLinks: {}, requests: [], egress: { replayed: 0, forwardedDuringSteps: 0, refused: 0 } });
const stableId = (tenantId: string, label: string) => { const hex = createHash("sha256").update("judge:" + tenantId + ":" + label).digest("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const ticketId = (tenantId: string, index: number) => stableId(tenantId, "ticket:" + index);
const signal = () => AbortSignal.timeout(20_000);
const pending = (message: string) => new DomainError("DEMONSTRATION_STEP_PENDING", message, 409);
function producerOnly(actor: Actor) { if (!actor.roles.includes("producer") || actor.personId || actor.executionId || actor.supplierId) throw new DomainError("PRODUCER_REQUIRED", "The guided demonstration belongs to its producer session.", 403); }

/* ---------- creation ---------- */
/** Mints a NEW demonstration rehearsal and producer session. Earlier rehearsals of this browser are kept in its saved workspace. */
export async function startDemonstration(existingToken?: string, admissionScope = SESSION_ADMISSION_SCOPE) {
  await migrate();
  const previous = await getActor(existingToken), token = randomBytes(32).toString("base64url"), client = await pool.connect();
  try {
    await client.query("BEGIN");
    const marker: DemonstrationMarker = { mode: "replay", startedAt: new Date().toISOString() };
    const created = await insertProducerRehearsal(client, token, admissionScope, marker);
    await client.query("INSERT INTO on_judge_demonstrations(tenant_id,mode,state) VALUES($1,'replay',$2)", [created.actor.tenantId, JSON.stringify(emptyState())]);
    if (previous?.roles.includes("producer") && !previous.personId && !previous.executionId && !previous.supplierId) await joinWorkspace(client, previous, created.actor, created.expiresAt);
    await client.query("COMMIT");
    rememberDemonstrationTenant(created.actor.tenantId);
    return { token, actor: created.actor, show: await getShow(created.actor.tenantId), expiresAt: created.expiresAt };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
/** Adds the new rehearsal beside the browser's earlier ones. Nothing about an earlier rehearsal's show is read for update or changed. */
async function joinWorkspace(client: PoolClient, previous: Actor, created: Actor, expiresAt: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,4105005))", [previous.id]);
  const session = (await client.query<{ actor: Actor; expires_at: Date }>("SELECT actor,expires_at FROM on_sessions WHERE tenant_id=$1 AND actor->>'id'=$2 AND expires_at>now() ORDER BY expires_at DESC LIMIT 1", [previous.tenantId, previous.id])).rows[0];
  if (!session || digest(session.actor) !== digest(previous)) return;
  let member = (await client.query<{ workspace_id: string; actor_id: string }>("SELECT workspace_id,actor_id FROM on_rehearsal_members WHERE tenant_id=$1", [previous.tenantId])).rows[0];
  if (member && member.actor_id !== previous.id) return;
  if (!member) {
    const workspaceId = randomUUID();
    await client.query("INSERT INTO on_rehearsal_workspaces(id) VALUES($1)", [workspaceId]);
    await client.query("INSERT INTO on_rehearsal_members(tenant_id,workspace_id,actor_id,actor,label,authority_expires_at) VALUES($1,$2,$3,$4,'Alder Hall rehearsal',$5)", [previous.tenantId, workspaceId, previous.id, previous, session.expires_at]);
    member = { workspace_id: workspaceId, actor_id: previous.id };
  }
  await client.query("SELECT id FROM on_rehearsal_workspaces WHERE id=$1 FOR UPDATE", [member.workspace_id]);
  await client.query("INSERT INTO on_rehearsal_members(tenant_id,workspace_id,actor_id,actor,label,authority_expires_at) VALUES($1,$2,$3,$4,'Guided demonstration',$5)", [created.tenantId, member.workspace_id, created.id, created, expiresAt]);
}

/* ---------- state ---------- */
export async function readDirectorState(tenantId: string): Promise<{ state: DirectorState; busy: boolean } | null> {
  await migrate();
  const row = (await pool.query<{ state: DirectorState; busy: boolean }>("SELECT state,(lease_until IS NOT NULL AND lease_until>clock_timestamp()) AS busy FROM on_judge_demonstrations WHERE tenant_id=$1", [tenantId])).rows[0];
  return row ? { state: { ...emptyState(), ...row.state }, busy: row.busy } : null;
}
async function saveState(tenantId: string, leaseId: string, state: DirectorState) {
  // Crew link records are written only by ensureCrewLinks; a running step never overwrites them.
  const saved = await pool.query("UPDATE on_judge_demonstrations SET state=$3::jsonb || jsonb_build_object('crewLinks', COALESCE(state->'crewLinks','{}'::jsonb)),updated_at=now() WHERE tenant_id=$1 AND lease_id=$2", [tenantId, leaseId, JSON.stringify(state)]);
  if (saved.rowCount !== 1) throw new DomainError("DEMONSTRATION_BUSY", "Another request took over this demonstration step. Its stored progress is kept.", 409);
}

/* ---------- controlled clients and small helpers ---------- */
async function command(actor: Actor, value: Command | { type: "advance"; time: string }) {
  const show = await getShow(actor.tenantId);
  return (await transactCommand(actor, randomUUID(), show.revision, value, current => applyCommand(current, actor, value as Command, undefined, verifyCrewRecord))).show;
}
async function clockTo(actor: Actor, instant: string) {
  const show = await getShow(actor.tenantId);
  if (compareInstants(show.clock, instant) < 0) await command(actor, { type: "advance", time: localTime(instant) });
}
const clockReached = (show: ShowSnapshot, instant: string) => compareInstants(show.clock, instant) >= 0;
async function supplierTransport() {
  const rpc = await import("@/app/api/enrolled-suppliers/[supplier]/rpc/route");
  return (request: Request) => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) });
}
/** A director-minted personal crew capability. Its records are attributed as a controlled client. */
async function crewClient(context: StepContext, personId: string) {
  const crew = await import("../crew/service"), token = await createCrewCapability(context.actor, personId);
  const access = await crew.requireCrewSession(new Request(context.origin + "/api/crew", { headers: { authorization: "Bearer " + token } }));
  return { crew, access, token };
}
async function acknowledge(context: StepContext, personId: string) {
  const { crew, access } = await crewClient(context, personId), data = await crew.readCrew(access);
  await crew.executeCrew(access, { idempotencyKey: randomUUID(), expectedRevision: data.show.revision, command: { type: "acknowledge", sheetVersion: data.sheet!.version, sheetDigest: data.sheet!.digest, seenTaskIds: data.sheet!.changes.map(row => row.taskId), offline: false } });
}
async function attest(context: StepContext, personId: string, kind: CrewDutyKind) {
  const earliest = dutyEarliest(await getShow(context.actor.tenantId), kind); if (earliest) await clockTo(context.actor, earliest);
  const { crew, access } = await crewClient(context, personId), data = await crew.readCrew(access), duty = data.duties.find(row => row.kind === kind);
  if (!duty?.available || !data.review) throw pending(`${kind}: ${duty?.blockers.join(" ") ?? "This duty is not assigned to the controlled client."}`);
  await crew.executeCrew(access, { idempotencyKey: randomUUID(), expectedRevision: data.show.revision, command: { type: "attest", kind, review: data.review, detail: CONTROLLED_NOTE, confirmed: true } });
}
async function cue(context: StepContext, personId: string, kind: CrewCueKind) {
  await clockTo(context.actor, cueEarliest(await getShow(context.actor.tenantId), kind));
  const { crew, access } = await crewClient(context, personId), data = await crew.readCrew(access), option = data.cues.find(row => row.kind === kind);
  if (!option?.available || !data.review) throw pending(`${kind}: ${option?.blockers.join(" ") ?? "This cue is not assigned to the controlled client."}`);
  await crew.executeCrew(access, { idempotencyKey: randomUUID(), expectedRevision: data.show.revision, command: { type: "cue", kind, review: data.review, reportId: option.reportId, precedingCueId: option.precedingCueId, detail: "Guided demonstration: controlled assigned-person cue at the labeled scenario time. No physical doors, audience or live performance is claimed.", confirmed: true } });
}
const attested = (kind: CrewDutyKind) => (show: ShowSnapshot) => Boolean(currentAttestation(show, kind, verifyCrewRecord));
const cued = (kind: CrewCueKind) => (show: ShowSnapshot) => Boolean(currentCue(show, kind, verifyCrewRecord)) || (show.crewCues ?? []).some(record => record.kind === kind);

/* ---------- replayed payments ---------- */
async function settled(context: StepContext, intentId: string, status: string) {
  if (status === "succeeded") return;
  const payments = await import("../payment-service");
  const result = await payments.reconcilePaymentIntent(context.actor.tenantId, intentId, signal(), true);
  if (result.status !== "complete") throw pending(`A replayed payment step is still recovering (${"code" in result ? result.code : "pending"}). Continue in about a minute; nothing is repeated.`);
}
/** One ticket: replayed order, explicit controlled payer input, replayed capture. Resumes from whatever is already stored. */
async function captureTicket(context: StepContext, index: number) {
  const payments = await import("../payment-service"), store = await import("../payment-store"), actor = context.actor, id = ticketId(actor.tenantId, index);
  const show = await getShow(actor.tenantId); if (show.tickets.some(ticket => ticket.id === id && ticket.captureId)) return;
  const created = await payments.handlePayment(actor, { type: "ticket_checkout", expectedRevision: show.revision, ticketId: id, tier: index < STANDARD_COUNT ? "standard" : "vip" }, context.origin);
  await settled(context, created.command.intentId, created.status);
  const root = await store.readIntent(actor.tenantId, created.command.intentId), order = (await store.ownedResources(actor.tenantId, "venue", root.id)).find(row => row.kind === "order");
  if (!order) throw pending("The replayed ticket order is still being recorded.");
  await context.scope.wire.approve(order.id); // Explicit controlled payer input, not an actual buyer.
  const captured = await payments.handlePayment(actor, { type: "complete_checkout", intentId: root.id, state: payments.callbackState(root) }, context.origin);
  await settled(context, captured.command.intentId, captured.status);
}
async function refundTicket(context: StepContext, index: number) {
  const payments = await import("../payment-service"), actor = context.actor, id = ticketId(actor.tenantId, index);
  const show = await getShow(actor.tenantId); if (show.tickets.some(ticket => ticket.id === id && ticket.refundedMinor > 0)) return;
  const refunded = await payments.handlePayment(actor, { type: "refund_perk", ticketId: id, expectedRevision: show.revision }, context.origin);
  await settled(context, refunded.command.intentId, refunded.status);
}
/** The durable recovery job of a succeeded replayed operation has nothing left to do; record that instead of waiting for the shared worker. */
async function settleJobs(tenantId: string) {
  await pool.query(`UPDATE on_jobs job SET status='complete',last_code=NULL,lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE job.tenant_id=$1 AND job.kind='payment_reconcile' AND job.status IN ('queued','waiting')
      AND EXISTS (SELECT 1 FROM paycore_operations op WHERE op.tenant_id=$1::text AND op.id=job.semantic_key AND op.status='succeeded')`, [tenantId]);
}
const captures = (show: ShowSnapshot) => show.financialEvidence.filter(entry => entry.kind === "capture" && entry.purpose === "ticket" && entry.verified && entry.status === "completed");
const refunds = (show: ShowSnapshot) => show.financialEvidence.filter(entry => entry.kind === "refund" && entry.purpose === "vip_remedy" && entry.verified && entry.status === "completed");
const rentalEvidence = (show: ShowSnapshot, kind: "authorization" | "capture" | "void") => show.financialEvidence.find(entry => entry.kind === kind && ["rental", "deposit"].includes(entry.purpose) && entry.verified && entry.status === "completed");
const execution = (show: ShowSnapshot) => currentRentalExecution(show) ?? show.rentalExecutions?.at(-1) ?? null;
const money = (minor: number) => "$" + (minor / 100).toLocaleString("en-US", { minimumFractionDigits: minor % 100 ? 2 : 0 });
const sum = (rows: { amountMinor: number }[]) => rows.reduce((total, row) => total + row.amountMinor, 0);
const criticalCrew = (show: ShowSnapshot) => show.resources.filter(person => person.kind === "person" && person.critical && !person.reserve);
export const acknowledgedCount = (show: ShowSnapshot) => sheetCurrent(show) ? criticalCrew(show).filter(person => ownCurrentReadback(show, person.id)).length : 0;
const controlledAcknowledgers = (show: ShowSnapshot) => criticalCrew(show).filter(person => person.id !== CONTROLLED_DEVICE_PERSON && person.id !== JUDGE_PHONE_PERSON);
export const sheetCurrent = (show: ShowSnapshot) => Boolean(currentCrewReview(show));
const wrapClock = (show: ShowSnapshot) => { const strike = show.tasks.find(task => task.id === "strike")?.end, floor = atVenue("23:30", show.showDate); return strike && compareInstants(strike, floor) > 0 ? strike : floor; };

/* ---------- the story ---------- */
export const DIRECTOR_STEPS: DirectorStep[] = [
  { id: "tickets", beat: "standby", label: "80 tickets sold before the incident (replayed captures)", provenance: "replay",
    done: show => captures(show).length >= TICKET_COUNT, detail: show => `${captures(show).length}/${TICKET_COUNT} · ${money(sum(captures(show)))}`,
    run: async context => { for (let index = 0; index < TICKET_COUNT && Date.now() < context.deadline; index++) await captureTicket(context, index); await settleJobs(context.actor.tenantId); } },
  { id: "incidents", beat: "standby", label: "Flight delay and console failure arrive; the engine cascades the plan", provenance: "live",
    done: show => show.incidents.length > 0, detail: show => show.incidents.length ? `${show.incidents.length} sources · ${show.tasks.filter(task => task.affected).length} affected calls` : undefined,
    run: async context => { await command(context.actor, { type: "load_incidents" }); } },

  { id: "quotes", beat: "options", label: "Three enrolled suppliers answer a signed quote request", provenance: "controlled",
    done: (_show, state) => Boolean(state.marks.quotes), detail: show => `${show.offers.filter(offer => offer.serviceQuote).length} signed quotes`,
    run: async context => {
      const rfq = await import("../supplier-rfq"), actor = context.actor;
      if (!context.state.refs.rfqId) { context.state.refs.rfqId = randomUUID(); context.state.refs.rfqRevision = (await getShow(actor.tenantId)).revision; await context.save(); }
      await rfq.beginSupplierRfq(actor, context.state.refs.rfqId, context.state.refs.rfqRevision!);
      const result = await rfq.collectSupplierRfq(actor.tenantId, context.state.refs.rfqId, signal(), await supplierTransport());
      if (result.status !== "complete") throw pending("The supplier quote request has not completed.");
      await pool.query("UPDATE on_jobs SET status='complete',last_code=NULL,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND kind='supplier_rfq' AND status IN ('queued','waiting') AND payload->>'rfqId'=$2", [actor.tenantId, context.state.refs.rfqId]);
      context.state.marks.quotes = new Date().toISOString(); await context.save();
    } },
  { id: "candidates", beat: "options", label: "The scheduling engine computes recovery options", provenance: "live",
    done: show => show.runs.length > 0, detail: show => show.runs.length ? `${show.runs.at(-1)!.candidates.length} options` : undefined,
    run: async context => {
      const show = await getShow(context.actor.tenantId), candidates = await (await import("../engine")).generateCandidates(show);
      await transactCommand(context.actor, randomUUID(), show.revision, { type: "generate" }, current => recordRescueRun(current, context.actor, candidates));
    } },

  { id: "assistant", beat: "assistant", label: "Try the planning assistant: “Put Tom on LX programming”", provenance: "judge",
    done: (_show, state) => Boolean(state.marks.assistant),
    run: async context => { context.state.marks.assistant = new Date().toISOString(); await context.save(); } },

  { id: "approve", beat: "commit", label: "Approve “Protect doors” with its required approvals", provenance: "live",
    done: show => Boolean(show.approvedPlan), detail: show => show.approvedPlan ? `plan v${show.planVersion}` : undefined,
    run: async context => {
      const show = await getShow(context.actor.tenantId), candidate = show.runs.at(-1)?.candidates.find(item => item.id.startsWith("doors-brightline"));
      if (!candidate) throw pending("The Brightline “Protect doors” option is not in the current recovery run.");
      await command(context.actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(item => item.id) });
    } },
  { id: "hold", beat: "commit", label: "Brightline places the console on hold", provenance: "controlled",
    done: show => Boolean(currentRentalExecution(show)),
    run: async context => {
      const actor = context.actor, show = await getShow(actor.tenantId), offer = show.offers.find(item => item.supplierId === "brightline");
      if (!offer?.serviceQuote || !show.approvedPlan) throw pending("The approved plan needs its signed Brightline quote.");
      await (await import("../supplier-protocol")).callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: actor.tenantId, actorId: actor.id, action: { type: "hold", quoteId: offer.serviceQuote.id, planDigest: show.approvedPlan.digest, expectedRevision: show.revision, acceptCaptureTerms: true } }, signal(), await supplierTransport());
    } },
  { id: "authorization", beat: "commit", label: "$780 rental authorization (replayed)", provenance: "replay",
    done: show => Boolean(rentalEvidence(show, "authorization")), detail: show => { const entry = rentalEvidence(show, "authorization"); return entry ? money(entry.amountMinor) : undefined; },
    run: async context => {
      const payments = await import("../payment-service"), store = await import("../payment-store"), actor = context.actor, show = await getShow(actor.tenantId);
      const checkout = await payments.handlePayment(actor, { type: "rental_checkout", expectedRevision: show.revision }, context.origin);
      await settled(context, checkout.command.intentId, checkout.status);
      const root = await store.readIntent(actor.tenantId, checkout.command.intentId), order = (await store.ownedResources(actor.tenantId, "brightline", root.id)).find(row => row.kind === "order");
      if (!order) throw pending("The replayed rental order is still being recorded.");
      await context.scope.wire.approve(order.id); // Explicit controlled payer input, not an actual buyer.
      const authorized = await payments.handlePayment(actor, { type: "complete_checkout", intentId: root.id, state: payments.callbackState(root) }, context.origin);
      await settled(context, authorized.command.intentId, authorized.status); await settleJobs(actor.tenantId);
    } },
  { id: "confirm", beat: "commit", label: "Brightline confirms the reservation", provenance: "controlled",
    done: show => ["confirmed", "delivered", "accepted", "returned"].includes(execution(show)?.state ?? ""),
    run: async context => {
      const actor = context.actor, current = currentRentalExecution(await getShow(actor.tenantId)); if (!current) throw pending("The rental hold is missing.");
      await (await import("../supplier-protocol")).callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: actor.tenantId, actorId: actor.id, action: { type: "confirm", executionId: current.id } }, signal(), await supplierTransport());
      await pool.query("UPDATE on_jobs SET status='complete',last_code=NULL,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND kind='supplier_confirm' AND status IN ('queued','waiting') AND payload->>'executionId'=$2", [actor.tenantId, current.id]);
    } },
  { id: "publish", beat: "commit", label: "Publish the new run sheet to the crew", provenance: "live",
    done: sheetCurrent, detail: show => sheetCurrent(show) ? `run sheet v${show.sheets.at(-1)!.version}` : undefined,
    run: async context => { await command(context.actor, { type: "publish" }); } },

  { id: "clock-delivery", beat: "delivery", label: "Scenario clock to 17:15", provenance: "live",
    done: show => clockReached(show, atVenue("17:15", show.showDate)), run: async context => clockTo(context.actor, atVenue("17:15", (await getShow(context.actor.tenantId)).showDate)) },
  { id: "handoff", beat: "delivery", label: "Driver handoff scanned (controlled client)", provenance: "controlled",
    done: show => ["delivered", "accepted", "returned"].includes(execution(show)?.state ?? ""),
    run: async context => {
      const delivery = await import("../delivery-service"), actor = context.actor, show = await getShow(actor.tenantId), current = currentRentalExecution(show);
      if (!current) throw pending("The confirmed rental is missing.");
      const driver = await getActor((await createDeliveryCapability(actor, "driver")).token);
      const issued = await delivery.issueDelivery(actor, current.id, randomUUID(), show.revision);
      if (!issued.token || !driver) throw pending("The handoff code could not be issued.");
      await delivery.scanDelivery(driver, issued.token, randomUUID());
    } },
  { id: "acceptance", beat: "delivery", label: "Priya accepts the console (controlled inspection)", provenance: "controlled",
    done: show => ["accepted", "returned"].includes(execution(show)?.state ?? ""),
    run: async context => {
      const delivery = await import("../delivery-service"), actor = context.actor, show = await getShow(actor.tenantId), current = currentRentalExecution(show);
      if (!current?.deliveryId) throw pending("The scanned handoff is missing.");
      const inspector = await getActor((await createDeliveryCapability(actor, "inspector")).token); if (!inspector) throw pending("The inspection client could not be opened.");
      await delivery.inspectDelivery(inspector, { executionId: current.id, deliveryId: current.deliveryId, version: current.deliveryVersion, commandId: randomUUID(), expectedRevision: show.revision, decision: "accept", condition: { report: "Guided demonstration: controlled inspection declaration for desk, power and accessories. No real physical sign-off is claimed.", powerOn: true, accessories: true, safeCondition: true } });
    } },
  { id: "fee", beat: "delivery", label: "$480 rental fee capture (replayed)", provenance: "replay",
    done: show => Boolean(rentalEvidence(show, "capture")), detail: show => { const entry = rentalEvidence(show, "capture"); return entry ? money(entry.amountMinor) : undefined; },
    run: async context => {
      const intentId = currentRentalExecution(await getShow(context.actor.tenantId))?.captureIntentId; if (!intentId) throw pending("The accepted delivery has no fee instruction yet.");
      await settled(context, intentId, "prepared"); await settleJobs(context.actor.tenantId);
    } },
  { id: "refunds", beat: "delivery", label: "38 VIP perk refunds to their original captures (replayed)", provenance: "replay",
    done: show => refunds(show).length >= VIP_COUNT, detail: show => `${refunds(show).length}/${VIP_COUNT} · ${money(sum(refunds(show)))}`,
    run: async context => { for (let index = STANDARD_COUNT; index < TICKET_COUNT && Date.now() < context.deadline; index++) await refundTicket(context, index); await settleJobs(context.actor.tenantId); } },

  { id: "readbacks", beat: "crew", label: "Nine crew acknowledge the new run sheet (controlled clients)", provenance: "controlled",
    done: show => sheetCurrent(show) && controlledAcknowledgers(show).every(person => ownCurrentReadback(show, person.id)),
    detail: show => `${sheetCurrent(show) ? controlledAcknowledgers(show).filter(person => ownCurrentReadback(show, person.id)).length : 0}/${controlledAcknowledgers(show).length}`,
    run: async context => { for (const person of controlledAcknowledgers(await getShow(context.actor.tenantId))) { if (Date.now() >= context.deadline) return; if (!ownCurrentReadback(await getShow(context.actor.tenantId), person.id)) await acknowledge(context, person.id); } } },
  { id: "focus", beat: "crew", label: "Tom signs off lighting focus (controlled client)", provenance: "controlled", done: attested("focus_signed_off"), run: context => attest(context, "tom", "focus_signed_off") },
  { id: "cues", beat: "crew", label: "Priya signs off programmed cues (controlled client)", provenance: "controlled", done: attested("cue_signed_off"), run: context => attest(context, "priya", "cue_signed_off") },
  { id: "controlled-device", beat: "crew", label: "Avery Moss acknowledges on the CONTROLLED DEVICE", provenance: "judge", waitingOn: "Open the CONTROLLED DEVICE, scroll past every changed line and acknowledge as Avery Moss.",
    done: show => sheetCurrent(show) && Boolean(ownCurrentReadback(show, CONTROLLED_DEVICE_PERSON)) },
  { id: "judge-phone", beat: "crew", label: "Sam Rivera acknowledges on your own phone", provenance: "judge", waitingOn: "Scan the code with your phone (or open the link), scroll past every changed line and acknowledge as Sam Rivera.",
    done: show => sheetCurrent(show) && Boolean(ownCurrentReadback(show, JUDGE_PHONE_PERSON)) },

  { id: "foh", beat: "go", label: "Avery signs the front-of-house contingency (controlled client)", provenance: "controlled", done: attested("foh_contingency"), run: context => attest(context, CONTROLLED_DEVICE_PERSON, "foh_contingency") },
  { id: "clock-go", beat: "go", label: "Scenario clock to the readiness call", provenance: "live",
    done: show => clockReached(show, cueEarliest(show, "DOORS_GO")), run: async context => clockTo(context.actor, cueEarliest(await getShow(context.actor.tenantId), "DOORS_GO")) },
  { id: "doors-go", beat: "go", label: "DOORS GO issued by the stage manager", provenance: "judge", waitingOn: "In Sam Rivera’s crew client (your phone), open “Your duties” and issue DOORS GO.", done: cued("DOORS_GO") },
  { id: "clock-doors", beat: "go", label: "Scenario clock to doors", provenance: "live",
    done: show => clockReached(show, cueEarliest(show, "HOUSE_OPEN")), run: async context => clockTo(context.actor, cueEarliest(await getShow(context.actor.tenantId), "HOUSE_OPEN")) },
  { id: "house-open", beat: "go", label: "HOUSE OPEN confirmed by front of house", provenance: "judge", waitingOn: "On the CONTROLLED DEVICE (Avery Moss), open “Your duties” and confirm HOUSE OPEN.", done: cued("HOUSE_OPEN") },

  { id: "support-checkin", beat: "headliner", label: "Support act checked in (controlled client)", provenance: "controlled", done: attested("support_checkin"), run: context => attest(context, "sam", "support_checkin") },
  { id: "support-ready", beat: "headliner", label: "Support line check ready (controlled client)", provenance: "controlled", done: attested("support_ready"), run: context => attest(context, "dana", "support_ready") },
  { id: "support-start", beat: "headliner", label: "SUPPORT START called (controlled client)", provenance: "controlled", done: cued("SUPPORT_START"), run: context => cue(context, "sam", "SUPPORT_START") },
  { id: "headliner-checkin", beat: "headliner", label: "Headliner checked in at 19:35 (controlled client)", provenance: "controlled", done: attested("headliner_checkin"), run: context => attest(context, "sam", "headliner_checkin") },
  { id: "quiet-prep", beat: "headliner", label: "Quiet preparation signed off (controlled client)", provenance: "controlled", done: attested("quiet_prep"), run: context => attest(context, "dana", "quiet_prep") },
  { id: "changeover", beat: "headliner", label: "Changeover complete (controlled client)", provenance: "controlled", done: attested("changeover"), run: context => attest(context, "sam", "changeover") },
  { id: "headliner-start", beat: "headliner", label: "HEADLINER START called (controlled client)", provenance: "controlled", done: cued("HEADLINER_START"), run: context => cue(context, "sam", "HEADLINER_START") },

  { id: "clock-wrap", beat: "wrap", label: "Scenario clock past strike", provenance: "live",
    done: show => clockReached(show, wrapClock(show)), run: async context => clockTo(context.actor, wrapClock(await getShow(context.actor.tenantId))) },
  { id: "return", beat: "wrap", label: "Brightline records the console returned undamaged (controlled client)", provenance: "controlled",
    done: show => Boolean(execution(show)?.returnInspection),
    run: async context => {
      const closeout = await import("../rental-closeout/service"), actor = context.actor, token = await createSupplierCapability(actor), supplier = await getActor(token);
      if (!supplier) throw pending("The supplier client could not be opened.");
      const show = await getShow(actor.tenantId), authority = { actor: supplier, sessionHash: sessionTokenHash(token) }, desk = await closeout.readCloseoutWorkspace(authority), rental = desk.rentals.find(item => item.id === execution(show)?.id);
      if (!rental) throw pending("The accepted rental is not on the supplier's return desk.");
      await closeout.executeCloseoutCommand(authority, { commandId: randomUUID(), expectedRevision: show.revision, command: { type: "record_return", executionId: rental.id, executionDigest: rental.executionDigest, previousInspectionId: rental.latestReturnId, observedAt: new Date().toISOString(), condition: "undamaged", detail: "Guided demonstration: controlled original-unit return inspection. No actual physical handoff is claimed.", confirmed: true } });
    } },
  { id: "hold-closure", beat: "wrap", label: "$300 residual hold released (replayed)", provenance: "replay",
    done: show => Boolean(rentalEvidence(show, "void")), detail: show => { const entry = rentalEvidence(show, "void"); return entry ? money(entry.amountMinor) : undefined; },
    run: async context => {
      const closeout = await import("../rental-closeout/service"), ledger = await import("../rental-closeout/store"), worker = await import("../rental-closeout/worker"), actor = context.actor, authority = { actor, sessionHash: context.sessionHash };
      if (!context.state.refs.closeoutIntentId) {
        const show = await getShow(actor.tenantId), current = execution(show); if (!current) throw pending("The returned rental is missing.");
        const preview = await closeout.previewRentalCloseout(authority, current.id, show.revision);
        if (!preview.ready) throw pending("Hold closure is not ready: " + preview.blockers.join("; "));
        const result = await closeout.executeCloseoutCommand(authority, { commandId: randomUUID(), expectedRevision: show.revision, command: { type: "approve_closeout", executionId: current.id, previewDigest: preview.digest, detail: "Guided demonstration: the producer session approved closing only the residual authorization after the accepted fee and undamaged return.", confirmed: true } });
        const grant = await ledger.readCloseoutGrant(actor.tenantId, result.receipt.recordId);
        context.state.refs.closeoutIntentId = grant.progress.intentId!; await context.save();
      }
      for (const phase of ["dispatch", "readback"] as const) {
        const result = await worker.runRentalCloseoutWork(actor.tenantId, context.state.refs.closeoutIntentId, signal(), phase);
        if (result.status !== "complete") throw pending(`The replayed hold closure is still recovering (${"code" in result ? result.code : "pending"}). Continue in about a minute; nothing is repeated.`);
      }
      await pool.query("UPDATE on_jobs SET status='complete',last_code=NULL,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND kind IN ('rental_closeout_dispatch','rental_closeout_readback') AND status IN ('queued','waiting') AND payload->>'intentId'=$2", [actor.tenantId, context.state.refs.closeoutIntentId]);
      await settleJobs(actor.tenantId);
    } },
  { id: "payable", beat: "wrap", label: "Priya’s reported hour becomes an approved payable (controlled report)", provenance: "controlled",
    done: (_show, state) => Boolean(state.marks.payable), detail: (_show, state) => state.marks.payable ? "$35 payable · payout not sent" : undefined,
    run: async context => {
      const settlement = await import("../settlement/service"), actor = context.actor, payee = "priya", production = { actor, sessionHash: context.sessionHash, scope: "production" as const };
      const act = async (access: typeof production | { actor: Actor; sessionHash: string; scope: "personal" }, value: Record<string, unknown>) => { const data = await settlement.readSettlement(access); return settlement.executeSettlement(access, { idempotencyKey: randomUUID(), expectedRevision: data.revision, expectedShowRevision: data.productionRevision, command: value } as never); };
      type Money = { people?: { person: { id: string }; rates?: unknown[]; reports?: { preview?: { reportId: string; rateId: string; digest: string } | null; payable?: unknown }[] }[] };
      const person = async () => ((await settlement.readSettlement(production)) as unknown as Money).people?.find(row => row.person.id === payee);
      if (!(await person())?.rates?.length) await act(production, { type: "approve_rate", personId: payee, previousRateId: null, effectiveFrom: (await getShow(actor.tenantId)).showDate, currency: "USD", hourlyMinor: 3500, overtimeHourlyMinor: 5250, regularMinutes: 480, agreement: "Guided demonstration: explicit controlled rate agreement, not an actual employment contract.", confirmed: true });
      if (!(await person())?.reports?.length) {
        const { access, token } = await crewClient(context, payee), show = await getShow(actor.tenantId), sheet = show.sheets.at(-1)!;
        await act({ actor: access.actor, sessionHash: sessionTokenHash(token), scope: "personal" }, { type: "report_time", serviceDay: show.showDate, replacesId: null, sheetVersion: sheet.version, sheetDigest: sheet.digest, intervals: [{ start: atVenue("17:30", show.showDate), end: atVenue("18:30", show.showDate), unpaidMinutes: 0 }], detail: "Guided demonstration: controlled person-reported one-hour interval. Not derived from the schedule and not actual work.", confirmed: true });
      }
      const review = (await person())?.reports?.[0]?.preview;
      if (review) await act(production, { type: "approve_payable", reportId: review.reportId, rateId: review.rateId, reviewDigest: review.digest, detail: "Guided demonstration: the producer session reviewed this exact controlled report, rate and payable.", reviewedHours: true, reviewedRate: true, reviewedAdjustment: true });
      context.state.marks.payable = new Date().toISOString(); await context.save();
    } },
];

/* ---------- advancing ---------- */
export function currentBeat(show: ShowSnapshot, state: DirectorState): JudgeBeatId | null { return DIRECTOR_STEPS.find(step => !step.done(show, state))?.beat ?? null; }
export function nextStep(show: ShowSnapshot, state: DirectorState) { return DIRECTOR_STEPS.find(step => !step.done(show, state)) ?? null; }

/** Replayed orders still carry the application's configured return address; an unlisted request host falls back to the configured one. */
async function returnOrigin(origin: string) {
  const { checkoutOrigin } = await import("../payment-service");
  for (const candidate of [origin, process.env.APP_BASE_URL, process.env.NEXT_PUBLIC_APP_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL && "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL]) { if (candidate) try { return checkoutOrigin(candidate); } catch { /* try the next configured origin */ } }
  return origin;
}
export interface AdvanceResult { replayed: boolean; ranSteps: string[]; elapsedMs: number }
/**
 * Runs the current beat's pending director steps within one bounded call.
 * `hooks.beforeStep` exists for fault-injection tests only.
 */
/** After `start` responds, the sold tickets are prepared in the background so the first beat does not wait on them. The cascade itself is never run here. */
export async function prepareSoldTickets(authority: DirectorAuthority, origin: string) {
  try { await advanceDemonstration(authority, "standby", "prepare-tickets:" + randomUUID(), origin, { onlySteps: ["tickets"], budgetMs: 40_000 }); }
  catch (error) { if (!(error instanceof DomainError)) console.error("Guided demonstration ticket preparation paused", error instanceof Error ? error.name : "Unknown error"); }
}
export async function advanceDemonstration(authority: DirectorAuthority, beatId: JudgeBeatId, idempotencyKey: string, origin: string, hooks: { beforeStep?: (stepId: string) => Promise<void> | void; budgetMs?: number; onlySteps?: readonly string[] } = {}): Promise<AdvanceResult> {
  producerOnly(authority.actor); const tenantId = authority.actor.tenantId, started = Date.now(); origin = await returnOrigin(origin);
  const stored = await readDirectorState(tenantId); if (!stored) throw new DomainError("DEMONSTRATION_REQUIRED", "This rehearsal is not a guided demonstration.", 409);
  if (stored.state.requests.some(request => request.key === idempotencyKey)) {
    if (!stored.state.requests.some(request => request.key === idempotencyKey && request.beatId === beatId)) throw new DomainError("IDEMPOTENCY_CONFLICT", "This request key was already used for a different beat.", 409);
    return { replayed: true, ranSteps: [], elapsedMs: 0 };
  }
  const leaseId = randomUUID();
  const lease = await pool.query<{ state: DirectorState }>(`UPDATE on_judge_demonstrations SET lease_id=$2,lease_until=clock_timestamp()+($3*interval '1 second'),updated_at=now()
    WHERE tenant_id=$1 AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING state`, [tenantId, leaseId, LEASE_SECONDS]);
  if (!lease.rows[0]) throw new DomainError("DEMONSTRATION_BUSY", "The previous step of this demonstration is still running. Its progress is kept; continue in a moment.", 409);
  const state: DirectorState = { ...emptyState(), ...lease.rows[0].state }, ranSteps: string[] = [];
  try {
    if (state.requests.some(request => request.key === idempotencyKey)) return { replayed: true, ranSteps, elapsedMs: 0 };
    if (currentBeat(await getShow(tenantId), state) !== beatId) throw new DomainError("DEMONSTRATION_BEAT_CHANGED", "This is not the demonstration's current beat. Refresh the guide.", 409);
    const before = { ...providerEgress };
    try {
      await withReplayScope(tenantId, async scope => {
        const context: StepContext = { ...authority, origin, scope, deadline: started + (hooks.budgetMs ?? CALL_BUDGET_MS), state, save: () => saveState(tenantId, leaseId, state) };
        for (const step of DIRECTOR_STEPS.filter(item => item.beat === beatId && (!hooks.onlySteps || hooks.onlySteps.includes(item.id)))) {
          let show = await getShow(tenantId);
          while (!step.done(show, state)) {
            if (!step.run || Date.now() >= context.deadline) return;
            await hooks.beforeStep?.(step.id);
            await step.run(context); ranSteps.push(step.id);
            show = await getShow(tenantId);
            if (!step.done(show, state) && Date.now() < context.deadline && !["tickets", "refunds", "readbacks"].includes(step.id)) throw pending(`“${step.label}” did not complete. Stored progress is kept; continue to retry it.`);
          }
        }
      });
      state.requests = [...state.requests, { key: idempotencyKey, beatId, at: new Date().toISOString() }].slice(-60);
    } finally {
      state.egress = { replayed: state.egress.replayed + providerEgress.replayed - before.replayed, forwardedDuringSteps: state.egress.forwardedDuringSteps + providerEgress.forwarded - before.forwarded, refused: state.egress.refused + providerEgress.refused - before.refused };
      await saveState(tenantId, leaseId, state).catch(() => undefined);
    }
    await ensureCrewLinks(authority.actor);
    return { replayed: false, ranSteps, elapsedMs: Date.now() - started };
  } finally {
    await pool.query("UPDATE on_judge_demonstrations SET lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND lease_id=$2", [tenantId, leaseId]);
  }
}

/* ---------- the two personal crew links ---------- */
const linkToken = (tenantId: string, personId: string, generation: number) => createHmac("sha256", env.sessionSecret).update(`judge-crew-link:${tenantId}:${personId}:${generation}`).digest("base64url");
export function crewLinkToken(tenantId: string, record: CrewLinkRecord) { return linkToken(tenantId, record.personId, record.generation); }
const linkNeeded = (show: ShowSnapshot, state: DirectorState) => { const step = DIRECTOR_STEPS.find(item => item.id === "cues")!; return sheetCurrent(show) && step.done(show, state); };
/**
 * Issues the two scoped crew capabilities once the nine controlled readbacks
 * and sign-offs are recorded, and replaces one only after it expired. A poll
 * that finds both current writes nothing.
 */
export async function ensureCrewLinks(actor: Actor): Promise<DirectorState["crewLinks"]> {
  producerOnly(actor);
  const stored = await readDirectorState(actor.tenantId); if (!stored) return {};
  const show = await getShow(actor.tenantId); if (!linkNeeded(show, stored.state)) return stored.state.crewLinks;
  const wanted = [["controlled_device", CONTROLLED_DEVICE_PERSON], ["judge_phone", JUDGE_PHONE_PERSON]] as const;
  const current = (record?: CrewLinkRecord) => Boolean(record && Date.parse(record.expiresAt) - Date.now() > 60_000);
  if (wanted.every(([kind]) => current(stored.state.crewLinks[kind]))) return stored.state.crewLinks;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = (await client.query<{ state: DirectorState }>("SELECT state FROM on_judge_demonstrations WHERE tenant_id=$1 FOR UPDATE", [actor.tenantId])).rows[0]!;
    const links = { ...(locked.state.crewLinks ?? {}) }; let changed = false;
    for (const [kind, personId] of wanted) {
      if (current(links[kind])) continue;
      const generation = (links[kind]?.generation ?? 0) + 1, token = linkToken(actor.tenantId, personId, generation);
      // A capability inserted by an attempt whose record was not saved is the same capability; it is not extended.
      try { await createCrewCapability(actor, personId, token); } catch (error) { if ((error as { code?: string }).code !== "23505") throw error; }
      const expiry = (await pool.query<{ expires_at: Date }>("SELECT expires_at FROM on_sessions WHERE token_hash=$1", [sessionTokenHash(token)])).rows[0]!.expires_at;
      links[kind] = { personId, generation, expiresAt: expiry.toISOString() }; changed = true;
    }
    // Only the link records are merged; a concurrently running step keeps its own progress fields.
    if (changed) await client.query("UPDATE on_judge_demonstrations SET state=jsonb_set(state,'{crewLinks}',$2::jsonb),updated_at=now() WHERE tenant_id=$1", [actor.tenantId, JSON.stringify(links)]);
    await client.query("COMMIT"); return links;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
