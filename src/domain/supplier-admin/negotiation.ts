import type { NegotiationBounds } from "./contracts";

/** An offer must satisfy both separately reviewed mandates; no concession expands either authority. */
export function negotiateBounds(supplier: NegotiationBounds, producer: NegotiationBounds, request: { feeMinor: number; depositMinor: number; deliveryAt: string }, terms: { feeMinor: number; depositMinor: number; earliestDelivery: string; latestDelivery: string }) {
  const feeMinor = Math.max(request.feeMinor, supplier.feeMinMinor, producer.feeMinMinor);
  const depositMinor = Math.min(request.depositMinor, supplier.depositMaxMinor, producer.depositMaxMinor, terms.depositMinor);
  const delivery = Math.max(Date.parse(request.deliveryAt), Date.parse(supplier.earliestDelivery), Date.parse(producer.earliestDelivery), Date.parse(terms.earliestDelivery));
  const latest = Math.min(Date.parse(supplier.latestDelivery), Date.parse(producer.latestDelivery), Date.parse(terms.latestDelivery));
  if (feeMinor > Math.min(supplier.feeMaxMinor, producer.feeMaxMinor, terms.feeMinor) || depositMinor < Math.max(supplier.depositMinMinor, producer.depositMinMinor) || delivery > latest) return null;
  return { feeMinor, depositMinor, deliveryAt: new Date(delivery).toISOString() };
}
