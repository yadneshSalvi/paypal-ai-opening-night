import { z } from "zod";
import { SandboxCommerceRestGateway, type CommerceRestResult, type InvoiceObservation, type SandboxConfig } from "@fracture/paypal-core";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { InvoiceAdmission, InvoiceDraft, InvoiceEnvelope, InvoiceGrant, InvoiceResult, InvoiceWireProof, WrapData } from "@/domain/wrap/contracts";
import { invoiceEnvelope, invoiceEnvelopeProblem, validateInvoiceObservation } from "@/domain/wrap/invoices";
import { boundedText } from "../bounded-body";
import { merchantConfig } from "../payment-config";
import "../env";

const admissionSchema = z.object({ id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/), tenantId: z.uuid(), label: z.string().trim().min(3).max(100), issuerEmail: z.email().max(254), recipientEmail: z.email().max(254), purposePrefix: z.string().trim().min(3).max(32), currency: z.literal("USD"), maxInvoiceMinor: z.number().int().min(1).max(10_000_000), merchantFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.iso.datetime(), controlledSandbox: z.literal(true) }).strict();
export type InvoiceAdmissionInput = z.infer<typeof admissionSchema>;
export interface WrapFixtureRuntime { config: SandboxConfig; transport: typeof fetch; admissions: (show: ShowSnapshot) => InvoiceAdmissionInput[]; toolkitTransport?: typeof fetch }
const shared = globalThis as typeof globalThis & { openingNightWrapFixture?: WrapFixtureRuntime };
export const wrapMerchantFingerprint = (config: SandboxConfig) => digest({ environment: config.environment, baseUrl: config.baseUrl, isolatedProject: config.isolatedProject, clientId: config.clientId });
const disabled = () => process.env.OPENING_NIGHT_AI_QA === "1" || process.env.OPENING_NIGHT_QA_FIXTURE === "1";
const noCredentials = () => ["OPENAI_API_KEY", "GEMINI_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET"].every(key => !process.env[key]);
function fixture() { return !process.env.VERCEL && disabled() && noCredentials() ? shared.openingNightWrapFixture : undefined; }
export function installWrapFixture(value: WrapFixtureRuntime | undefined) { if (process.env.VERCEL || !disabled() || !noCredentials()) throw new Error("Wrap fixtures require blank credentials and local provider-disabled isolation"); if (value) shared.openingNightWrapFixture = value; else delete shared.openingNightWrapFixture; }
export function wrapProviderConfiguration(expected?: string) {
  const local = fixture(); if (!local && disabled()) throw new DomainError("WRAP_QA_DISABLED", "No controlled invoice transport is connected to this rehearsal.", 503);
  const config = local?.config ?? merchantConfig("venue"), fingerprint = wrapMerchantFingerprint(config);
  if (expected && expected !== fingerprint) throw new DomainError("INVOICE_MERCHANT_CHANGED", "Restore this invoice's original isolated merchant before reconciliation.", 409);
  return { config, fingerprint, transport: local?.transport ?? fetch, toolkitTransport: local?.toolkitTransport ?? local?.transport ?? fetch, mode: local ? "local_fixture" as const : "paypal_https" as const };
}
export function wrapCapability(show: ShowSnapshot): { capability: WrapData["capability"]; admissions: InvoiceAdmission[] } {
  try {
    const { config, mode } = wrapProviderConfiguration(), fingerprint = wrapMerchantFingerprint(config), raw = fixture()?.admissions(show) ?? JSON.parse(process.env.OPENING_NIGHT_INVOICE_PARTIES_JSON ?? "[]"), all = z.array(admissionSchema).max(200).parse(raw);
    if (new Set(all.map(item => item.id)).size !== all.length || all.some(item => item.merchantFingerprint !== fingerprint)) throw new Error("Invalid invoice admission registry");
    const admissions = all.filter(item => item.tenantId === show.tenantId).map(item => ({ ...item, digest: digest(item) }));
    return { capability: { configured: true, mode: mode === "local_fixture" ? "controlled_fixture" : "live_sandbox", merchantFingerprint: fingerprint, message: admissions.length ? "Only the listed owned sandbox parties can be reviewed. Issuance uses a share link with both email flags disabled." : "The isolated merchant is connected; no owned-party invoice admission is available for this production.", toolkitVersion: "1.11.0" }, admissions };
  } catch { return { capability: { configured: false, mode: disabled() ? "controlled_fixture" : "live_sandbox", merchantFingerprint: null, message: disabled() ? "Actual providers are disabled. A controlled invoice fixture is required here." : "The isolated merchant and an exact owned-party invoice admission need configuration.", toolkitVersion: "1.11.0" }, admissions: [] }; }
}
const codeOf = (error: unknown) => error instanceof DomainError ? error.code : error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "INVOICE_EVIDENCE_UNKNOWN";
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exactCreateBody = (draft: InvoiceDraft) => ({ detail: { invoice_number: draft.request.invoiceNumber, reference: draft.request.reference, currency_code: "USD" }, invoicer: { email_address: draft.request.merchantEmail }, primary_recipients: [{ billing_info: { email_address: draft.request.recipientEmail } }], items: [{ name: draft.request.itemName, quantity: "1", unit_amount: { currency_code: "USD", value: (draft.request.money.minor / 100).toFixed(2) } }], configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } } });
export interface InvoiceGuardAuthority { assertRead: () => Promise<void>; beforeMutation: (proof: InvoiceWireProof, raw: unknown | null) => Promise<void> }
/** This transport narrows the pinned core; it cannot introduce a new endpoint or recipient. */
export async function runGuardedInvoice(draft: InvoiceDraft, grant: InvoiceGrant | null, knownId: string | null, authority: InvoiceGuardAuthority, signal: AbortSignal): Promise<InvoiceResult> {
  const configured = wrapProviderConfiguration(draft.admission.merchantFingerprint), proofs: InvoiceWireProof[] = [], allowed = new Set(knownId ? [knownId] : []), reads = new Map<string, { raw: unknown; envelope: InvoiceEnvelope | null; proof: InvoiceWireProof; status: string | null }>();
  let mutationAttempted = false, guardProblem: string | null = null, callCount = 0;
  const fail = (code: string): never => { guardProblem = code; throw new DomainError(code, "The exact original invoice or current operation authority could not be verified.", 409); };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url), method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin !== "https://api-m.sandbox.paypal.com" || url.username || url.password || url.hash || ++callCount > 205 || signal.aborted) return fail("INVOICE_TRANSPORT_SCOPE");
    await authority.assertRead();
    if (url.pathname === "/v1/oauth2/token" && method === "POST") return configured.transport(input, { ...init, signal: AbortSignal.any([signal, init?.signal ?? AbortSignal.timeout(25_000)]) });
    let body: unknown = null; try { const encoded = init?.body ? String(init.body) : input instanceof Request && method === "POST" ? await input.clone().text() : ""; if (encoded) body = JSON.parse(encoded); } catch { return fail("INVOICE_REQUEST_UNKNOWN"); }
    const original = /^\/v2\/invoicing\/invoices\/([A-Za-z0-9._-]+)$/.exec(url.pathname), mutation = /^\/v2\/invoicing\/invoices\/([A-Za-z0-9._-]+)\/(send|cancel)$/.exec(url.pathname), search = url.pathname === "/v2/invoicing/search-invoices" && method === "POST", create = url.pathname === "/v2/invoicing/invoices" && method === "POST";
    if (original && method === "GET") { if (!allowed.has(original[1]!) || url.search) return fail("INVOICE_READ_OUTSIDE_ORIGINAL"); }
    else if (search) { if (digest(body) !== digest({ invoice_number: draft.request.invoiceNumber, reference: draft.request.reference }) || url.searchParams.get("page_size") !== "100" || url.searchParams.get("total_required") !== "true" || !/^[1-9]\d{0,3}$/.test(url.searchParams.get("page") ?? "") || [...url.searchParams.keys()].length !== 3) return fail("INVOICE_SEARCH_SCOPE"); }
    else if (create) { if (url.search || !grant || grant.operation !== "create" || knownId || mutationAttempted || digest(body) !== digest(exactCreateBody(draft))) return fail("INVOICE_CREATE_SCOPE"); }
    else if (mutation && method === "POST") {
      if (!grant || grant.operation !== mutation[2] || mutation[1] !== knownId || url.search || mutationAttempted || digest(body) !== digest({ send_to_recipient: false, send_to_invoicer: false })) return fail("INVOICE_NO_NOTIFICATION_POLICY");
      const fresh = reads.get(knownId!);
      if (!fresh?.envelope || !fresh.proof.responseDigest || !grant.expectedEnvelope || Date.now() - Date.parse(fresh.proof.at) > 30_000) return fail("INVOICE_FRESH_PREFLIGHT_REQUIRED");
      const problem = invoiceEnvelopeProblem(draft, fresh.envelope, grant.expectedEnvelope); if (problem) return fail(problem);
      if (grant.operation === "send" ? fresh.status !== "DRAFT" : !["SENT", "SHARED", "UNPAID"].includes(fresh.status ?? "")) return fail("INVOICE_STATE_CHANGED");
    } else return fail("INVOICE_TRANSPORT_SCOPE");
    const proof: InvoiceWireProof = { method: method as "GET" | "POST", path: url.pathname + url.search, at: new Date().toISOString(), status: null, requestDigest: body ? digest(body) : null, responseDigest: null, envelope: null, mutation: create || Boolean(mutation), problem: null };
    if (proof.mutation) {
      const fresh = knownId ? reads.get(knownId) : null;
      await authority.beforeMutation(fresh?.proof ?? proof, fresh?.raw ?? null);
      mutationAttempted = true;
    }
    proofs.push(proof);
    let response: Response;
    try { response = await configured.transport(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, init?.signal ?? AbortSignal.timeout(25_000)]) }); } catch (error) { proof.problem = codeOf(error); throw error; }
    proof.status = response.status;
    let raw: unknown = null;
    try { const text = await boundedText(response.clone(), 2_000_000); if (text) { raw = JSON.parse(text); proof.responseDigest = digest(raw); } } catch { proof.problem = "INVOICE_RESPONSE_UNREADABLE"; }
    const value = object(raw);
    if (response.ok && original) {
      try { proof.envelope = invoiceEnvelope(raw); proof.problem = invoiceEnvelopeProblem(draft, proof.envelope); } catch (error) { proof.problem = codeOf(error); }
      reads.set(original[1]!, { raw, envelope: proof.envelope, proof, status: typeof value?.status === "string" ? value.status : null });
    }
    if (response.ok && create && value) {
      if (typeof value.id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value.id)) allowed.add(value.id);
      if (typeof value.href === "string") try { const link = new URL(value.href), match = /^\/v2\/invoicing\/invoices\/([A-Za-z0-9._-]+)$/.exec(link.pathname); if (link.origin === "https://api-m.sandbox.paypal.com" && !link.search && !link.hash && !link.username && !link.password && match) allowed.add(match[1]!); } catch { /* Unknown creation remains held. */ }
    }
    if (response.ok && search && Array.isArray(value?.items)) for (const item of value.items) { const candidate = object(item), detail = object(candidate?.detail); if (detail?.invoice_number === draft.request.invoiceNumber && detail.reference === draft.request.reference && typeof candidate?.id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(candidate.id)) allowed.add(candidate.id); }
    return response;
  };
  const gateway = new SandboxCommerceRestGateway(configured.config, transport);
  let result: CommerceRestResult<InvoiceObservation> | null = null;
  try {
    if (grant?.operation === "create") result = await gateway.createInvoice(draft.request, signal);
    else if (grant && knownId) result = grant.operation === "send" ? await gateway.sendInvoice({ id: knownId, invoiceNumber: draft.request.invoiceNumber, reference: draft.request.reference }, signal) : await gateway.cancelInvoice({ id: knownId, invoiceNumber: draft.request.invoiceNumber, reference: draft.request.reference }, signal);
    else if (knownId) result = await gateway.getInvoice(knownId, signal);
    else { const search = await gateway.findInvoices(draft.request, signal); result = search.outcome === "succeeded" ? search.value.length === 1 ? { ...search, value: search.value[0]! } : { ...search, outcome: "unknown", code: "INVOICE_SEARCH_AMBIGUOUS", message: "The exact original invoice is not uniquely corroborated.", originalPayoutBatchId: null } : search; }
  } catch (error) { guardProblem = codeOf(error); }
  const observed = result?.outcome === "succeeded" ? result.value : null, saved = observed ? reads.get(observed.id) : knownId ? reads.get(knownId) : null;
  let problem = guardProblem ?? (observed && saved?.envelope ? validateInvoiceObservation(draft, observed, saved.envelope, knownId, grant?.expectedEnvelope ?? null) : saved?.proof.problem ?? "INVOICE_ORIGINAL_UNVERIFIED");
  if (observed && saved?.envelope && !problem && saved.proof.problem) problem = saved.proof.problem;
  const verified = Boolean(observed && saved?.envelope && saved.proof.responseDigest && !problem);
  return { outcome: guardProblem && !mutationAttempted ? "not_sent" : result?.outcome ?? "unknown", code: guardProblem ?? (result && result.outcome !== "succeeded" ? result.code : null), value: observed, raw: saved?.raw ?? null, rawDigest: saved?.proof.responseDigest ?? null, envelope: saved?.envelope ?? null, verified, problem: verified ? null : problem, transport: configured.mode, observedAt: result?.observedAt ?? new Date().toISOString(), httpStatus: result?.httpStatus ?? null, debugId: result?.debugId ?? null, mutationAttempted, proofs };
}
