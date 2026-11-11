import type { ShowSnapshot, SupplierOffer } from "./contracts";

export const supplierIds = ["brightline", "northside", "sister"] as const;
export type SupplierId = typeof supplierIds[number];
export interface SupplierQuoteRef {
  id: string; termsDigest: string; issuedAt: string; validUntil: string;
  serviceId: string; source: "authenticated_fixture_service";
}
export interface SupplierQuote {
  schemaVersion: 1; id: string; tenantId: string; supplierId: SupplierId; revision: number;
  issuedAt: string; validUntil: string; offer: Omit<SupplierOffer, "serviceQuote">;
  equipment: { model: string; capabilityEvidence: string; driverEvidence: string | null; conditionEvidence: string | null };
  cancellation: string; source: "controlled_fixture"; termsDigest: string; signature: string;
}
export type RentalState = "held" | "awaiting_payment" | "authorized" | "confirmed" | "delivered" | "accepted" | "returned" | "returned_unaccepted" | "expired" | "reconfirmation_required" | "compensation_pending" | "cancelled" | "needs_attention";
export interface RentalExecution {
  schemaVersion: 1; id: string; planVersion: number; planDigest: string; quoteId: string; quoteDigest: string;
  offerId: string; offerRevision: number; supplierId: SupplierId; unitId: string; feeMinor: number; depositMinor: number;
  deliveryAt: string; windowEnd: string; createdAt: string; updatedAt: string; holdExpiresAt: string; state: RentalState;
  producerId: string; captureConsentAt: string; paymentRootId: string | null; authorizationId: string | null;
  captureIntentId: string | null; compensationIntentId: string | null; cancellationApprovedAt: string | null;
  deliveryId: string | null; deliveryVersion: number; acceptedAt: string | null; lastCode: string | null;
  rejectedReturn?: { deliveryId: string; deliveryVersion: number; recordedAt: string; actorId: string; detail: string };
  source: "controlled_fixture";
}
export interface DeliveryReceipt {
  id: string; executionId: string; tenantId: string; supplierId: SupplierId; unitId: string;
  version: number; planVersion: number; planDigest: string; nonceHash: string; issuedAt: string; expiresAt: string;
  state: "issued" | "scanned" | "accepted" | "rejected" | "revoked";
  scannedAt: string | null; scannedBy: string | null; acceptedAt: string | null; acceptedBy: string | null;
  condition: { report: string; powerOn: boolean; accessories: boolean; safeCondition: boolean } | null;
  source: "controlled_fixture";
}
export type PublicDeliveryReceipt = Omit<DeliveryReceipt, "nonceHash" | "scannedBy" | "acceptedBy" | "tenantId"> & { driver: string | null; inspector: string | null };
export interface DeliveryAccessData {
  revision: number; clock: string; show: string; venue: string; serverAt: string;
  actor: { label: string; canIssue: boolean; canScan: boolean; canInspect: boolean };
  execution: Pick<RentalExecution, "id" | "planVersion" | "supplierId" | "unitId" | "deliveryAt" | "feeMinor" | "depositMinor" | "state" | "deliveryVersion" | "lastCode">;
  delivery: PublicDeliveryReceipt | null;
  authorizationVerified: boolean; feeCaptured: boolean;
}

export function currentRentalExecution(show: ShowSnapshot) {
  return show.rentalExecutions?.find(execution => execution.planVersion === show.planVersion && execution.planDigest === show.approvedPlan?.digest) ?? null;
}
export function supplierIsConfirmed(show: ShowSnapshot) {
  const fact = show.facts.some(item => item.kind === "supplier_confirmed" && item.planVersion === show.planVersion);
  if (show.commercialProtocol !== 2) return fact;
  const execution = currentRentalExecution(show);
  return fact && Boolean(execution && ["confirmed", "delivered", "accepted", "returned"].includes(execution.state));
}
export function deliveryIsAccepted(show: ShowSnapshot) {
  const fact = show.facts.some(item => item.kind === "delivery_accepted" && item.planVersion === show.planVersion);
  if (show.commercialProtocol !== 2) return fact;
  const execution = currentRentalExecution(show);
  return fact && Boolean(execution?.acceptedAt && execution.deliveryId && ["accepted", "returned"].includes(execution.state));
}
