"use client";
import { useId, useState, type FormEvent } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Modal, Badge, Button } from "../ui";
import { atVenue, formatMoney, localTime, plusMinutes } from "@/domain/time";
import { supplierAdminCommandSchema, type SupplierAdminCommand } from "@/domain/supplier-admin/commands";
import type { AdminWorkspace, ManagedSupplierId, Revocation } from "@/domain/supplier-admin/contracts";

export interface AdminReviewAction { type: SupplierAdminCommand["type"]; supplierId?: ManagedSupplierId; unitId?: string; rfqId?: string; roundId?: string; executionId?: string; targetId?: string; targetKind?: Revocation["targetKind"] }
const titles: Record<AdminReviewAction["type"], string> = { invite: "Open separate supplier access", admit: "Accept supplier admission", rotate_key: "Publish an independent signing key", inventory: "Publish an owned inventory edition", terms: "Publish immutable supplier terms", supplier_mandate: "Review supplier negotiation bounds", request_quotes: "Review producer negotiation bounds", negotiate: "Request a bounded signed reply", accept_quote: "Admit this exact signed quote", reserve: "Reserve the separately approved unit", release: "Release the original provisional hold", revoke: "Revoke future authority" };
function venueValue(instant: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
const instant = (value: string) => { const [day, time] = value.split("T"); if (!day || !time) throw new Error("Review each delivery date and time."); return atVenue(time, day); };
const dollars = (minor: number) => (minor / 100).toFixed(2);
function cents(value: string) { if (!/^\d{1,5}(\.\d{1,2})?$/.test(value)) throw new Error("Amounts need dollars and at most two decimal places."); const [whole, fraction = ""] = value.split("."); return Number(whole) * 100 + Number(fraction.padEnd(2, "0")); }
function Field({ label, value, onChange, type = "text", maxLength = 1200, min, max, step, hint }: { label: string; value: string; onChange: (value: string) => void; type?: string; maxLength?: number; min?: string; max?: string; step?: string; hint?: string }) {
  const id = useId(); return <label className="sa-field" htmlFor={id}><span>{label}</span><input id={id} type={type} value={value} onChange={event => onChange(event.target.value)} maxLength={maxLength} required min={min} max={max} step={step} />{hint && <small>{hint}</small>}</label>;
}
export function SupplierAdminReviewForm({ action, workspace, busy, onClose, onSubmit, fallbackFocus }: { action: AdminReviewAction; workspace: AdminWorkspace; busy: boolean; onClose: () => void; onSubmit: (command: SupplierAdminCommand, reviewed: AdminWorkspace) => Promise<void>; fallbackFocus?: () => HTMLElement | null }) {
  // Review inputs never silently adopt a later response, session or source.
  const [reviewed] = useState(workspace), card = reviewed.cards.find(value => value.id === action.supplierId);
  const unit = card?.units.find(value => value.inventory.unitId === action.unitId) ?? card?.units.at(-1), inventory = unit?.inventory, terms = unit?.terms;
  const rfq = card?.rfqs.find(value => value.id === action.rfqId), round = rfq?.rounds.find(value => value.id === action.roundId), quote = round?.data.outcome.kind === "quote" ? round.data.outcome.quote : null;
  const supplier = reviewed.role === "supplier", mandate = card?.mandates.findLast(value => value.active && value.data.inventoryId === inventory?.id);
  const [values, setValues] = useState<Record<string, string>>(() => ({
    name: "", reference: "", detail: "", unitId: action.unitId ? inventory?.unitId ?? "" : "", label: action.unitId ? inventory?.label ?? "" : "", model: action.unitId ? inventory?.model ?? "" : "",
    from: venueValue(action.unitId ? inventory?.availableFrom ?? reviewed.clock : reviewed.clock), until: venueValue(action.unitId ? inventory?.availableUntil ?? reviewed.accessUntil : reviewed.accessUntil),
    capability: action.unitId ? inventory?.capabilityEvidence ?? "" : "", driver: action.unitId ? inventory?.driverEvidence ?? "" : "", condition: action.unitId ? inventory?.conditionEvidence ?? "" : "",
    fee: dollars(terms?.feeMinor ?? 48000), deposit: dollars(terms?.depositMinor ?? 30000),
    earliest: venueValue(terms?.earliestDelivery ?? plusMinutes(reviewed.clock, 20)), latest: venueValue(terms?.latestDelivery ?? plusMinutes(reviewed.clock, 40)), deadline: venueValue(terms?.scenarioDeadline ?? plusMinutes(reviewed.clock, 10)),
    cancellation: "", valid: "15", feeMin: dollars(supplier ? terms?.feeMinor ?? 48000 : 0), feeMax: dollars(terms?.feeMinor ?? 48000), depositMin: dollars(supplier ? terms?.depositMinor ?? 30000 : 0), depositMax: dollars(terms?.depositMinor ?? 30000), rounds: "2",
    requestFee: dollars(rfq?.data.bounds.feeMaxMinor ?? terms?.feeMinor ?? 48000), requestDeposit: dollars(rfq?.data.bounds.depositMaxMinor ?? terms?.depositMinor ?? 30000), requestDelivery: venueValue(rfq?.data.bounds.earliestDelivery ?? terms?.earliestDelivery ?? plusMinutes(reviewed.clock, 20)),
  }));
  const [confirmed, setConfirmed] = useState(false), [owned, setOwned] = useState(false), [available, setAvailable] = useState(action.unitId ? inventory?.available ?? false : false), [compatible, setCompatible] = useState(action.unitId ? inventory?.compatible ?? false : false);
  const [driver, setDriver] = useState(action.unitId && inventory?.qualifiedDriver === true ? "yes" : "unknown"), [condition, setCondition] = useState(action.unitId && inventory?.conditionVerified === true ? "yes" : "unknown"), [error, setError] = useState("");
  const change = (name: string) => (value: string) => setValues(current => ({ ...current, [name]: value }));
  const moneyField = (label: string, name: string) => <Field label={label} value={values[name]!} onChange={change(name)} type="number" min="0" max="10000" step="0.01" />;
  const timeField = (label: string, name: string) => <Field label={`${label} · Chicago`} value={values[name]!} onChange={change(name)} type="datetime-local" />;
  const bounds = () => ({ feeMinMinor: cents(values.feeMin!), feeMaxMinor: cents(values.feeMax!), depositMinMinor: cents(values.depositMin!), depositMaxMinor: cents(values.depositMax!), earliestDelivery: instant(values.earliest!), latestDelivery: instant(values.latest!), maxRounds: Number(values.rounds) });
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !confirmed) return; setError("");
    try {
      let command: unknown; const type = action.type, supplierId = card?.id;
      if (type === "invite") command = { type, name: values.name, reference: values.reference, detail: values.detail, reviewDigest: reviewed.reviewDigest, confirmed: true };
      else if (type === "admit") command = { type, supplierId, enrollmentId: card!.enrollmentId, detail: values.detail, confirmed: true };
      else if (type === "rotate_key") command = { type, supplierId, previousKeyId: card!.key?.id ?? null, detail: values.detail, confirmed: true };
      else if (type === "inventory") command = { type, supplierId, previousId: action.unitId ? inventory?.id ?? null : null, unitId: values.unitId, label: values.label, model: values.model, owned, available,
        availableFrom: instant(values.from!), availableUntil: instant(values.until!), compatible, qualifiedDriver: driver === "unknown" ? null : driver === "yes", conditionVerified: condition === "unknown" ? null : condition === "yes", capabilityEvidence: values.capability, driverEvidence: driver === "yes" ? values.driver : null, conditionEvidence: condition === "yes" ? values.condition : null, reference: values.reference, detail: values.detail, confirmed: true };
      else if (type === "terms") command = { type, supplierId, previousId: terms?.id ?? null, inventoryId: inventory?.id, feeMinor: cents(values.fee!), depositMinor: cents(values.deposit!), earliestDelivery: instant(values.earliest!), latestDelivery: instant(values.latest!), scenarioDeadline: instant(values.deadline!), validForMinutes: Number(values.valid), cancellation: values.cancellation, reference: values.reference, detail: values.detail, confirmed: true };
      else if (type === "supplier_mandate") command = { type, supplierId, inventoryId: inventory?.id, termsId: terms?.id, keyId: card?.key?.id, bounds: bounds(), validForMinutes: Number(values.valid), detail: values.detail, confirmed: true };
      else if (type === "request_quotes") command = { type, supplierId, supplierMandateId: mandate?.id, reviewDigest: reviewed.reviewDigest, bounds: bounds(), validForMinutes: Number(values.valid), detail: values.detail, confirmed: true };
      else if (type === "negotiate") command = { type, supplierId, rfqId: rfq?.id, previousRoundId: rfq?.rounds.at(-1)?.id ?? null, feeMinor: cents(values.requestFee!), depositMinor: cents(values.requestDeposit!), deliveryAt: instant(values.requestDelivery!), confirmed: true };
      else if (type === "accept_quote") command = { type, supplierId, rfqId: rfq?.id, roundId: round?.id, quoteDigest: quote?.termsDigest, confirmed: true };
      else if (type === "reserve") command = { type, supplierId, quoteId: quote?.id, planDigest: reviewed.currentPlan?.digest, acceptCaptureTerms: true, confirmed: true };
      else if (type === "release") command = { type, supplierId, executionId: action.executionId, confirmed: true };
      else command = { type, supplierId, targetId: action.targetId, targetKind: action.targetKind, reason: values.detail, confirmed: true };
      const parsed = supplierAdminCommandSchema.safeParse(command);
      if (!parsed.success) throw new Error("Review the required source details, amounts, times and confirmation. Each evidence description needs at least twelve characters.");
      await onSubmit(parsed.data, reviewed);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "This exact review could not be prepared."); }
  }
  const evidenceFields = ["invite", "admit", "rotate_key", "inventory", "terms", "supplier_mandate", "request_quotes", "revoke"].includes(action.type);
  return <Modal title={titles[action.type]} onClose={onClose} dismissible={!busy} {...(fallbackFocus ? { fallbackFocus } : {})}><form className="sa-review" onSubmit={event => void submit(event)}>
    <Badge tone="amber">DECLARED CONTROLLED SUPPLIER</Badge><p>{card?.name ?? "A separate owner accepts admission before publishing inventory or signing replies."}</p>
    <div className="sa-review-source"><ShieldCheck size={18} /><span>Reviewing production revision {reviewed.revision}. All expiry limits stay fixed. New terms do not release an earlier rental.</span></div>
    {action.type === "invite" && <Field label="Supplier name" value={values.name!} onChange={change("name")} maxLength={100} />}
    {action.type === "inventory" && <>
      <Field label="Exact owned unit identity" value={values.unitId!} onChange={change("unitId")} maxLength={80} hint="Use a stable identity. Earlier units and commitments cannot be renamed." />
      <Field label="Inventory label" value={values.label!} onChange={change("label")} maxLength={120} /><Field label="Equipment model" value={values.model!} onChange={change("model")} maxLength={180} />
      <label className="sa-check"><input type="checkbox" checked={owned} onChange={event => setOwned(event.target.checked)} /><span>I declare that this supplier owns this individually identified controlled unit.</span></label>
      <label className="sa-check"><input type="checkbox" checked={available} onChange={event => setAvailable(event.target.checked)} /><span>Offer this unit for future requests. Existing reservations stay separate.</span></label>
      <div className="sa-fields">{timeField("Available from", "from")}{timeField("Available until", "until")}</div>
      <label className="sa-check"><input type="checkbox" checked={compatible} onChange={event => setCompatible(event.target.checked)} /><span>Declared compatible with this production's equipment requirements.</span></label>
      <Field label="Capability source and evidence" value={values.capability!} onChange={change("capability")} />
      <label className="sa-field"><span>Qualified driver evidence</span><select value={driver} onChange={event => setDriver(event.target.value)}><option value="unknown">Unknown · blocks a quote</option><option value="yes">Declared source available</option><option value="no">Not available</option></select></label>
      {driver === "yes" && <Field label="Driver source and attribution" value={values.driver!} onChange={change("driver")} />}
      <label className="sa-field"><span>Condition evidence</span><select value={condition} onChange={event => setCondition(event.target.value)}><option value="unknown">Unknown · blocks a quote</option><option value="yes">Declared source available</option><option value="no">Not acceptable</option></select></label>
      {condition === "yes" && <Field label="Condition source and attribution" value={values.condition!} onChange={change("condition")} />}
    </>}
    {action.type === "terms" && <><p>Exact inventory: <b>{inventory?.label ?? "Publish owned inventory first"}</b> · {inventory?.unitId}</p><div className="sa-fields">{moneyField("Rental fee · USD", "fee")}{moneyField("Separate deposit · USD", "deposit")}{timeField("Earliest delivery", "earliest")}{timeField("Latest delivery", "latest")}{timeField("Scenario order deadline", "deadline")}</div><Field label="Cancellation conditions" value={values.cancellation!} onChange={change("cancellation")} /></>}
    {["supplier_mandate", "request_quotes"].includes(action.type) && <><p>{supplier ? "Delegate only these supplier bounds to the local signed service." : "Review your separate commercial bounds. A reply may counter within them; it still needs your explicit admission."}</p><div className="sa-fields">{moneyField("Minimum fee · USD", "feeMin")}{moneyField("Maximum fee · USD", "feeMax")}{moneyField("Minimum deposit · USD", "depositMin")}{moneyField("Maximum deposit · USD", "depositMax")}{timeField("Earliest delivery", "earliest")}{timeField("Latest delivery", "latest")}<Field label="Maximum rounds" value={values.rounds!} onChange={change("rounds")} type="number" min="1" max="3" step="1" /></div></>}
    {["terms", "supplier_mandate", "request_quotes"].includes(action.type) && <Field label="Real-time validity · minutes" value={values.valid!} onChange={change("valid")} type="number" min="1" max={action.type === "terms" ? "60" : "15"} step="1" hint="Clipped to the original access and source expiries. Reading or retrying never extends it." />}
    {action.type === "negotiate" && <><p>Original request: round {(rfq?.rounds.length ?? 0) + 1} of at most {rfq?.roundLimit}. Fixed expiry {rfq ? new Date(rfq.data.expiresAt).toLocaleString() : "unavailable"}.</p><div className="sa-fields">{moneyField("Requested fee · USD", "requestFee")}{moneyField("Maximum accepted deposit · USD", "requestDeposit")}{timeField("Requested delivery", "requestDelivery")}</div></>}
    {["accept_quote", "reserve"].includes(action.type) && quote && <div className="sa-quote-summary"><strong>{formatMoney(quote.offer.feeMinor, true)}</strong><span>{formatMoney(quote.offer.depositMinor, true)} separate deposit · delivery {localTime(quote.offer.deliveryAt)} Chicago</span><p>{action.type === "accept_quote" ? "This enters the real planner. Engine validation, a separate plan approval and a provisional hold still follow." : `This reserves only the exact unit in approved plan v${reviewed.currentPlan?.planVersion}. Actual checkout is unavailable without a matching verified merchant adapter.`}</p><code>{quote.termsDigest}</code></div>}
    {action.type === "release" && <p>The original reservation service checks that this is an unpaid provisional hold before releasing capacity. A payment or fulfillment history blocks this action.</p>}
    {action.type === "revoke" && <p>Revoke this original {action.targetKind?.replaceAll("_", " ")}. Earlier signatures remain verifiable and all commitments remain retained.</p>}
    {["invite", "inventory", "terms"].includes(action.type) && <Field label="Source reference" value={values.reference!} onChange={change("reference")} maxLength={180} />}
    {evidenceFields && <label className="sa-field"><span>{action.type === "revoke" ? "Reason for revoking future authority" : "Attribution and review detail"}</span><textarea rows={3} required minLength={12} maxLength={1200} value={values.detail!} onChange={event => change("detail")(event.target.value)} /></label>}
    <label className="sa-check sa-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I reviewed this exact instruction and its bounds. The identity and operational evidence are declared controlled data; this creates no actual payment, external identity verification or physical sign-off.</span></label>
    {error && <p role="alert" className="sa-alert">{error}</p>}<div className="modal-actions"><Button disabled={busy} onClick={onClose}>Keep reviewing</Button><button type="submit" className="button primary" disabled={busy || !confirmed} aria-busy={busy}>{busy ? "Saving original instruction…" : "Confirm exact instruction"}<ArrowRight size={16} /></button></div>
  </form></Modal>;
}
