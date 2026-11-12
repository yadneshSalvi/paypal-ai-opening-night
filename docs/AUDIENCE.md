# Private attendee information and reviewed audience updates

The producer desk is `/audience`; an ordinary ticket reader opens `/attendee`. Producers issue private access to one exact original ticket/capture, review immutable per-ticket messages, separately approve content/recipients/source, and explicitly deliver bounded inbox passes. Attendees cannot enter the production console, inspect other tickets or finances, approve plans, send messages, or change money.

The implemented transport is **a controlled in-app inbox**. It sends no external email, discovers no addresses, contacts no real people, and invokes no model. An inbox receipt does not prove human reading, physical admission, a performance occurring, or bank posting. The fictional showcase remains labeled sample/controlled even when its calculations use the real installed scheduling engine.

## Reader projection

The attendee DTO is an allowlist: current published event information or explicit last-published/under-review times, full/support-only cancellation, one original itemized admission/perk receipt, historically confirmed and currently verified refunds, original pending/unknown instructions, remaining approved remedies, and that ticket's own inbox.

Financial projection reads persisted original-resource ownership, command attribution and imported observations. It never contacts a provider. A supplied JSON verified flag cannot establish ownership. Pending reconciliation, contradictory capture totals, missing allocations and adverse current observations cannot become confirmed refunds or fresh admission eligibility. A fully refunded original receipt may remain readable with admission explicitly refunded.

Older messages remain exact historical records after their event or financial source changes. Current eligibility derives from the current projection above them. Changed bodies and current-source labels that contradict the saved source are rejected.

## Exact access and immutable history

Attendee access uses its own capability table and strict bearer format: `att_` plus 43 base64url characters. It never falls back to producer/crew cookies. The original link places the reader key in a fragment, immediately removes it from the address bar, and sends it only in the attendee Authorization header with cookies omitted and no referrer.

Each original grant binds one tenant, ticket, capture, immutable original receipt digest, issuer Actor, issuer token hash, exact issuer expiry and fixed reader expiry. PostgreSQL issuer expiry retains its exact microsecond string. Reads and recovery do not extend it. Revocation, ended issuer/reader access, changed issuer identity/expiry, and changed original ownership fail closed. Recoverable invitations use tenant/purpose-bound AES-256-GCM; dedicated HMAC domains separate reader keys from generic sessions.

Each new producer envelope carries both `sessionFingerprint` and `sessionExpiresAt` from its workspace read. The fingerprint is a non-authorizing purpose-separated digest of the exact session token hash. Both are compared before reserving an instruction. Two keys with the same actor and identical expiry cannot adopt each other's never-received instructions. Real source/revision locks precede authority checks, which are repeated before commit.

Capabilities, revocations, drafts, approvals, stops, command receipts, passes and per-recipient receipts reject update/deletion at the database boundary. Mutable pass progress is separate. Additive migration 17 preserves existing shows, tickets, financial evidence, sessions and expiries.

## Review, delivery and recovery

1. Read current sources and choose exact original inboxes.
2. Save a current-source draft. Each recipient's deterministic plain-text body has its own original amounts and refund/unknown qualifiers.
3. Read all content, recipient and source hashes; separately approve that exact preview. A draft or GET does not approve/deliver anything.
4. Explicitly reserve a bounded pass. Its command receipt records intent, not recipient delivery.
5. Read the original saved pass, retain recovery before dispatch, and run at most ten recipient transactions. Each checks source, original issuer, recipient and expiry before committing its exact inbox receipt.
6. Read saved progress and individual receipts. Failure/stop preserves completed recipients and leaves the remainder incomplete.

Exact command bytes are retained privately before dispatch. They are never automatically resent. Missing/unreadable replies remain unknown. Recovery first reads `GET /api/audience/commands/:id` with original exact access. Only `404 AUDIENCE_RECEIPT_NOT_FOUND` permits an explicit unchanged retry. Another body, token, fingerprint or expiry cannot be substituted.

A lost work response requires reading its original reserved pass and actual recipient receipts. The reservation receipt alone cannot prove completion. A new explicit continuation needs a fresh read proof. Storage refusal or a competing recovery file blocks dispatch and preserves a downloadable original file.

Denied/expired reads clear private content before decoding even an unreadable denial. Network/hash failure retains only a dated last verified observation, with approval/delivery paused. Production changes and late foreign responses cannot repopulate cleared state. Keyboard dialogs contain focus, require consent, return to their actual opener, and passive reads avoid stealing focus.

## API and bounds

Responses are private/no-store with no-referrer. Producer writes require exact same origin, current authority and production scope. Strict JSON is bounded to 30,000 bytes and rejects extra fields.

| Surface | Bound |
| --- | --- |
| Original ticket workspace | 1,000 retained tickets |
| Retained links per production | 400, including expired/revoked history |
| Exact recipients | 1–400 distinct inboxes, one per original ticket |
| Reader lifetime | 15–1,440 minutes, clamped to original issuer expiry |
| Draft lifetime | 5–30 minutes; approval respects issuer/recipient deadlines |
| Delivery pass | 1–10 committed recipients |
| Message/command summaries | Latest 20 |
| Message pass progress | Latest 40; durable gates also inspect older pending work |
| Attendee inbox page | 20 with an exact reader-owned cursor |

The retained link limit does not delete/renew/replace history. Larger audiences and retention maintenance require a separately designed policy; no unbounded capacity claim is made.

