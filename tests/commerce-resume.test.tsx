import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CohortResumeAction, CohortResumeSummary, cohortResumeReviewIsCurrent } from "../src/components/commerce-resume";
import type { PublicCohort } from "../src/domain/commerce-contracts";
const cohort: PublicCohort = { id: "controlled-cohort", state: "paused", digest: "a".repeat(64), version: 1,
  terms: { version: 1, seller: "venue", currency: "USD", showId: "controlled-show", mode: "saved_wallet", walletId: "controlled-wallet", standardCount: 42, vipCount: 38, maximumTickets: 80, maximumMinor: 337000, admissionMinor: 3500, perkMinor: 1500, purpose: "controlled_sandbox_ticket_cohort" },
  approvedAt: "2026-11-11T05:27:10.193Z", expiresAt: "2026-11-12T05:27:10.193Z", revokedAt: null, pauseCode: "COHORT_READBACK_REQUIRED", pauseTicketId: "original-ticket", capturedCount: 9, capturedMinor: 33000, reservedCount: 10, unresolvedCount: 71, currentVerifiedCount: 9, captureReviewCount: 0,
  lines: [{ id: "original-ticket", ordinal: 64, tier: "vip", amountMinor: 5000, state: "needs_attention", intentId: "original-intent", captureReference: null, refundReference: null, approvalUrl: null, lastCode: "COHORT_READBACK_REQUIRED" }] };
test("a paused ticket without a capture can open the review without authorizing anything", () => {
  let called = 0;
  const html = renderToStaticMarkup(<CohortResumeAction cohort={cohort} busy={false} onReview={() => { called++; }} />);
  assert.match(html, /Review remaining tickets/); assert.doesNotMatch(html, /disabled=/); assert.equal(called, 0);
});
test("review controls stay unavailable while busy and absent outside a paused cohort", () => {
  assert.match(renderToStaticMarkup(<CohortResumeAction cohort={cohort} busy={true} onReview={() => undefined} />), /disabled=/);
  for (const state of ["draft", "approved", "revoked", "expired", "complete"] as const) assert.equal(renderToStaticMarkup(<CohortResumeAction cohort={{ ...cohort, state }} busy={false} onReview={() => undefined} />), "");
});
test("resume review displays existing limits, unresolved count, and an unchecked explicit continuation choice", () => {
  const html = renderToStaticMarkup(<CohortResumeSummary cohort={cohort} accepted={false} onAccepted={() => undefined} />);
  assert.match(html, /\$3,370/); assert.match(html, /9 tickets · \$330/); assert.match(html, />71</);
  assert.match(html, /Original approval ends/); assert.match(html, /uncertain result must be resolved first/);
  assert.match(html, /type="checkbox"/); assert.doesNotMatch(html, /checked=/);
});
test("a changed cohort, approval, pause target, expiry or revocation invalidates the displayed review", () => {
  assert.equal(cohortResumeReviewIsCurrent(cohort, structuredClone(cohort)), true);
  for (const changed of [{ id: "other" }, { digest: "b".repeat(64) }, { expiresAt: "2026-11-13T05:27:10.193Z" }, { pauseTicketId: "other" }, { state: "approved" as const }, { revokedAt: "2026-11-11T06:00:00Z" }]) assert.equal(cohortResumeReviewIsCurrent(cohort, { ...cohort, ...changed }), false);
});
