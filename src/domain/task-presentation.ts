import type { ConsoleData, OperationalFact, ShowSnapshot, Task } from "./contracts";
import { currentActual } from "./finance";
import { currentRentalClearance } from "./crew/policy";

export interface TaskExecutionPresentation {
  label: string;
  source: string;
  tone: "amber" | "green" | "muted";
}

/** Completion and provenance are independent: a fixture can be accepted and a real receipt can be complete. */
export function taskExecutionPresentation(show: ShowSnapshot, task: Task, presentation: Pick<ConsoleData, "crew" | "controlledQa"> = {}): TaskExecutionPresentation {
  const replay = (presentation as { demonstration?: boolean }).demonstration === true;
  if (task.cancellation) return { label: "Cancelled", source: "Producer operating notice; original call and earned-work history retained", tone: "amber" };
  if (task.state !== "complete") return { label: task.state === "blocked" ? "Blocked" : "Planned", source: "Awaiting execution evidence", tone: task.state === "blocked" ? "amber" : "muted" };

  const actual = currentActual(show).filter(receipt => receipt.planVersion === show.planVersion);
  const rental = show.crewProtocol === 1 ? currentRentalClearance(show) : null;
  const authorization = rental ? rental.authorization : actual.find(receipt => receipt.kind === "authorization" && receipt.purpose === "rental" && receipt.amountMinor === 78000);
  const capture = rental ? rental.capture : authorization && actual.find(receipt => receipt.kind === "capture" && receipt.purpose === "rental" && receipt.parentId === authorization.providerResourceId && receipt.amountMinor === 48000);
  if (task.id === "rental-authorized" && authorization) return { label: replay ? "Replayed authorization" : presentation.controlledQa ? "Fixture authorization" : "Authorized", source: replay ? "Replayed outcome; no PayPal request is made" : presentation.controlledQa ? "Controlled financial input; no provider qualification" : "Verified PayPal sandbox receipt", tone: presentation.controlledQa || replay ? "amber" : "green" };
  if (task.id === "rental-captured" && capture) return { label: replay ? "Replayed capture" : presentation.controlledQa ? "Fixture capture" : "Captured", source: replay ? "Replayed outcome; no PayPal request is made" : presentation.controlledQa ? "Controlled financial input; no provider qualification" : "Verified PayPal sandbox receipt", tone: presentation.controlledQa || replay ? "amber" : "green" };

  const operational: Record<string, { kind: OperationalFact["kind"]; label: string }> = {
    "rental-delivery": { kind: "delivery_accepted", label: "Accepted" },
    "lx-focus": { kind: "focus_signed_off", label: "Signed off" },
    "lx-program": { kind: "cue_signed_off", label: "Signed off" },
    "headliner-arrival": { kind: "headliner_checkin", label: "Checked in" },
    "quiet-prep": { kind: "quiet_prep", label: "Complete" },
    changeover: { kind: "changeover", label: "Complete" },
  };
  const operation = operational[task.id];
  const signed = operation && presentation.crew?.duties.find(duty => duty.kind === operation.kind)?.record;
  if (show.crewProtocol === 1 && operation && signed?.status === "current") return { label: operation.label, source: "Signed personal crew record · controlled participation", tone: "green" };
  const fact = operation && show.facts.find(item => item.planVersion === show.planVersion && item.kind === operation.kind);
  if (operation && fact) return { label: operation.label, source: fact.source === "sample" ? "Controlled fixture record" : fact.source === "replay" ? "Replayed operation record" : fact.source === "modelled" ? "Modelled operation record" : "Sandbox-linked operation record", tone: "green" };
  if (task.id === "readiness") return { label: "Ready", source: "Computed from current evidence", tone: "green" };
  if (task.id === "doors" && show.state === "house_open") return { label: "House open", source: presentation.crew?.cues.find(cue => cue.kind === "HOUSE_OPEN")?.record?.status === "current" ? "Signed personal FOH cue · controlled participation" : "Controlled front-of-house confirmation", tone: "green" };
  return { label: "Complete", source: "Sample preparation checklist", tone: "muted" };
}

/** Proof card for a payment diamond on the money lane. It states only what a stored receipt establishes. */
export interface PaymentProof { type: "Rental authorization" | "Rental fee capture"; amountMinor: number | null; status: string; redactedId: string | null; provenance: string; settled: boolean }
export function paymentProof(show: ShowSnapshot, task: Task, presentation: Pick<ConsoleData, "controlledQa"> = {}): PaymentProof | null {
  if (task.id !== "rental-authorized" && task.id !== "rental-captured") return null;
  const replay = (presentation as { demonstration?: boolean }).demonstration === true;
  const actual = currentActual(show).filter(receipt => receipt.planVersion === show.planVersion);
  const rental = show.crewProtocol === 1 ? currentRentalClearance(show) : null;
  const authorization = rental ? rental.authorization : actual.find(receipt => receipt.kind === "authorization" && receipt.purpose === "rental" && receipt.amountMinor === 78000);
  const capture = rental ? rental.capture : authorization && actual.find(receipt => receipt.kind === "capture" && receipt.purpose === "rental" && receipt.parentId === authorization.providerResourceId && receipt.amountMinor === 48000);
  const type = task.id === "rental-authorized" ? "Rental authorization" as const : "Rental fee capture" as const, receipt = task.id === "rental-authorized" ? authorization : capture;
  const waiting = show.financialEvidence.some(row => row.status === "pending" && row.purpose === "rental" && row.kind === (task.id === "rental-authorized" ? "authorization" : "capture") && row.planVersion === show.planVersion);
  if (!receipt) return { type, amountMinor: null, status: waiting ? "Pending · checking payment result" : "Not recorded", redactedId: null, provenance: "No current receipt is stored for this plan version.", settled: false };
  const id = receipt.providerResourceId;
  return {
    type, amountMinor: receipt.amountMinor, redactedId: "…" + id.slice(-4), settled: true,
    status: task.id === "rental-authorized" ? "Authorized · funds are not captured by this record" : "Captured",
    provenance: replay ? "Replayed outcome; no PayPal request is made" : presentation.controlledQa ? "Controlled financial input; no provider qualification" : "Verified PayPal sandbox receipt",
  };
}