| Method/path | Purpose |
| --- | --- |
| GET /api/audience | Exact producer workspace |
| POST /api/audience/commands | Reviewed envelope |
| GET /api/audience/commands/:id | Original receipt recovery |
| GET /api/audience/messages/:id | Immutable preview and current progress |
| GET /api/audience/invites/:id | Original active link recovery |
| POST /api/audience/work | Current-proof bounded pass |
| GET /api/attendee?before=own-cursor | Dedicated bearer-only ticket/inbox |

## Reproduce controlled qualification

The isolated lane uses Node 22, fresh limited PostgreSQL role/database on 55579, and app 4594. The ignored runtime descriptor contains newly generated local DB/session configuration and only the root-authorized Bryntum license. It has no payment/model credentials. Never copy another project's environment, provider fixture, data or session.

Run in this exact clone with a clean environment:

```sh
env -i PATH="$PATH" node --env-file=.private/audience-stage17/runtime.env \
  scripts/qa/audience-regressions.mjs
env -i PATH="$PATH" node --env-file=.private/audience-stage17/runtime.env \
  --import ./scripts/qa/audience-controlled-wire-runtime.mjs --import tsx \
  scripts/qa/audience-stress.ts
env -i PATH="$PATH" node scripts/qa/audience-prepare-fonts.mjs
env -i PATH="$PATH" node scripts/qa/audience-build.mjs
```

The three test partitions separate inherited product, installed-SDK controlled transport, and mounted/real-service audience cases. Optional `audience`, `product` or `controlled-sdk` selects one partition. The 400-ticket stress harness freezes expectations first, creates original bindings through real commerce services and the installed SDK's controlled fetch seam, approves 400 recipients separately, runs 40 ten-recipient passes, and reads every private inbox while measuring time/heap/RSS. This is distinct from N2's temporal/resource/tour benchmarks and establishes no actual provider outcome or production latency guarantee.

The first full run's obsolete migration 16 assertion is retained as failed. Earlier inherited SDK runs also retain six, then three, failures caused by incomplete test-only virtual origin configuration. Their original Request and supplier-service origins are restored only in the inherited preload; no socket or listener on those virtual ports is permitted. The integration lead approved updating only that expectation to additive 17. The affected settlement/additive checks are rerun separately; unchanged passing cases are not relabeled or silently repeated.

Preparation supports separate `--http` and untouched native fixtures. The first HTTP setup correctly rejected a Standard recipient in a VIP-only draft. Its original rows and expiries were inspected read-only and preserved. An explicitly labeled independent preparation used new schema/actors/resources and a general event update; it did not replay or replace the original failed setup. The private ready-fixture selector is immutable and binds the exact descriptor hash; an accepted selection cannot be overwritten. Each refuses overwriting its original preparation, preserving failures without reset/reseed/renewal. Positive examples use real native scheduling commits and commerce services over controlled SDK transport. No fabricated positive live_sandbox database row is inserted.

```sh
env -i PATH="$PATH" node --env-file=.private/audience-stage17/runtime.env \
  --import ./scripts/qa/audience-controlled-wire-runtime.mjs --import tsx \
  scripts/qa/audience-prepare-native.ts --http
env -i PATH="$PATH" node --env-file=.private/audience-stage17/runtime.env \
  --import ./scripts/qa/audience-disabled-runtime.mjs \
  scripts/qa/audience-review-server.mjs --http
env -i PATH="$PATH" node --env-file=.private/audience-stage17/runtime.env \
  --import ./scripts/qa/audience-review-client-runtime.mjs --import tsx \
  scripts/qa/audience-http-qa.ts
```

Stop only that owned HTTP listener before starting the separately prepared native fixture without `--http`. Its password form selects fixed original capabilities. Producer tokens never enter URLs/stdout. The wrapper serves audience/attendee APIs/pages/static assets only; unrelated session/financial/model routes are denied before Next. One-shot transport controls retain actual trigger receipts without rewriting domain/financial history. The client verifies the exact listener PID, checkout, fixture and qualified build before connecting, granting no arbitrary localhost access.

Private secrets, logs, commands, recovery files, fixtures and schemas remain ignored. Exact source/dependency/build/privacy manifests and handoff are under `.artifacts/audience-stage17`. Public reports contain sanitized counts/provenance only.

## Font and result provenance

Three font faces are APFS COW copies with distinct inodes from accepted N2 source `2b80219a17bce80a6705dde4e82e60160f0316e4`. Frozen bytes are unchanged. The private enumerable mock CSS map has exactly three known request keys and public /audience/fonts URLs.

| Face | SHA-256 |
| --- | --- |
| Inter | c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4 |
| Oswald | c36937da4c39049704f1def587f7837a24ad52d3bfd2d27d3b6eb9f4220b2e3a |
| JetBrains Mono | 1e06740a02a443fb7f3eeda8fcaa685a0f6c620e3f01e6666e847295469ce3ad |

The offline build receives no usable database/session descriptor or license. A nonconnectable build-only sentinel permits module construction; transport audits require zero DB/provider attempts. Its only Node connection exception proves the generated compiler worker's exact parent-owned IPC listener. Public bytes and dependency traces are checked for private paths/secrets.

Mounted DOM tests do not prove native layout, screen-reader behavior, human copy review, physical entry, email delivery, or actual model/provider outcomes. Root owns native desktop/mobile/keyboard review on the frozen 4594 candidate. Shared navigation and later migration 18 integration belong to the integration lead.

The sanitized automated qualification record is [AUDIENCE_QUALIFICATION.json](AUDIENCE_QUALIFICATION.json). Its native-review state remains pending until root observes the frozen runtime.
