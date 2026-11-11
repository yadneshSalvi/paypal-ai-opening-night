import { createHash, randomUUID } from "node:crypto";
import type { ConsoleData } from "../src/domain/contracts";
import type { WrapAssistantView, WrapAssistantWorkspace } from "../src/domain/wrap/assistant";
import type { EntryRecord, InvoiceView, WrapData } from "../src/domain/wrap/contracts";
import { buildWrapReport } from "../src/domain/wrap/report";
import { base } from "./helpers";

/** Synthetic DOM-test account. It never reads the retained native fixture. */
export function wrapUiFixture(count = 21) {
  const { show, actor } = base(), now = new Date().toISOString();
  const entries: EntryRecord[] = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(), commandId: randomUUID(), requestDigest: "a".repeat(64), actorId: actor.id,
    revision: index + 1, productionRevision: show.revision, recordedAt: now,
    kind: "entry", version: 1, previousDigest: null,
    entry: { entryId: randomUUID(), previousId: null, kind: "expense", category: "production", label: `Fixture expense ${String(index + 1).padStart(2, "0")}`, amountMinor: 1000 + index, currency: "USD", serviceDay: show.showDate, reference: `DOM-SOURCE-${index + 1}`, detail: "Synthetic attributed source for DOM focus testing.", sourceIds: [], reviewedScope: true },
  }));
  const report = buildWrapReport(show, { schemaVersion: 1, revision: 0, records: [] }, { schemaVersion: 1, revision: 0, records: [] }, { schemaVersion: 1, revision: entries.length, records: entries }, true);
  const bytes = new TextEncoder().encode("Synthetic immutable report bytes for focus testing.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const invoice: InvoiceView = {
    id: randomUUID(), entryId: entries[0]?.entry.entryId ?? randomUUID(), entryRecordId: entries[0]?.id ?? randomUUID(), label: "Synthetic original invoice", serviceDay: show.showDate, amountMinor: 1000,
    invoiceNumber: "ON-DOM-ORIGINAL", reference: "DOM-ORIGINAL", issuer: "issuer@owned.invalid", recipient: "recipient@owned.invalid", admissionLabel: "Synthetic owned parties",
    providerId: "INV2-DOM-ORIGINAL", status: "DRAFT", verified: true, observedAt: now, payerUrl: null, envelope: null, rawDigest: null,
    currentCollectedMinor: 0, historicalCollectedMinor: 0, currentRefundedMinor: 0, historicalRefundedMinor: 0, outstandingClaimMinor: 0, collectionComplete: true, problem: null, transport: "local_fixture",
    grants: [{ id: randomUUID(), operation: "send", expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "queued", canRevoke: true }],
  };
  const data: WrapData = {
    schemaVersion: 1, tenantId: show.tenantId, actorId: actor.id, revision: entries.length, productionRevision: show.revision, serverAt: now, controlledQa: true, report,
    entries, adjustments: [], cashReports: [], invoices: [invoice], proposals: [], receipts: [], admissions: [],
    editions: [{ id: randomUUID(), edition: 1, title: "Synthetic complete edition", asOf: now, reportDigest: report.contentDigest, pdfHash: hash, jsonHash: hash, pages: 1, createdBy: actor.id, createdAt: now }],
    capability: { configured: true, mode: "controlled_fixture", merchantFingerprint: "b".repeat(64), message: "Synthetic transport. No provider access.", toolkitVersion: "1.11.0" },
    toolkit: [{ key: `invoice:${invoice.id}`, tool: "get_invoice", label: invoice.label, lineId: report.lines[0]?.id ?? "absent" }],
  };
  const run: WrapAssistantView = {
    id: randomUUID(), requestId: randomUUID(), prompt: "Explain this synthetic source.", createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), sourceDigest: report.contentDigest,
    state: "completed", provenance: "controlled_fixture", model: "gpt-6.1-sol", reasoning: "max", canContinue: false,
    messages: [{ step: 1, text: "Retained synthetic analysis.", call: null }], steps: [], problem: null, selectedCount: 1, totalCount: count,
    bindings: [{ ref: "L1", lineIds: report.lines[0] ? [report.lines[0].id] : [] }],
  };
  const workspace: WrapAssistantWorkspace = { available: true, provenance: "controlled_fixture", runs: [run], total: 1, nextCursor: null };
  const consoleData: ConsoleData = { show, currentActor: actor, serverAt: now, controlledQa: true, readiness: [] };
  return { data, consoleData, workspace, run, invoice, bytes };
}
