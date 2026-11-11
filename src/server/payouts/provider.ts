import { SandboxCommerceRestGateway, type CommerceRestResult, type SandboxConfig } from "@fracture/paypal-core";
import { z } from "zod";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { PayoutData, PayoutResult, PayoutTransport, RecipientAdmission } from "@/domain/payouts/contracts";
import { merchantConfig } from "../payment-config";
import "../env";

const admissionSchema = z.object({ id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/), tenantId: z.uuid(), personId: z.string().min(1).max(120), label: z.string().trim().min(3).max(100), recipientType: z.enum(["EMAIL", "PAYPAL_ID"]), receiver: z.string().min(1).max(127).regex(/^[\x21-\x7e]+$/), merchantFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.iso.datetime(), maxPayoutMinor: z.number().int().min(1).max(10000000), controlledSandbox: z.literal(true) }).strict().superRefine((value, ctx) => { if (value.recipientType === "EMAIL" ? !z.email().safeParse(value.receiver).success : !/^[A-Za-z0-9._-]+$/.test(value.receiver)) ctx.addIssue({ code: "custom", message: "Invalid admitted recipient" }); });
export type PayoutAdmissionInput = z.infer<typeof admissionSchema>;
export interface PayoutFixtureRuntime { config: SandboxConfig; transport: typeof fetch; admissions: (show: ShowSnapshot) => PayoutAdmissionInput[]; gateway?: SandboxCommerceRestGateway }
const shared = globalThis as typeof globalThis & { openingNightPayoutFixture?: PayoutFixtureRuntime; openingNightPayoutGateway?: { key: string; gateway: SandboxCommerceRestGateway } };
const disabled = () => process.env.OPENING_NIGHT_AI_QA === "1" || process.env.OPENING_NIGHT_QA_FIXTURE === "1";
const noCredentials = () => ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID", "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET"].every(key => !process.env[key]);
export const payoutMerchantFingerprint = (config: SandboxConfig) => digest({ environment: config.environment, baseUrl: config.baseUrl, isolatedProject: config.isolatedProject, clientId: config.clientId });
function fixture() { if (!process.env.VERCEL && disabled() && noCredentials()) return shared.openingNightPayoutFixture; return undefined; }
/** Only a provider-disabled local process can install the real core's fake-fetch seam. */
export function installPayoutFixture(runtime: PayoutFixtureRuntime | undefined) {
  if (process.env.VERCEL || !disabled() || !noCredentials()) throw new Error("Payout fixtures require provider-disabled local isolation");
  if (runtime) shared.openingNightPayoutFixture = runtime; else delete shared.openingNightPayoutFixture;
}
function configuration() {
  const local = fixture(); if (local) return { config: local.config, transport: "local_fixture" as const };
  if (disabled()) throw new DomainError("PAYOUT_QA_DISABLED", "Actual payout providers are disabled in this rehearsal.", 403);
  return { config: merchantConfig("venue"), transport: "paypal_https" as const };
}
export function payoutCapability(show: ShowSnapshot): { capability: PayoutData["capability"]; admissions: RecipientAdmission[] } {
  try {
    const { config, transport } = configuration(), fingerprint = payoutMerchantFingerprint(config), local = fixture();
    const raw = local ? local.admissions(show) : JSON.parse(process.env.OPENING_NIGHT_PAYOUT_RECIPIENTS_JSON ?? "[]");
    const admitted = z.array(admissionSchema).max(200).parse(raw);
    if (new Set(admitted.map(item => item.id)).size !== admitted.length || admitted.some(item => item.merchantFingerprint !== fingerprint)) throw new Error("Invalid admission registry");
    const admissions = admitted.filter(item => item.tenantId === show.tenantId).map(item => ({ ...item, digest: digest(item) }));
    return { capability: { configured: true, mode: transport === "local_fixture" ? "controlled_fixture" : "live_sandbox", merchantFingerprint: fingerprint, message: admissions.length ? "Only these operator-admitted controlled sandbox accounts can be reviewed as recipients." : "No controlled sandbox recipients have been admitted for this production." }, admissions };
  } catch {
    return { capability: { configured: false, mode: disabled() ? "controlled_fixture" : "live_sandbox", merchantFingerprint: null, message: disabled() ? "Payout transport is disabled. This rehearsal has no controlled payout fixture." : "The isolated venue account and its exact controlled-recipient admissions need configuration." }, admissions: [] };
  }
}
export function payoutGateway(expectedFingerprint: string): { gateway: SandboxCommerceRestGateway; transport: PayoutTransport } {
  const { config, transport } = configuration();
  if (payoutMerchantFingerprint(config) !== expectedFingerprint) throw new DomainError("PAYOUT_MERCHANT_CHANGED", "The original payout belongs to a different isolated merchant. Restore its exact account before continuing.", 409);
  const local = fixture();
  if (local) return { gateway: local.gateway ??= new SandboxCommerceRestGateway(local.config, local.transport), transport };
  // Credential rotation replaces the cached client without changing merchant ownership.
  const key = digest(config); if (shared.openingNightPayoutGateway?.key !== key) shared.openingNightPayoutGateway = { key, gateway: new SandboxCommerceRestGateway(config) };
  return { gateway: shared.openingNightPayoutGateway.gateway, transport };
}
export function payoutResult<T>(result: CommerceRestResult<T>, transport: PayoutTransport): PayoutResult<T> {
  const metadata = { httpStatus: result.httpStatus, debugId: result.debugId, observedAt: result.observedAt, source: transport === "local_fixture" ? "sample" as const : "live_sandbox" as const, transport };
  return result.outcome === "succeeded" ? { ...metadata, outcome: result.outcome, value: result.value, recovered: result.recovered } : { ...metadata, outcome: result.outcome, code: /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : "PAYOUT_PROVIDER_UNVERIFIED", originalPayoutBatchId: result.originalPayoutBatchId };
}
export function interruptedPayout<T>(transport: PayoutTransport): PayoutResult<T> { return { outcome: "unknown", code: "PAYOUT_DISPATCH_INTERRUPTED", originalPayoutBatchId: null, httpStatus: null, debugId: null, observedAt: new Date().toISOString(), source: transport === "local_fixture" ? "sample" : "live_sandbox", transport }; }
