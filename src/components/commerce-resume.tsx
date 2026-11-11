"use client";
import { ArrowRight } from "lucide-react";
import type { PublicCohort } from "@/domain/commerce-contracts";
import { formatMoney } from "@/domain/time";
import { Button } from "./ui";

/** Opening a review never asserts that the server has cleared a payment outcome. */
export function CohortResumeAction({ cohort, busy, onReview }: { cohort: PublicCohort; busy: boolean; onReview: () => void }) {
  if (cohort.state !== "paused") return null;
  return <Button variant="primary" disabled={busy} onClick={onReview}>Review remaining tickets <ArrowRight size={15} /></Button>;
}
export function cohortResumeReviewIsCurrent(review: PublicCohort, current: PublicCohort | null | undefined) {
  return Boolean(current && current.state === "paused" && current.id === review.id && current.digest === review.digest && current.expiresAt === review.expiresAt && current.pauseTicketId === review.pauseTicketId && !current.revokedAt);
}
export function CohortResumeSummary({ cohort, accepted, onAccepted }: { cohort: PublicCohort; accepted: boolean; onAccepted: (value: boolean) => void }) {
  return <>
    <div className="commerce-review-amount"><span>Original total ceiling</span><strong>{formatMoney(cohort.terms.maximumMinor)}</strong></div>
    <dl className="commerce-review-terms"><div><dt>Recorded captures</dt><dd>{cohort.capturedCount} tickets · {formatMoney(cohort.capturedMinor)}</dd></div><div><dt>Tickets still unconfirmed</dt><dd>{cohort.terms.maximumTickets - cohort.capturedCount}</dd></div><div><dt>Original approval ends</dt><dd>{cohort.expiresAt ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(cohort.expiresAt)) : "No current approval"}</dd></div></dl>
    <p>Continue the remaining original purchases under the approval already on file. The limits, expiry and saved ticket identities stay the same.</p>
    <p>A saved request that never reached PayPal keeps its original identity. The server checks this before continuing. A payment with an uncertain result must be resolved first.</p>
    <label className="commerce-consent"><input type="checkbox" checked={accepted} onChange={event => onAccepted(event.target.checked)} /><span>I have reviewed the paused run and want the remaining original tickets to continue under the existing approval.</span></label>
  </>;
}
