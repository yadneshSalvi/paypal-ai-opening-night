# Reported work and approved liabilities

The personal **Hours** tab records a crew member’s own reported rehearsal time. **Wrap & settlement** lets the producer approve rate agreements, review each report, request a correction, and retain an exact payable or adjustment. These records establish application participation and reported fictional work. They do not establish physical attendance, wages paid, or employment-law compliance.

This is the first settlement checkpoint. Exact-recipient payout approval, provider item reconciliation, cancellation, actual fees and related invoice/P&L work follow from these records. No payout endpoint, recipient field or payment dispatch is introduced here. Existing ticket, rental, refund, readiness and crew signoff authority is unchanged.

## Personal report

Only the explicit personal bearer capability can call `/api/crew/settlement`. A producer cookie cannot substitute for it. The response contains only the assigned person’s reports, rate versions, review results and liabilities. Private settlement information is not added to the broad crew run-sheet cache, provider prompts or source exports. The offline service worker does not cache API responses.

A report names a service day and the exact published sheet. The person enters one to eight ordered work intervals and whole unpaid-break minutes. Times are normalized to exact minutes; the UI labels America/Chicago explicitly. A report cannot end after the production’s fictional scenario clock. Actual server receipt time is stored separately. The first interval must start on the production day or next day, a report’s span is at most 24 hours, and current reports for different service days cannot overlap. The schedule is a reference and never generates a report automatically.

There is one correction chain per person and service day. A correction names the exact latest report. All earlier submissions remain intact, including their published-call references, explanations and approval receipts. Requesting a correction records the producer’s explanation in the person’s private history; it does not approve a liability.

## Rate and payable review

The producer explicitly records a regular hourly rate, overtime hourly rate, daily regular-minute threshold, effective day, USD currency and agreement note. No roster planning estimate is silently approved. Each rate version retains the previous version and the roster identity/role it applies to. A future-effective version does not silently change an earlier day.

Regular and overtime work are calculated from the reported intervals, after unpaid breaks, across the entire service day. Calculations multiply integer minutes by integer cents. Each regular/overtime component rounds half-up once; totals use those exact components. The UI displays the calculation and rounding basis.

A payable review binds the exact report, applicable approved rate, previous approved liability, warnings, settlement revision and production revision. Three separate review checks cover hours/variance, rate/calculation and the exact liability or adjustment. A changed report, rate, roster, revision or review digest blocks approval. A source import cannot replace a production with settlement history.

Corrections create immutable debit or credit adjustments. For example, an approved $35.00 liability corrected to $17.50 retains the original $35.00 payable and adds a −$17.50 credit adjustment. The resulting approved balance is $17.50. This does not return funds or authorize a deduction. A corrected report can produce a positive, negative or zero adjustment, and unreviewed corrections remain visible. Already approved rates and liabilities are never rewritten.

## Durable authority and recovery

Additive schema version 9 contains a settlement revision cursor and append-only encrypted records. Every retained record has a stable request identity, exact actor/session/tenant/person attribution, original encrypted request, encrypted record, digest and timestamp. The service verifies the cursor against the immutable sequence on every read. SQL triggers reject record updates/deletes and nonsequential cursor updates.

Every command locks the production, rechecks the exact current session and scope, checks both revisions and commits its settlement record, canonical revision marker, command receipt and generic production event together. Repeating the same envelope returns its original receipt with the latest permitted view. A changed envelope or replacement session cannot reuse the identity. Concurrent requests cannot approve the same revision twice.

Before a browser POST, the exact envelope is retained and verified in session storage under its actor, owner and scope. The browser and server independently calculate the same canonical SHA-256 digest of the entire instruction. A lost or unreadable response preserves it. Checking server history recovers a receipt only when its actor, request identity, instruction digest and kind all match; manual retry uses the same original envelope. A changed saved instruction, identity conflict or uncertain result remains held. There is no automatic resend, and server reads wait until local recovery validation finishes. Definite validation or stale refusals allow a fresh review. Production or personal-access changes cannot redirect the saved request into another workspace.

## Local verification

Recovery file version 2 applies the same strict command schema as the server before hashing and sending, including trimming review notes. Existing version-1 files are supported: their untouched original envelope hash is verified first, then the same server normalization is applied to find the retained receipt. Changing a saved body without its original hash still blocks recovery. This compatibility does not edit a server record or resend an action. **Recover a saved request file** opens a bounded file for the same actor, person/production and scope, then checks the original receipt through a read; a separate manual action is required for any retry.

Use Node 22. `npm run test:settlement` disables actual providers before environment loading and runs the domain, disposable-PostgreSQL and browser-recovery contract tests. These cover integer rounding, unpaid breaks, daily overtime, rate boundaries, positive/negative/zero corrections, cross-day overlaps, exact review identity, concurrency, replay, session revocation, person isolation and immutable encrypted records. The PostgreSQL tests create and remove only unique local test schemas.

The full local suite also covers the existing payment, crew, source, voice and real-engine paths. Root-owned native qualification should exercise personal reporting → producer rate agreement → three-check payable review → correction → retained adjustment, reload, keyboard access and a narrow viewport. Controlled browser interaction is separate from a practitioner study, microphone capture, physical phone test or actual-provider payout qualification.
