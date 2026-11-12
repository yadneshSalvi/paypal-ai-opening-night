import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DomainError } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { supplierIds, type RentalExecution, type SupplierId, type SupplierQuote } from "@/domain/supplier-contracts";
import { supplierDeclineCodes, type SupplierDecline } from "@/domain/supplier-recovery";
import { env } from "./env";
import { boundedText } from "./bounded-body";

export const supplierIdSchema = z.enum(supplierIds);
const revision = z.number().int().positive();
export const supplierRequestSchema = z.object({
  version: z.literal(1), requestId: z.uuid(), tenantId: z.uuid(), actorId: z.string().min(3).max(180),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("quote"), recoveryRfqId: z.uuid().optional() }).strict(),
    z.object({ type: z.literal("hold"), quoteId: z.uuid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: revision, acceptCaptureTerms: z.literal(true), producerAccess: z.object({ sessionHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.iso.datetime({ offset: true }) }).strict().optional() }).strict(),
    z.object({ type: z.enum(["confirm", "reconfirm"]), executionId: z.uuid(), expectedRevision: revision.optional() }).strict(),
    z.object({ type: z.literal("release"), executionId: z.uuid(), expectedRevision: revision }).strict(),
    z.object({ type: z.enum(["return", "return_rejected"]), executionId: z.uuid(), expectedRevision: revision, detail: z.string().trim().min(12).max(1200) }).strict(),
  ]),
}).strict();
export type SupplierRequest = z.infer<typeof supplierRequestSchema>;
export type SupplierResult = { kind: "quote"; quote: SupplierQuote } | { kind: "declined"; decline: SupplierDecline } | { kind: "execution"; execution: RentalExecution };
export interface SupplierResponse { version: 1; supplierId: SupplierId; requestId: string; result: SupplierResult; signature: string }
const pathFor = (supplier: SupplierId) => `/api/enrolled-suppliers/${supplier}/rpc`;
function signature(supplier: SupplierId, purpose: string, data: unknown) {
  // Independent service scopes and purpose separation; no credential is sent to a browser.
  const key = createHmac("sha256", env.sessionSecret).update(`opening-night:supplier:${supplier}:v1`).digest();
  return createHmac("sha256", key).update(purpose + ":" + digest(data)).digest("base64url");
}
function equal(actual: string | null, expected: string) {
  if (!actual || actual.length > 100) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function supplierHeaders(supplier: SupplierId, body: SupplierRequest, timestamp = new Date().toISOString()) {
  return { "Content-Type": "application/json", "X-Opening-Supplier": supplier, "X-Opening-Time": timestamp,
    "X-Opening-Signature": signature(supplier, "request", { method: "POST", path: pathFor(supplier), timestamp, body }) };
}
export function authenticateSupplierRequest(supplier: SupplierId, request: Request, body: SupplierRequest, now = Date.now()) {
  const timestamp = request.headers.get("x-opening-time");
  if (request.headers.get("x-opening-supplier") !== supplier || request.method !== "POST" || new URL(request.url).pathname !== pathFor(supplier) || !timestamp || timestamp.length > 40 || !Number.isFinite(Date.parse(timestamp)) || Math.abs(now - Date.parse(timestamp)) > 90000 || !equal(request.headers.get("x-opening-signature"), signature(supplier, "request", { method: "POST", path: pathFor(supplier), timestamp, body }))) throw new DomainError("SUPPLIER_AUTH_REQUIRED", "This supplier request needs a current signature for its enrolled service.", 401);
}
export function signSupplierQuote(quote: Omit<SupplierQuote, "signature">): SupplierQuote { return { ...quote, signature: signature(quote.supplierId, "quote", quote) }; }
export function verifySupplierQuote(quote: SupplierQuote) {
  const { signature: actual, ...content } = quote;
  return equal(actual, signature(quote.supplierId, "quote", content));
}
export function signSupplierResponse(supplierId: SupplierId, requestId: string, result: SupplierResult): SupplierResponse {
  const content = { version: 1 as const, supplierId, requestId, result };
  return { ...content, signature: signature(supplierId, "response", content) };
}
export function verifySupplierResponse(supplierId: SupplierId, request: SupplierRequest, response: SupplierResponse) {
  const { signature: actual, ...content } = response;
  if (response.version !== 1 || response.supplierId !== supplierId || response.requestId !== request.requestId || !equal(actual, signature(supplierId, "response", content))) throw new DomainError("SUPPLIER_RESPONSE_INVALID", "The supplier response could not be authenticated.", 502);
  if (response.result.kind === "quote" && (response.result.quote.tenantId !== request.tenantId || response.result.quote.supplierId !== supplierId || !verifySupplierQuote(response.result.quote))) throw new DomainError("SUPPLIER_RESPONSE_INVALID", "The quote does not belong to this supplier and rehearsal.", 502);
  if (response.result.kind === "declined" && (response.result.decline.tenantId !== request.tenantId || response.result.decline.supplierId !== supplierId || !supplierDeclineCodes.includes(response.result.decline.code) || !z.uuid().safeParse(response.result.decline.id).success || !Number.isFinite(Date.parse(response.result.decline.recordedAt)))) throw new DomainError("SUPPLIER_RESPONSE_INVALID", "The supplier's refusal does not match the original scope.", 502);
  if (request.action.type === "quote" ? !["quote", "declined"].includes(response.result.kind) : response.result.kind !== "execution") throw new DomainError("SUPPLIER_RESPONSE_INVALID", "The signed response does not match the original supplier action.", 502);
  return response.result;
}
export function supplierServiceOrigin() {
  const configured = process.env.SUPPLIER_SERVICE_BASE_URL ?? (env.isProduction ? process.env.APP_BASE_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL && "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL) : "http://localhost:4105");
  if (!configured) throw new DomainError("SUPPLIER_SERVICE_UNCONFIGURED", "The enrolled supplier service origin is not configured.", 503);
  const url = new URL(configured);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new DomainError("SUPPLIER_SERVICE_UNCONFIGURED", "The enrolled supplier service origin is invalid.", 503);
  return url.origin;
}
export type SupplierTransport = (request: Request) => Promise<Response>;
export async function callSupplierService(supplier: SupplierId, body: SupplierRequest, signal: AbortSignal, transport: SupplierTransport = request => fetch(request)) {
  const request = new Request(supplierServiceOrigin() + pathFor(supplier), { method: "POST", headers: supplierHeaders(supplier, body), body: JSON.stringify(body), signal, redirect: "error" });
  const response = await transport(request);
  const raw = await boundedText(response, 32000);
  if (Buffer.byteLength(raw, "utf8") > 32000) throw new DomainError("SUPPLIER_RESPONSE_INVALID", "The supplier response exceeds the agreed contract.", 502);
  const result = JSON.parse(raw);
  if (!response.ok) throw new DomainError(typeof result.code === "string" && /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : "SUPPLIER_UNAVAILABLE", typeof result.error === "string" && result.error.length < 500 ? result.error : "The enrolled supplier could not complete this step.", response.status >= 500 ? 503 : response.status);
  return verifySupplierResponse(supplier, body, result as SupplierResponse);
}
