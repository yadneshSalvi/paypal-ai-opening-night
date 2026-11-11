import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { InvoiceDraft, InvoiceGrant, InvoiceResult, WrapState } from "@/domain/wrap/contracts";
import { currentEntries, invoiceDraft, invoiceEnvelopeProblem, invoiceHistoryProblem, invoiceView, ownedInvoiceId, wrapRecords } from "@/domain/wrap/invoices";
import { withCommerceLock } from "../commerce-locks";
import type { JobKind, JobResult } from "../jobs";
import type { SettlementAuthority } from "../settlement/service";
import { runGuardedInvoice, wrapCapability } from "./provider";
import { appendWrapRecord, assertWrapAuthority, bindInvoiceResource, readWrapState, wrapShow, wrapTransaction } from "./store";

export const invoiceJobKinds: readonly JobKind[] = ["invoice_operation"];
export interface InvoiceJob { invoiceId: string; grantId: string | null; refreshId: string | null }
function authorityFor(state: WrapState, job: InvoiceJob): SettlementAuthority {
  const holder = job.refreshId ? wrapRecords(state, "invoice_refresh").find(record => record.id === job.refreshId && record.invoiceId === job.invoiceId) : wrapRecords(state, "invoice_grant").find(record => record.id === job.grantId && record.invoiceId === job.invoiceId);
  if (!holder) throw new DomainError("INVOICE_READ_AUTHORITY_MISSING", "The original operation or reconciliation request is absent.", 403);
  return { ...holder.authority, scope: "production" };
}
function assertGrant(draft: InvoiceDraft, state: WrapState, grant: InvoiceGrant, admissions: ReturnType<typeof wrapCapability>, now = Date.now()) {
  const current = currentEntries(state).find(record => record.entry.entryId === draft.entryId), admission = admissions.admissions.find(item => item.id === draft.admission.id && item.digest === draft.admission.digest);
  if (Date.parse(grant.expiresAt) <= now || wrapRecords(state, "invoice_revoked").some(record => record.grantId === grant.id)) throw new DomainError("INVOICE_AUTHORITY_ENDED", "This exact invoice approval expired or was revoked.", 409);
  if (!current || current.id !== draft.entryRecordId || digest(current) !== draft.entryDigest || !admission || Date.parse(admission.expiresAt) <= now || admission.merchantFingerprint !== admissions.capability.merchantFingerprint) throw new DomainError("INVOICE_APPROVAL_CHANGED", "The approved entry, parties or isolated merchant changed.", 409);
  if (grant.operation !== "cancel" && wrapRecords(state, "entry_adjustment").some(record => record.entryId === draft.entryId)) throw new DomainError("INVOICE_APPROVAL_CHANGED", "An approved revenue adjustment invalidates issuance of the original face amount.", 409);
  if (grant.operation !== "create" && (!grant.expectedEnvelope || invoiceEnvelopeProblem(draft, grant.expectedEnvelope))) throw new DomainError("INVOICE_REVIEW_ENVELOPE_CHANGED", "The exact reviewed invoice envelope is unavailable.", 409);
}
const errorCode = (error: unknown) => error instanceof DomainError ? error.code : "INVOICE_WORK_INTERRUPTED";
export async function runInvoiceJob(tenantId: string, job: InvoiceJob, signal: AbortSignal): Promise<JobResult> {
  return withCommerceLock(`invoice:${tenantId}:${job.invoiceId}`, async () => {
    const prepared = await wrapTransaction(async db => {
      const show = await wrapShow(db, tenantId, true), state = await readWrapState(db, show), draft = invoiceDraft(state, job.invoiceId), authority = authorityFor(state, job), grant = job.grantId ? wrapRecords(state, "invoice_grant").find(record => record.id === job.grantId && record.invoiceId === draft.id) ?? null : null;
      try { await assertWrapAuthority(db, authority, show); } catch (error) { return { held: errorCode(error) } as const; }
      const dispatched = grant && wrapRecords(state, "invoice_dispatch").some(record => record.grantId === grant.id);
      if (grant && !dispatched) {
        try { assertGrant(draft, state, grant, wrapCapability(show)); } catch (error) {
          if (!wrapRecords(state, "invoice_held").some(record => record.grantId === grant.id)) await appendWrapRecord(db, show, state, { kind: "invoice_held", invoiceId: draft.id, grantId: grant.id, code: errorCode(error) }, { request: job, semanticKey: grant.id });
          return { held: errorCode(error) } as const;
        }
        const view = invoiceView(state, draft);
        if (grant.operation === "create" && view.providerId || grant.operation !== "create" && !view.providerId) return { held: "INVOICE_ORIGINAL_IDENTITY_REQUIRED" } as const;
        await appendWrapRecord(db, show, state, { kind: "invoice_dispatch", invoiceId: draft.id, grantId: grant.id, operation: grant.operation, requestDigestAtDispatch: digest(draft.request) }, { request: job, semanticKey: grant.id });
      }
      return { draft, authority, grant: dispatched ? null : grant, knownId: ownedInvoiceId(state, draft.id) } as const;
    });
    if ("held" in prepared) return { status: "needs_attention", code: prepared.held };
    const { draft, grant, knownId } = prepared;
    const assertRead = () => wrapTransaction(async db => { const show = await wrapShow(db, tenantId); await assertWrapAuthority(db, prepared.authority, show); const state = await readWrapState(db, show); if (digest(invoiceDraft(state, draft.id)) !== digest(draft)) throw new DomainError("INVOICE_DRAFT_CHANGED", "The retained original invoice cannot be verified.", 409); });
    let result: InvoiceResult;
    try {
      result = await runGuardedInvoice(draft, grant, knownId, { assertRead, beforeMutation: (proof, raw) => wrapTransaction(async db => {
        const show = await wrapShow(db, tenantId, true); await assertWrapAuthority(db, prepared.authority, show); const state = await readWrapState(db, show);
        if (!grant || !wrapRecords(state, "invoice_dispatch").some(record => record.grantId === grant.id) || wrapRecords(state, "invoice_preflight").some(record => record.grantId === grant.id)) throw new DomainError("INVOICE_DISPATCH_ALREADY_CLAIMED", "This exact original instruction already reached its final dispatch boundary.", 409);
        assertGrant(draft, state, grant, wrapCapability(show));
        await appendWrapRecord(db, show, state, { kind: "invoice_preflight", invoiceId: draft.id, grantId: grant.id, operation: grant.operation, proof, raw }, { request: { job, reviewDigest: grant.reviewDigest }, semanticKey: grant.id });
      }) }, signal);
    } catch (error) { result = { outcome: "unknown", code: errorCode(error), value: null, raw: null, rawDigest: null, envelope: null, verified: false, problem: errorCode(error), transport: wrapCapability(await wrapTransaction(db => wrapShow(db, tenantId))).capability.mode === "controlled_fixture" ? "local_fixture" : "paypal_https", observedAt: new Date().toISOString(), httpStatus: null, debugId: null, mutationAttempted: Boolean(grant), proofs: [] }; }
    await wrapTransaction(async db => {
      const show = await wrapShow(db, tenantId, true), state = await readWrapState(db, show);
      if (result.verified && result.value) { const problem = invoiceHistoryProblem(state, draft.id, result.value); if (problem) result = { ...result, verified: false, problem }; }
      if (result.verified && result.value) {
        try {
          await bindInvoiceResource(db, { merchant: draft.admission.merchantFingerprint, kind: "invoice", providerId: result.value.id, tenantId, invoiceId: draft.id });
          for (const payment of result.value.payments) if (payment.id) await bindInvoiceResource(db, { merchant: draft.admission.merchantFingerprint, kind: "invoice_payment", providerId: payment.id, tenantId, invoiceId: draft.id });
          for (const refund of result.value.refunds) if (refund.id) await bindInvoiceResource(db, { merchant: draft.admission.merchantFingerprint, kind: "invoice_refund", providerId: refund.id, tenantId, invoiceId: draft.id });
        } catch (error) { result = { ...result, verified: false, problem: errorCode(error) }; }
      }
      await appendWrapRecord(db, show, state, { kind: "invoice_read", invoiceId: draft.id, grantId: job.grantId, refreshId: job.refreshId, result }, { request: { job, mode: grant?.operation ?? "read_original" } });
    });
    return result.verified ? { status: "complete" } : { status: "needs_attention", code: result.code && /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : "INVOICE_RECONCILIATION_REQUIRED" };
  });
}
