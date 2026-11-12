import { AsyncLocalStorage } from "node:async_hooks";
import { assertActualProviderTenant } from "../judge/scope";
import * as nativeModule from "node:module";
import { AxiosError, AxiosHeaders, type AxiosAdapter } from "axios";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { toolkitRequestSchema, type InvoiceResult, type ToolkitReceipt, type WrapRecord } from "@/domain/wrap/contracts";
import { invoiceDraft, invoiceEnvelope, invoiceEnvelopeProblem, invoiceHistoryProblem, invoiceObservationFromRaw, ownedInvoiceId, validateInvoiceObservation, wrapRecords } from "@/domain/wrap/invoices";
import { boundedText } from "../bounded-body";
import type { SettlementAuthority } from "../settlement/service";
import { wrapProviderConfiguration } from "./provider";
import { toolkitResources, wrapData, wrapReceipt } from "./service";
import { appendWrapRecord, assertWrapAuthority, bindInvoiceResource, readWrapState, wrapRequestHash, wrapShow, wrapTransaction } from "./store";

type ReadTool = ToolkitReceipt["tool"];
interface ToolkitScope { path: string; fetch: typeof fetch; signal: AbortSignal; authorize: () => Promise<void>; evidence: ToolkitReceipt["evidence"]; raw: unknown | null; count: number }
const invocation = new AsyncLocalStorage<ToolkitScope>();
// Toolkit 1.11.0 is a CommonJS bundle. Its axios instance is distinct from axios's ESM entry.
// Resolve through the actual installed public Toolkit export so the guard covers its real calls.
// Reflect.apply preserves native Node resolution in both webpack server chunks and tsx.
// A bundler-rewritten require would not prove the official CJS Toolkit instance.
const packageRequire = Reflect.apply(Reflect.get(nativeModule, "createRequire"), undefined, [`${process.cwd()}/package.json`]) as NodeRequire;
const toolkitRequire = Reflect.apply(Reflect.get(nativeModule, "createRequire"), undefined, [packageRequire.resolve("@paypal/agent-toolkit/openai")]) as NodeRequire;
const axios = toolkitRequire("axios") as typeof import("axios").default;
/** The upstream Toolkit's action configuration filters its catalog, not dispatch. Every call is gated here. */
const interceptorId = axios.interceptors.request.use(config => {
  const scope = invocation.getStore(); if (!scope) return config;
  const adapter: AxiosAdapter = async request => {
    const url = new URL(request.url!, request.baseURL), method = (request.method ?? "GET").toUpperCase(), oauth = url.pathname === "/v1/oauth2/token" && method === "POST";
    if (url.origin !== "https://api.sandbox.paypal.com" || url.username || url.password || url.hash || url.search || request.params && Object.keys(request.params).length || !oauth && (method !== "GET" || url.pathname !== scope.path) || ++scope.count > 2) throw new DomainError("TOOLKIT_TRANSPORT_SCOPE", "The installed Toolkit attempted a call outside this exact owned read.", 403);
    await scope.authorize();
    const headers = new Headers(); for (const [key, value] of Object.entries(AxiosHeaders.from(request.headers).toJSON())) if (value !== null && value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    const response = await scope.fetch(url.href, { method, headers, ...(request.data === undefined ? {} : { body: String(request.data) }), signal: scope.signal, redirect: "error" }), text = await boundedText(response, 2_000_000);
    let raw: unknown = null; try { raw = text ? JSON.parse(text) : null; } catch { /* A non-JSON response is never accepted as accounting evidence. */ }
    if (!oauth) { scope.raw = raw; scope.evidence.push({ path: url.pathname, status: response.status, rawDigest: digest(raw ?? text), observedAt: new Date().toISOString() }); }
    const result = { data: text, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), config: request, request: { scoped: true } };
    if (request.validateStatus && !request.validateStatus(response.status)) throw new AxiosError("The scoped provider read did not succeed", "ERR_BAD_RESPONSE", request, undefined, result);
    return result;
  };
  config.adapter = adapter; config.maxRedirects = 0; config.timeout = 25_000; return config;
});
function assertToolkitBoundary(mode: "paypal_https" | "local_fixture") {
  const manager = axios.interceptors.request as typeof axios.interceptors.request & { handlers: ({ fulfilled: unknown } | null)[] };
  if (toolkitRequire("axios") !== axios || typeof manager.handlers[interceptorId]?.fulfilled !== "function") throw new DomainError("TOOLKIT_GUARD_MISSING", "The exact installed Toolkit transport guard is unavailable.", 503);
  if (mode === "local_fixture") {
    const guard = (globalThis as typeof globalThis & { openingNightProviderEgressGuard?: { version: number; fetch: boolean; nodeHttp: boolean; nodeHttps: boolean } }).openingNightProviderEgressGuard;
    if (process.env.VERCEL || process.env.OPENING_NIGHT_QA_FIXTURE !== "1" || !guard || guard.version !== 2 || !guard.fetch || !guard.nodeHttp || !guard.nodeHttps || ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET", "OPENAI_API_KEY", "GEMINI_API_KEY"].some(key => Boolean(process.env[key]))) throw new DomainError("TOOLKIT_FIXTURE_BOUNDARY", "Controlled Toolkit construction requires blank credentials and all provider-egress guards.", 503);
  }
}
function toolInput(tool: ReadTool, id: string): Record<string, string> { return tool === "get_invoice" ? { invoice_id: id } : tool === "get_refund" ? { refund_id: id } : { id }; }
function toolPath(tool: ReadTool, id: string) { return `${tool === "get_invoice" ? "/v2/invoicing/invoices" : tool === "get_refund" ? "/v2/payments/refunds" : "/v2/checkout/orders"}/${encodeURIComponent(id)}`; }
function providerId(state: Parameters<typeof ownedInvoiceId>[0], tool: ReadTool, key: string) { if (tool === "get_invoice") return ownedInvoiceId(state, key.slice("invoice:".length)); return key.slice(key.indexOf(":") + 1); }
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
type ToolkitClaim = Extract<WrapRecord, { kind: "toolkit_request" }>;
export async function executeToolkit(authority: SettlementAuthority, raw: unknown, readGuard?: () => Promise<void>) {
  // A guided demonstration has only replayed resources; the Agent Toolkit is never called for it.
  await assertActualProviderTenant(authority.actor.tenantId);
  await readGuard?.();
  const request = toolkitRequestSchema.parse(raw), requestBody = { action: "toolkit_read", request }, hash = wrapRequestHash(authority, requestBody);
  const prepared = await wrapTransaction(async db => {
    const show = await wrapShow(db, authority.actor.tenantId, true); await assertWrapAuthority(db, authority, show); const state = await readWrapState(db, show), previous = (await db.query<{ payload_hash: string }>("SELECT payload_hash FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [show.tenantId, request.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.payload_hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This read identity belongs to different instructions or access.");
      const claim = wrapRecords(state, "toolkit_request").find(record => record.commandId === request.idempotencyKey); if (!claim) throw new DomainError("TOOLKIT_CLAIM_UNAVAILABLE", "The retained read claim cannot be verified.", 503);
      return { claim, inserted: false };
    }
    const data = await wrapData(db, show, state, authority), resource = toolkitResources(show, state).find(item => item.key === request.resourceKey && item.tool === request.tool), id = resource ? providerId(state, request.tool, resource.key) : null, configured = wrapProviderConfiguration();
    if (state.revision !== request.expectedRevision || show.revision !== request.expectedShowRevision || data.report.contentDigest !== request.reportDigest) throw new DomainError("TOOLKIT_REVIEW_STALE", "The selected report changed. Refresh before reading its original resource.");
    if (!resource || !id || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new DomainError("TOOLKIT_RESOURCE_DENIED", "The requested resource is not an original resource owned by this production.", 403);
    const next = await appendWrapRecord(db, show, state, { kind: "toolkit_request", tool: request.tool, resourceKey: resource.key, providerId: id, inputDigest: digest(toolInput(request.tool, id)), reportDigest: request.reportDigest, merchantFingerprint: configured.fingerprint, authority: { actor: authority.actor, sessionHash: authority.sessionHash } }, { request: requestBody, authority, commandId: request.idempotencyKey });
    return { claim: next.record as ToolkitClaim, inserted: true };
  });
  const { claim } = prepared;
  if (prepared.inserted) {
    let evidence: ToolkitReceipt["evidence"] = [], data: unknown = null, verified = false, mode: "paypal_https" | "local_fixture" = "local_fixture", summary = "The original scoped read could not be verified. It supplied no fee or collection evidence.";
    try {
      const configured = wrapProviderConfiguration(claim.merchantFingerprint); mode = configured.mode;
      const authorize = async () => { await readGuard?.(); await wrapTransaction(async db => { const show = await wrapShow(db, authority.actor.tenantId); await assertWrapAuthority(db, authority, show); const state = await readWrapState(db, show), resource = toolkitResources(show, state).find(item => item.key === claim.resourceKey && item.tool === claim.tool); if (!resource || providerId(state, claim.tool, claim.resourceKey) !== claim.providerId) throw new DomainError("TOOLKIT_RESOURCE_CHANGED", "The original resource is no longer verifiable under this production.", 403); }); };
      const scope: ToolkitScope = { path: toolPath(claim.tool, claim.providerId), fetch: configured.toolkitTransport, signal: AbortSignal.timeout(25_000), authorize, evidence, raw: null, count: 0 };
      assertToolkitBoundary(configured.mode);
      await authorize();
      const toolkit = new PayPalAgentToolkit({ clientId: configured.config.clientId, clientSecret: configured.config.clientSecret, configuration: { context: { sandbox: true, debug: false }, actions: { invoices: { get: true }, orders: { get: true }, payments: { getRefunds: true } } } });
      const tools = toolkit.getTools();
      if (tools.length !== 3 || !tools.every(tool => ["get_invoice", "get_order", "get_refund"].includes(tool.function.name)) || !tools.some(tool => tool.function.name === claim.tool)) throw new DomainError("TOOLKIT_CATALOG_CHANGED", "The installed official Toolkit catalog differs from its qualified read contract.", 503);
      const result = await invocation.run(scope, () => toolkit.handleToolCall({ id: claim.id, type: "function", function: { name: claim.tool, arguments: JSON.stringify(toolInput(claim.tool, claim.providerId)) } }));
      data = scope.raw; evidence = scope.evidence;
      const output: unknown = typeof result.content === "string" ? JSON.parse(result.content) : null;
      verified = evidence.length === 1 && evidence[0]!.status >= 200 && evidence[0]!.status < 300 && object(data)?.id === claim.providerId && digest(output) === digest(data);
      if (verified && claim.tool === "get_invoice") await wrapTransaction(async db => { const show = await wrapShow(db, authority.actor.tenantId); await assertWrapAuthority(db, authority, show); const state = await readWrapState(db, show), draft = invoiceDraft(state, claim.resourceKey.slice("invoice:".length)); if (invoiceEnvelopeProblem(draft, invoiceEnvelope(data))) verified = false; });
      summary = verified ? `Official PayPal Agent Toolkit 1.11.0 read the exact owned ${claim.tool.slice(4)}. Its original response and digest are retained. No provider mutation occurred.` : summary;
    } catch (error) { summary = error instanceof DomainError ? `${error.code}: the scoped read was refused or unverified. No provider mutation occurred.` : summary; }
    await wrapTransaction(async db => {
      const show = await wrapShow(db, authority.actor.tenantId, true), state = await readWrapState(db, show);
      if (!wrapRecords(state, "toolkit_read").some(record => record.requestId === claim.id)) {
        const next = await appendWrapRecord(db, show, state, { kind: "toolkit_read", requestId: claim.id, tool: claim.tool, resourceKey: claim.resourceKey, providerId: claim.providerId, inputDigest: claim.inputDigest, reportDigest: claim.reportDigest, outcome: verified ? "verified_read" : "unverified", transport: mode, responseDigest: data === null ? null : digest(data), data, summary, evidence }, { request: { requestId: claim.id, inputDigest: claim.inputDigest }, semanticKey: claim.id });
        if (claim.tool === "get_invoice") {
          const draft = invoiceDraft(state, claim.resourceKey.slice("invoice:".length));
          let result: InvoiceResult = { outcome: "unknown", code: "TOOLKIT_INVOICE_UNVERIFIED", value: null, raw: data, rawDigest: data === null ? null : digest(data), envelope: null, verified: false, problem: "The latest original Toolkit read could not corroborate this invoice.", transport: mode, observedAt: evidence.at(-1)?.observedAt ?? new Date().toISOString(), httpStatus: evidence.at(-1)?.status ?? null, debugId: null, mutationAttempted: false, proofs: [] };
          if (verified) try {
            const observed = invoiceObservationFromRaw(data), envelope = invoiceEnvelope(data), problem = validateInvoiceObservation(draft, observed, envelope, claim.providerId) ?? invoiceHistoryProblem(state, draft.id, observed);
            result = { ...result, outcome: "succeeded", code: null, value: observed, envelope, verified: problem === null, problem };
            if (!problem) for (const [kind, items] of [["invoice_payment", observed.payments], ["invoice_refund", observed.refunds]] as const) for (const item of items) if (item.id) await bindInvoiceResource(db, { merchant: claim.merchantFingerprint, kind, providerId: item.id, tenantId: show.tenantId, invoiceId: draft.id });
          } catch (error) { result = { ...result, verified: false, problem: error instanceof DomainError ? error.code : "The Toolkit invoice payment fields could not be verified." }; }
          await appendWrapRecord(db, next.show, next.state, { kind: "invoice_read", invoiceId: draft.id, grantId: null, result }, { request: { toolkitReceiptId: next.record.id, requestId: claim.id }, semanticKey: `toolkit:${claim.id}` });
        }
      }
    });
  }
  return wrapTransaction(async db => { const show = await wrapShow(db, authority.actor.tenantId); await assertWrapAuthority(db, authority, show); const state = await readWrapState(db, show), receipt = wrapRecords(state, "toolkit_read").find(record => record.requestId === claim.id); return { data: await wrapData(db, show, state, authority), receipt: receipt ? { ...wrapReceipt(receipt), tool: receipt.tool, providerId: receipt.providerId, transport: receipt.transport, outcome: receipt.outcome, summary: receipt.summary, responseDigest: receipt.responseDigest } : null, replayed: !prepared.inserted, pending: !receipt }; });
}
