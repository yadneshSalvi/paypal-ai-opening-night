import type { OperationalFact, ShowSnapshot, Task } from "./contracts";
import { currentActual } from "./finance";

export interface TaskExecutionPresentation {
  label: string;
  source: string;
  tone: "amber" | "green" | "muted";
}

/** Completion and provenance are independent: a fixture can be accepted and a real receipt can be complete. */
export function taskExecutionPresentation(show: ShowSnapshot, task: Task): TaskExecutionPresentation {
  if (task.state !== "complete") return { label: task.state === "blocked" ? "Blocked" : "Planned", source: "Awaiting execution evidence", tone: task.state === "blocked" ? "amber" : "muted" };

  const actual = currentActual(show).filter(receipt => receipt.planVersion === show.planVersion);
  const authorization = actual.find(receipt => receipt.kind === "authorization" && receipt.purpose === "rental" && receipt.amountMinor === 78000);
  if (task.id === "rental-authorized" && authorization) return { label: "Authorized", source: "Verified PayPal sandbox receipt", tone: "green" };
  if (task.id === "rental-captured" && authorization && actual.some(receipt => receipt.kind === "capture" && receipt.purpose === "rental" && receipt.parentId === authorization.providerResourceId && receipt.amountMinor === 48000)) return { label: "Captured", source: "Verified PayPal sandbox receipt", tone: "green" };

  const operational: Record<string, { kind: OperationalFact["kind"]; label: string }> = {
    "rental-delivery": { kind: "delivery_accepted", label: "Accepted" },
    "lx-focus": { kind: "focus_signed_off", label: "Signed off" },
    "lx-program": { kind: "cue_signed_off", label: "Signed off" },
    "headliner-arrival": { kind: "headliner_checkin", label: "Checked in" },
    "quiet-prep": { kind: "quiet_prep", label: "Complete" },
    changeover: { kind: "changeover", label: "Complete" },
  };
  const operation = operational[task.id];
  const fact = operation && show.facts.find(item => item.planVersion === show.planVersion && item.kind === operation.kind);
  if (operation && fact) return { label: operation.label, source: fact.source === "sample" ? "Controlled fixture record" : fact.source === "replay" ? "Replayed operation record" : fact.source === "modelled" ? "Modelled operation record" : "Sandbox-linked operation record", tone: "green" };
  if (task.id === "readiness") return { label: "Ready", source: "Computed from current evidence", tone: "green" };
  if (task.id === "doors" && show.state === "house_open") return { label: "House open", source: "Controlled front-of-house confirmation", tone: "green" };
  return { label: "Complete", source: "Sample preparation checklist", tone: "muted" };
}
