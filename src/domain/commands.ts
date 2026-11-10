import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, type Actor, type Candidate, type OperationalFact, type ShowSnapshot } from "./contracts";
import { consoleIncident, flightIncident } from "./fixture";
import { digest } from "./hash";
import { readiness } from "./readiness";
import { affectedSubgraph, planningDigest, validatePatch } from "./scheduling";
import { atVenue, compareInstants, localTime } from "./time";
import { uniqueActual } from "./finance";

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("load_incidents") }).strict(),
  z.object({ type: z.literal("generate") }).strict(),
  z.object({ type: z.literal("approve"), candidateId: z.string().max(100), candidateDigest: z.string().length(64), approvals: z.array(z.string().max(80)).max(12) }).strict(),
  z.object({ type: z.literal("publish") }).strict(),
  z.object({ type: z.literal("acknowledge"), sheetVersion: z.number().int().positive(), sheetDigest: z.string().length(64), seenTaskIds: z.array(z.string().max(100)).max(300), offline: z.boolean() }).strict(),
  z.object({ type: z.literal("fact"), kind: z.enum(["supplier_confirmed", "delivery_accepted", "return_accepted", "focus_signed_off", "cue_signed_off", "foh_contingency", "support_checkin", "support_ready", "headliner_checkin", "quiet_prep", "changeover"]), detail: z.string().trim().min(12).max(1200) }).strict(),
  z.object({ type: z.literal("advance"), time: z.enum(["16:10", "17:15", "17:20", "18:15", "18:35", "18:45", "19:00", "19:35", "20:10", "20:40", "22:15", "23:30"]) }).strict(),
  z.object({ type: z.literal("go"), reportId: z.string().length(64) }).strict(),
  z.object({ type: z.literal("house_open") }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const commandEnvelope = z.object({ idempotencyKey: z.string().uuid(), expectedRevision: z.number().int().positive(), command: commandSchema }).strict();

function requireRole(actor: Actor, ...roles: Actor["roles"]) {
  if (!roles.some(r => actor.roles.includes(r))) throw new DomainError("ROLE_REQUIRED", `This action requires ${roles.join(" or ")} authority.`, 403);
}
export function appendEvent(show: ShowSnapshot, actor: Actor, type: string, message: string, now: string) {
  show.events.push({ id: randomUUID(), type, message, at: now, fixtureAt: show.clock, actorId: actor.id, source: "sample", revision: show.revision + 1 });
}
export function applyCommand(input: ShowSnapshot, actor: Actor, command: Command, now = new Date().toISOString()): ShowSnapshot {
  if (input.tenantId !== actor.tenantId) throw new DomainError("TENANT_MISMATCH", "This show belongs to another session.", 403);
  const show = structuredClone(input);
  switch (command.type) {
    case "load_incidents": {
      requireRole(actor, "producer", "stage_manager");
      if (show.incidents.length) throw new DomainError("INCIDENT_ALREADY_LOADED", "These source incidents are already recorded.");
      show.incidents = [flightIncident(), consoleIncident()];
      const affected = affectedSubgraph(show.dependencies, show.incidents.flatMap(i => i.affectedTaskIds));
      for (const t of show.tasks) if (affected.includes(t.id)) { t.affected = true; t.state = "blocked"; }
      show.approvedPlan = null; show.state = "standby"; show.goReportId = null; show.planVersion++;
      appendEvent(show, actor, "incident.confirmed", "Recorded the 15:10 flight revision and the 15:25 console report from the controlled scenario.", now); break;
    }
    case "generate": throw new DomainError("ENGINE_REQUIRED", "Candidate generation runs through the server scheduling service.");
    case "approve": {
      requireRole(actor, "producer");
      const candidate = show.runs.at(-1)?.candidates.find(c => c.id === command.candidateId);
      if (!candidate || candidate.digest !== command.candidateDigest || candidate.sourceDigest !== planningDigest(show)) throw new DomainError("STALE_CANDIDATE", "The proposal no longer matches the current production graph. Recompute alternatives.");
      const offer = show.offers.find(o => o.id === candidate.patch.offerId)!;
      const checked = validatePatch(show, candidate.patch, offer);
      if (!["feasible", "feasible_with_approval"].includes(checked.status) || candidate.report.engine?.status !== "passed") throw new DomainError("PLAN_NOT_FEASIBLE", "A successful engine run and all deterministic constraints are required.");
      for (const requirement of candidate.approvals) {
        if (!command.approvals.includes(requirement.id)) throw new DomainError("APPROVAL_MISSING", `${requirement.label} needs explicit approval.`);
        if (!actor.roles.includes(requirement.role as Actor["roles"][number])) throw new DomainError("APPROVAL_ROLE_REQUIRED", `${requirement.label} requires the ${requirement.role.replaceAll("_", " ")}.`, 403);
        requirement.grantedBy = actor.id;
      }
      show.approvedPlan = { candidateId: candidate.id, digest: candidate.digest, approvedAt: now, actorId: actor.id, commercialCapMinor: offer.feeMinor + offer.depositMinor, roles: [...actor.roles], baseRevision: show.revision };
      show.tasks = structuredClone(candidate.patch.tasks); show.dependencies = structuredClone(candidate.patch.dependencies); show.doorsAt = candidate.patch.doorsAt; show.planVersion++;
      show.state = "standby"; show.goReportId = null;
      appendEvent(show, actor, "rescue.approved", `${candidate.name} approved. ${localTime(candidate.patch.doorsAt)} doors; commercial execution and publication remain pending.`, now); break;
    }
    case "publish": {
      requireRole(actor, "producer", "stage_manager");
      if (!show.approvedPlan) throw new DomainError("PLAN_APPROVAL_REQUIRED", "Approve a current recovery plan before publishing.");
      const secured = uniqueActual(show).some(e => e.planVersion === show.planVersion && e.kind === "authorization" && e.purpose === "rental" && e.amountMinor === show.approvedPlan!.commercialCapMinor);
      const confirmed = show.facts.some(f => f.kind === "supplier_confirmed" && f.planVersion === show.planVersion);
      if (!secured || !confirmed) throw new DomainError("COMMERCIAL_PENDING", "Publication waits for verified rental authorization and supplier confirmation.");
      if (show.sheets.at(-1)?.candidateId === show.approvedPlan.candidateId) throw new DomainError("ALREADY_PUBLISHED", "This approved plan is already published.");
      const previous = show.sheets.at(-1)!;
      const changes = show.tasks.flatMap(t => { const old = previous.tasks.find(v => v.id === t.id); return !old || old.start !== t.start || old.end !== t.end ? [{ taskId: t.id, name: t.name, before: old ? `${localTime(old.start)}–${localTime(old.end)}` : "New call", after: `${localTime(t.start)}–${localTime(t.end)}`, reason: "Approved recovery plan", resourceIds: t.resources }] : []; });
      for (const old of previous.tasks.filter(t => !show.tasks.some(current => current.id === t.id))) changes.push({ taskId: old.id, name: old.name, before: `${localTime(old.start)}–${localTime(old.end)}`, after: "Canceled", reason: "Approved recovery plan", resourceIds: old.resources });
      const version = previous.version + 1;
      show.sheets.push({ id: randomUUID(), version, planRevision: show.planVersion, candidateId: show.approvedPlan.candidateId, digest: digest({ tasks: show.tasks, version, candidate: show.approvedPlan.digest }), publishedAt: now, tasks: structuredClone(show.tasks), changes });
      appendEvent(show, actor, "run_sheet.published", `Published run sheet v${version}; ${changes.length} changes require current acknowledgments.`, now); break;
    }
    case "acknowledge": {
      requireRole(actor, "crew");
      if (!actor.personId) throw new DomainError("CREW_IDENTITY_REQUIRED", "A person-scoped crew session is required.", 403);
      const sheet = show.sheets.find(s => s.version === command.sheetVersion && s.digest === command.sheetDigest);
      if (!sheet) throw new DomainError("SHEET_NOT_FOUND", "This sheet version cannot be verified.");
      const relevant = sheet.changes.filter(c => c.resourceIds.includes(actor.personId!));
      if (relevant.some(c => !command.seenTaskIds.includes(c.taskId))) throw new DomainError("UNREAD_CHANGES", "Review every changed personal call before acknowledging.");
      if (show.acknowledgments.some(a => a.personId === actor.personId && a.sheetDigest === sheet.digest)) throw new DomainError("ALREADY_ACKNOWLEDGED", "This person already acknowledged this exact sheet.");
      show.acknowledgments.push({ id: randomUUID(), personId: actor.personId, sheetVersion: sheet.version, sheetDigest: sheet.digest, receivedAt: now, source: "controlled_client", offline: command.offline });
      appendEvent(show, actor, "crew.acknowledged", `${show.resources.find(r => r.id === actor.personId)?.name} acknowledged v${sheet.version}${sheet.version !== show.sheets.at(-1)!.version ? " (historical; current changes remain unread)" : ""}.`, now); break;
    }
    case "fact": {
      if (!show.approvedPlan) throw new DomainError("PLAN_APPROVAL_REQUIRED", "Approve a current plan before recording execution evidence.");
      const role: Record<OperationalFact["kind"], Actor["roles"][number]> = { supplier_confirmed: "supplier", delivery_accepted: "department_lead", return_accepted: "supplier", focus_signed_off: "department_lead", cue_signed_off: "department_lead", foh_contingency: "foh", support_checkin: "stage_manager", support_ready: "department_lead", headliner_checkin: "stage_manager", quiet_prep: "department_lead", changeover: "stage_manager" };
      requireRole(actor, role[command.kind]);
      const earliest: Partial<Record<OperationalFact["kind"], string>> = { delivery_accepted: "17:15", return_accepted: "23:30", focus_signed_off: "18:15", cue_signed_off: "18:35", headliner_checkin: "19:35", quiet_prep: "20:10", changeover: "20:40" };
      if (earliest[command.kind] && compareInstants(show.clock, atVenue(earliest[command.kind]!)) < 0) throw new DomainError("FACT_TOO_EARLY", `This event cannot be recorded before ${earliest[command.kind]} fixture time.`);
      if (show.facts.some(f => f.kind === command.kind && f.planVersion === show.planVersion)) throw new DomainError("FACT_ALREADY_RECORDED", "This plan already has that fact.");
      if (["focus_signed_off", "cue_signed_off"].includes(command.kind) && !uniqueActual(show).some(e => e.planVersion === show.planVersion && e.kind === "capture" && e.purpose === "rental" && e.amountMinor === 48000)) throw new DomainError("FEE_CAPTURE_REQUIRED", "The rental fee capture must be verified before technical sign-off.");
      if (command.kind === "quiet_prep" && !show.facts.some(f => f.planVersion === show.planVersion && f.kind === "headliner_checkin")) throw new DomainError("ARTIST_NOT_CHECKED_IN", "Record the artist’s actual fixture check-in first.");
      show.facts.push({ id: randomUUID(), kind: command.kind, planVersion: show.planVersion, actorId: actor.id, role: role[command.kind], recordedAt: now, fixtureAt: show.clock, source: "sample", detail: command.detail });
      appendEvent(show, actor, `execution.${command.kind}`, `Recorded controlled fixture evidence: ${command.detail}`, now); break;
    }
    case "advance": {
      requireRole(actor, "producer", "stage_manager");
      const to = atVenue(command.time);
      if (compareInstants(to, show.clock) <= 0) throw new DomainError("CLOCK_MONOTONIC", "The fixture clock can only move forward.");
      show.clock = to; appendEvent(show, actor, "fixture.clock_advanced", `Advanced the labeled scenario clock to ${command.time}. No execution evidence was created.`, now); break;
    }
    case "go": {
      requireRole(actor, "stage_manager");
      const report = readiness(show, "DOORS");
      if (command.reportId !== report.id) throw new DomainError("STALE_READINESS", "Readiness changed. Review the current report before issuing GO.");
      if (!report.ready) throw new DomainError("READINESS_BLOCKED", `${report.blockers.length} DOORS gates remain unresolved.`);
      show.state = "go"; show.goReportId = report.id; appendEvent(show, actor, "cue.go_issued", "Stage manager issued DOORS GO against the current readiness report.", now); break;
    }
    case "house_open": {
      requireRole(actor, "foh");
      if (show.state !== "go" || !show.goReportId || !readiness(show, "DOORS").ready) throw new DomainError("GO_REQUIRED", "A valid stage-manager GO is required before HOUSE OPEN.");
      show.state = "house_open"; appendEvent(show, actor, "cue.house_open", "Front of house confirmed HOUSE OPEN.", now); break;
    }
  }
  show.revision++; show.updatedAt = now;
  if (show.state !== "standby" && !readiness(show, "DOORS").ready) { show.state = "standby"; show.goReportId = null; }
  return show;
}
export function recordRescueRun(input: ShowSnapshot, actor: Actor, candidates: Candidate[], now = new Date().toISOString()): ShowSnapshot {
  requireRole(actor, "producer", "stage_manager");
  if (actor.tenantId !== input.tenantId || candidates.some(c => c.sourceDigest !== planningDigest(input))) throw new DomainError("STALE_RUN", "The production graph changed during the engine run.");
  const show = structuredClone(input);
  show.runs.push({ id: randomUUID(), baseRevision: input.revision, createdAt: candidates[0]?.generatedAt ?? now, completedAt: now, candidates, source: "modelled", strategySource: "deterministic_enumerator" });
  appendEvent(show, actor, "rescue.candidate_validated", `Computed ${candidates.length} alternatives using the real scheduling engine and deterministic production constraints.`, now);
  show.revision++; show.updatedAt = now; return show;
}
