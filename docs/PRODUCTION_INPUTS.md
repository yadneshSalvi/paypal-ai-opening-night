# Production inputs

`/inputs` admits source-reviewed roster, skills, availability, assignments and venue policy into the current production. The resulting people and constraints drive the canonical schedule, candidate validation, personal crew projection and readiness reports.

The desk has three separate steps:

1. Retain exact declared UTF-8 text, or select a complete current parsed text/PDF/spreadsheet from the existing source desk. Original content, rights, source label, authority declaration, version, hashes and page/cell/line units remain inspectable. Retention grants no operational authority.
2. Save a typed proposal. Every proposed field carries an exact quotation from one retained source unit. Inspect a current-source/current-access preview with the actual Bryntum Gantt Enterprise 8.0.0 graph result, before/after values and domain blockers.
3. The original producer separately reviews sources, declares planning authority and accepts the displayed consequences. One atomic admission creates an immutable input edition and command receipt. A proposal or preview cannot admit itself.

Declared qualifications are planning inputs, not independently verified certifications. Controlled fictional names remain labelled. The desk establishes no physical work, actual identity, third-party venue sign-off, supplier capacity, provider receipt or payment authorization. Source strings cannot execute commands or expand permissions.

## Current operational consequences

Admissions preserve resource IDs, old source versions, the earlier approved-plan object, original financial/rental records, published sheets, acknowledgments and signed work. Existing people cannot be renamed or deleted through this desk, and rates are outside this admission contract. A new person starts without an approved pay agreement.

The current roster receives the admitted skills, windows, active/reserve status and assignments. Active critical crew counts are computed from that roster. Candidate generation retains admitted programming assignments instead of restoring a fixed programmer. Qualification, qualification expiry, availability, reserve assignment, venue access, amplified curfew and rest constraints participate in actual plan validation. The engine checks graph dates/dependencies; the application checks the sourced semantic rules separately.

A truthful input may reveal an infeasible schedule. The producer can admit that fact with its blockers visible; this does not approve an invalid plan. An unavailable engine leaves an unknown preview that cannot authorize admission. After admission, all cue scopes gain a current-input gate. Fresh engine-backed plan approval and publication binding the exact input digest are required. Old personal readbacks remain historical and cannot count toward the new edition. Original cancellation and accepted-rental closeout retain their own exact-resource authorization paths.

The inherited `maxShiftMinutes` setting remains an actual-hours review warning. A separately cited maximum-call-span admission explicitly establishes a hard planning cap. These production policies are declared scenario inputs, not universal labor or venue rules.

## Source and command history

Additive migration 20 adds immutable sources, proposals, source bindings, previews, editions, decisions and command receipts. Triggers reject updates/deletions of this evidence. A parsed document retained by the desk cannot be deleted from the existing source store; a successor preserves its original bytes and source identity. Superseding a source invalidates an uncommitted proposal, without rewriting an already admitted edition.

All commands bind the exact tenant, actor, original session-token fingerprint, full six-digit fixed expiry, production revision and input revision. Authority is rechecked against current persisted membership and database time, including after engine computation or lock waits. Another token, altered expiry, changed payload or another production cannot inherit the original command.

`GET /api/production-inputs` reads the current producer workspace. `POST` accepts only the strict versioned command envelope. `GET ?commandId=<original UUID>` retrieves the original private receipt and waits behind an in-flight production transaction before reporting absence. Unknown outcomes recover by original GET. Only a confirmed missing receipt exposes an explicit same-command retry; no new identity is automatically created. Corrupt browser storage or a mismatched receipt holds the instruction for inspection.

## Verification

The focused tests cover real PostgreSQL transactions, concurrent admission, source integrity/deletion retention, session/tenant/role separation, same-token expiry changes, actual engine expiry rollback, before/after feasibility, real personal readback history and installed-engine candidate assignment. Mounted React tests cover source inspection, separate producer review, venue-zone input, lost-response recovery, explicit exact retry, changed access and corrupt storage. These are controlled tests; native layout, a physical device and human participation are separate evidence.

With the repository's local database and licensed engine configuration, run the focused tests using the existing provider-disabled preloader:

```sh
node --import ./scripts/qa/disabled-providers.mjs --import tsx --test --test-concurrency=1 \
  tests/production-inputs-domain.test.ts tests/production-inputs-store.test.ts \
  tests/production-inputs-api.test.ts tests/production-inputs-ui.test.tsx
```

The separately provisioned qualification environment uses `tests/production-inputs-runtime.mjs`, which refuses any database or role other than its exact assigned namespace and blocks all external transport. Its protected local configuration, actors, native fixture, failure logs and freeze manifests are excluded from Git. No model, financial provider, outreach, deployment or physical-show claim is part of this source unit.
