/** One declared400-ticket controlled service run. No provider/model/email/physical claims. */
import "./audience-controlled-wire-runtime.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { digest } from "../../src/domain/hash";
import type { AttendeeView, AudienceDeliveryPass, AudienceMessageView, AudienceResult } from "../../src/domain/audience/contracts";
import type { AttendeeReader } from "../../src/server/audience/attendee";
import { audienceHarness } from "../../tests/audience-harness";
import { audienceProductionInputs, audienceSha256 } from "./audience-inputs.mjs";
const directory = ".artifacts/audience-stage17/stress-" + randomUUID(), count = 400;
await mkdir(directory, { recursive: true, mode: 0o700 });
const source = await audienceProductionInputs(process.cwd()), expectations = { version: 1, originalTickets: 400, admissionMinorPerTicket: 3500, perkMinorPerTicket: 1500, captureMinorPerTicket: 5000, separatelyBoundCapabilities: 400, capability401RejectedWithoutReservation: true, immutableDraftRecipients: 400, separateApprovals: 1, perPassLimit: 10, completedPasses: 40, uniqueRecipientReceipts: 400, ownInboxReceiptsPerCapability: 1, allProviderPostsDurableBeforeTransport: true, externalProviderRequests: 0, externalAudienceMessages: 0, actualHumanReviews: 0, actualPhysicalEntries: 0 };
await writeFile(directory + "/expectations.json", JSON.stringify({ expectations, expectationHash: digest(expectations), sourceInputDigest: source.digest, harnessHash: audienceSha256(await readFile("tests/audience-harness.ts")), scriptHash: audienceSha256(await readFile("scripts/qa/audience-stress.ts")), declaredAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
let h: Awaited<ReturnType<typeof audienceHarness>> | null = null, peakHeapBytes = 0, peakRssBytes = 0;
const started = performance.now(), measurements: { phase: string; elapsedMs: number; completed: number; heapBytes: number; rssBytes: number }[] = [];
async function observe(phase: string, completed: number) { const memory = process.memoryUsage(); peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed); peakRssBytes = Math.max(peakRssBytes, memory.rss); const value = { phase, elapsedMs: performance.now() - started, completed, heapBytes: memory.heapUsed, rssBytes: memory.rss }; measurements.push(value); await writeFile(directory + "/" + String(measurements.length).padStart(3, "0") + "-" + phase + ".json", JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); if (completed % 100 === 0 || phase.includes("plan")) console.log(JSON.stringify(value)); }
let state: "qualified" | "failed" = "failed";
const originals: { ticketId: string; captureId: string; receiptDigest?: string; capabilityId?: string; invitationDigest?: string }[] = [];
let passes = 0, delivered = 0, checkedInboxes = 0, providerCalls = 0, schema: string | null = null;
try {
  h = await audienceHarness(); schema = h.database.schema;
  const value = await h.accepted({ replacePlan: false }); await h.command(value.actor, { type: "publish" });
  const show = await h.store.getShow(value.actor.tenantId), candidate = show.runs.flatMap(run => run.candidates).find(item => item.id === show.approvedPlan!.candidateId)!; assert.equal(candidate.report.engine?.status, "passed"); await observe("native-controlled-plan", 0);
  for (let index = 0; index < count; index++) { const original = await h.capture(value, "vip"); originals.push({ ticketId: original.ticket.id, captureId: original.captureId }); if ((index + 1) % 25 === 0) await observe("original-captures", index + 1); }
  let workspace = await h.audience.readAudienceWorkspace(value.authority); assert.equal(workspace.tickets.length, count); assert.ok(workspace.tickets.every(item => item.verification === "verified" && item.admissionMinor === 3500 && item.perkMinor === 1500 && item.grossMinor === 5000));
  const readers: AttendeeReader[] = [];
  for (let index = 0; index < count; index++) {
    const original = originals[index]!, receipt = workspace.tickets.find(item => item.ticketId === original.ticketId)!;
    const result = await h.audience.executeAudienceCommand(value.authority, { commandId: randomUUID(), expectedRevision: workspace.revision, sessionFingerprint: workspace.sessionFingerprint, sessionExpiresAt: workspace.expiresAt, command: { type: "create_invite", ticketId: original.ticketId, receiptDigest: receipt.originalDigest, validForMinutes: 60, confirmed: true } });
    assert.ok(result.invitation); original.receiptDigest = receipt.originalDigest; original.capabilityId = result.invitation.capabilityId; original.invitationDigest = digest(result.invitation); workspace = result.workspace;
    readers.push(await h.attendee.requireAttendeeReader(new Request("http://127.0.0.1:4594/api/attendee", { headers: { authorization: "Bearer " + result.invitation.url.split("#")[1]! } })));
    if ((index + 1) % 25 === 0) await observe("original-capabilities", index + 1);
  }
  assert.equal(workspace.capabilities.length, count);
  const overLimitId = randomUUID(), extra = { commandId: overLimitId, expectedRevision: workspace.revision, sessionFingerprint: workspace.sessionFingerprint, sessionExpiresAt: workspace.expiresAt, command: { type: "create_invite" as const, ticketId: originals[0]!.ticketId, receiptDigest: originals[0]!.receiptDigest!, validForMinutes: 60, confirmed: true as const } };
  await assert.rejects(h.audience.executeAudienceCommand(value.authority, extra), { code: "AUDIENCE_CAPABILITY_LIMIT", status: 422 });
  await assert.rejects(h.audience.recoverAudienceCommand(value.authority, overLimitId), { code: "AUDIENCE_RECEIPT_NOT_FOUND" });
  assert.equal((await h.audience.readAudienceWorkspace(value.authority)).capabilities.length, count);
  const draft = await h.draft(value, originals.map(item => item.capabilityId!), "event_update", "Controlled400-ticket service qualification. Each original receipt is synthetic service-backed evidence through the installed SDK transport seam; no actual provider, human approval, external delivery or physical entry is claimed.");
  assert.equal(draft.draft.recipients.length, count); assert.equal(draft.approval, null); assert.equal(draft.deliveries.length, 0);
  const approved = await h.approve(value, draft.draft.id); assert.equal(approved.view.approval!.recipientCount, count); assert.equal(approved.view.deliveries.length, 0); await observe("separate-reviewed-approval", 0);
  await writeFile(directory + "/original-bindings.json", JSON.stringify({ originalFixedExpiry: workspace.expiresAt, originalBindings: originals, draftDigest: draft.draft.digest, recipientDigest: draft.draft.recipientDigest, contentDigest: draft.draft.contentDigest, approvalDigest: approved.view.approval!.digest }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  let last: AudienceMessageView = approved.view;
  while (delivered < count) {
    const result: { saved: AudienceResult; view: AudienceMessageView } = await h.deliver(value, draft.draft.id, 10); last = result.view; passes++; assert.equal(last.deliveries.length - delivered, 10); delivered = last.deliveries.length;
    const actual: AudienceDeliveryPass = last.passes.find(item => item.id === result.saved.receipt.recordId)!; assert.equal(actual.limit, 10); assert.equal(actual.processed, 10); assert.equal(actual.state, "complete");
    await observe("bounded-inbox-delivery", delivered);
  }
  assert.equal(passes, 40); assert.equal(last.deliveries.length, 400); assert.equal(new Set(last.deliveries.map(item => item.capabilityId)).size, 400);
  for (let index = 0; index < readers.length; index++) {
    const view: AttendeeView = await h.attendee.readAttendee(readers[index]!); assert.equal(view.receipt.originalDigest, originals[index]!.receiptDigest); assert.equal(view.inbox.length, 1); assert.equal(view.inbox[0]!.ticketId, view.receipt.ticketId); assert.equal(view.inbox[0]!.contentDigest, draft.draft.recipients.find(item => item.capabilityId === view.capabilityId)!.content.digest); assert.equal(view.inbox[0]!.sourceIsCurrent, true); checkedInboxes++; if ((index + 1) % 25 === 0) await observe("exact-private-inboxes", index + 1);
  }
  assert.ok(h.wire.calls.filter(call => call.method === "POST").every(call => call.durable)); providerCalls = h.wire.calls.length;
  await writeFile(directory + "/immutable-delivery-manifest.json", JSON.stringify(last.deliveries.map(item => ({ id: item.id, capabilityId: item.capabilityId, ticketId: item.ticketId, digest: item.digest, contentDigest: item.contentDigest, sourceDigest: item.sourceDigest, receivedAt: item.receivedAt })), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(directory + "/controlled-sdk-request-manifest.json", JSON.stringify({ requests: h.wire.calls, actualExternalProviderRequests: 0, schemaRetained: false, provenance: "Installed SDK over in-memory RetainedRentalWire; controlled fixture payer, supplier and inspection statements" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  assert.equal((await audienceProductionInputs(process.cwd())).digest, source.digest); state = "qualified";
} catch (error) {
  await writeFile(directory + "/first-failure.json", JSON.stringify({ at: new Date().toISOString(), schema, originals, passes, delivered, checkedInboxes, name: error instanceof Error ? error.name : "Unknown", message: error instanceof Error ? error.message : "Unknown", originalStateRetained: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); process.exitCode = 1; console.error("Controlled400-ticket qualification failed; its original private schema and receipts were retained without retry.");
} finally {
  if (h) { if (state === "qualified") await h.close(); else { await (await import("../../src/server/commerce-locks")).closeCommerceLocks(); await h.database.pool.end(); } }
  const report = { version: 1, state, directory, sourceInputDigest: source.digest, expectationHash: digest(expectations), declaredTickets: count, observedCaptures: originals.length, observedCapabilities: originals.filter(item => item.capabilityId).length, completedPasses: passes, perPassLimit: 10, committedInboxReceipts: delivered, independentlyReadPrivateInboxes: checkedInboxes, elapsedMs: performance.now() - started, observedPeakHeapBytes: peakHeapBytes, observedPeakRssBytes: peakRssBytes, processMaxRssKilobytes: process.resourceUsage().maxRSS, controlledSdkRequests: providerCalls, actualExternalProviderRequests: 0, actualExternalAudienceMessages: 0, actualHumanReviews: 0, actualPhysicalEntries: 0, measurements, completedAt: new Date().toISOString() };
  await writeFile(directory + "/report.json", JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify({ state, directory, committedInboxReceipts: delivered, independentlyReadPrivateInboxes: checkedInboxes, elapsedMs: report.elapsedMs, peakHeapBytes, peakRssBytes }));
}
