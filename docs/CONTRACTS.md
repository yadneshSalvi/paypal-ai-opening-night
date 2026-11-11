# Architecture and authority

## Canonical production

`src/domain/contracts.ts` defines the version 1 show contract. Production commands are tenant scoped and carry an expected revision. PostgreSQL locks the production row and commits the snapshot, durable command identity and new events together. The browser owns no authoritative schedule or readiness state. A durable schema version prevents applied table/index migrations from being reissued during normal app startup.

Task dates are UTC instants. America/Chicago is the venue view; the Denver incident keeps its source zone. Temporal performs explicit conversions. The Node engine validates a cloned proposal; Gantt and Scheduler display a shared read-only project, and Calendar has an independent projection. A view cannot silently publish or mutate the canonical plan. Replanning upserts dependency IDs; native widget lifecycles are scoped to their projection revision.

A recovery approval binds the exact candidate digest, offer revision, policy, cost and required roles. It does not imply money movement, supplier confirmation, publication, delivery, performer arrival or GO. The application distinguishes hypothetical computations, controlled fixture evidence and actual sandbox observations.

## Payment authority

The immutable shared core owns provider dispatch, durable execution claims, exact cents, reservations, retries of proven refusals, and read-based reconciliation. The production domain owns consent, current plan, scope, offered resources, component allocation and operational prerequisites.

`src/server/payment-service.ts` builds only server-generated actions. `src/domain/payment-authority.ts` validates them against the current show. `src/server/payment-store.ts` persists immutable intents, merchant-specific resource ownership and idempotent receipt imports. Buyer callbacks require a tenant-owned intent and signed state, then read current PayPal approval. Separate venue and Brightline clients cannot exchange grants.

The rental order authorizes 78000 USD cents. Fee capture is 48000 with `finalCapture:false`; matching acceptance and current supplier confirmation are required. Release closes the original authorization only after a verified 48000 capture, exact remaining 30000 and attributed return record. Its projection reports 30000 released, not 78000 of new cash flow.

Tickets allocate 3500 admission plus optional 1500 soundcheck perk. A remedy belongs to the ticket’s original capture. Repeated semantic intents reuse their existing operation, and ambiguous writes stay pending. A saved-wallet create may already include a completed capture: the importer recognizes that shape and never schedules a second capture. Save-only wallet setup and separately reviewed, expiring/revocable bounded-cohort consent are implemented; their exact authority and recovery are described in TICKET_COMMERCE.md.

## Evidence and readiness

Only verified `live_sandbox` completed receipts enter financial actuals. Order creation alone does not. Imported provider IDs are unique within their merchant and cannot be rebound to another tenant or checkout. Duplicate receipts are deduplicated; two distinct refunds exceeding a perk invalidate its completion count rather than manufacturing a green gate.

Historical receipts are immutable. Separate current-resource observations can withdraw financial readiness after a reversal, amount mismatch or unresolved refund history. A correctly closed rental retains its original 78000 authorization and 48000 fee while showing 30000 released and zero authorization remaining. The canonical task projector derives completion from these records and attributed operational facts, never the fixture clock. `schemaVersion:1` snapshots accept the additive `financialObservations` field; older saved snapshots remain readable.

Core0.2.4 direct child reconciliation can omit a parent relationship. The app obtains a fresh read of the exact owned order, checks child identity/amount and refund custom ID plus its sole original capture, and persists that corroboration beside the import. It projects the proven parent without modifying the core receipt. An absent or ambiguous relationship stays unresolved and cannot count toward readiness.

DOORS requires eight explicit gates, including supplier authorization and confirmation, accepted delivery, fee capture, technical checks, 38 confirmed refunds and 11 current-sheet acknowledgments. Performer readiness is independently scoped. The assigned stage manager issues DOORS GO against a current report; assigned FOH separately records HOUSE OPEN. Support and headliner starts each require their own current readiness and signed cue. The fixture clock creates none of those facts.

## HTTP and browser boundaries

- Session cookies are HttpOnly and SameSite=Lax, and Secure when hosted. Only hashed capabilities are stored. A valid cookie reopens its latest saved rehearsal without consuming creation capacity.
- PostgreSQL serializes new-session admission across app instances: at most 30 creations per rolling hour and 200 per rolling day. Reservations commit with the new show; rejected attempts return 429 and Retry-After. Existing reads and operations are unaffected. The HTTP route uses a fixed deployment scope; database tests isolate their own scopes.
- Crew and supplier tokens arrive in URL fragments, move to tab session storage, and are removed from the address bar. Invitation creation sends no external message.
- Browser mutations require an exact Origin header and use strict schemas. Missing, opaque and mismatched origins are rejected. Signed provider webhooks use a separate merchant-specific signature-verification boundary. The server rejects caller-supplied payment amounts.
- Cookie-authenticated actions also require `X-Opening-Night-Production` to match the rehearsal shown in the requesting tab. A changed browser selection returns `PRODUCTION_CHANGED`; the tab blocks further actions until explicitly reloaded. A person- or supplier-scoped Bearer capability keeps its original fixed rehearsal.
- Provider errors use bounded reasons. Credentials, wallet IDs and raw response bodies never enter public payment DTOs.
- Payment callbacks require an allowed app origin. Set `APP_BASE_URL` for the stable deployed hostname.
- SDK logging stays off. Unknown payment results never invite blind retry.

`/api/rehearsals` lists a producer's saved workspace and accepts explicit create, rename and switch requests. Reads neither create workspace membership nor renew access. Requests carry the displayed tenant and a stable idempotency key; replays return the original result, while changed payloads and foreign workspaces are rejected. Additive migration 5 creates workspace, membership and request records without rewriting original production snapshots. Selecting a rehearsal preserves its original actor and access expiry. Approved background work and financial history remain attached to their original production.

## Verification

The domain suite covers temporal, graph, qualification, approval, readiness, allocation and receipt invariants. Integration tests use real PostgreSQL and Bryntum Node commits. Payment wire tests construct the real SDK over a controlled fetch seam, inspect generated requests and check the committed PostgreSQL claim from inside that seam. They exercise concurrency, missing approval, accepted partial capture, return-gated release, original-capture refund and a lost create response. These are distinct from actual sandbox browser qualification.

Durable work and signature verification are described in [DURABLE_WORK.md](DURABLE_WORK.md). Schema migration2 adds leased jobs, a merchant inbox, current-resource read audit and initial-event backfill without rewriting saved production snapshots. New show creation records its initial event in the same transaction. The worker fixture uses a disposable PostgreSQL schema and an owned child process; its abrupt termination, fenced takeover, bounded retry and lost-response recovery are observed test behavior, not hosted availability claims.

## Supplier execution protocol 2

New rehearsals bind an authenticated immutable supplier quote to a real-time exclusive hold and exact plan version. Driver handoff, qualified condition acceptance and provider fee confirmation are independent events. Acceptance and the original-authorization fee intent commit atomically; a rejected delivery creates no fee and has a distinct supplier-return record before explicit uncaptured cancellation. Six additive migration-3 tables preserve existing snapshots and legacy financial executions. See [SUPPLIER_EXECUTION.md](SUPPLIER_EXECUTION.md).

Dedicated supplier and delivery capabilities cannot read or mutate the general production API. HTTP origin checks retain the actual same-port loopback Host locally because NextURL normalizes 127.0.0.1 to localhost; cross-host, cross-port and foreign origins remain rejected. Hosted exact-origin behavior is unchanged. Camera permission is limited to the delivery page.

## Crew protocol 1

The dedicated `/api/crew` allowlist excludes production-wide data and requires an explicit personal capability. Current skills and assignments authorize signed duties and cues. The producer API cannot impersonate crew. Exact readback identities survive offline retry and historical synchronization; the crew-only service worker caches an anonymous shell and static assets, never API responses or capabilities. New rehearsals enable the protocol; old rehearsals adopt it explicitly while retaining all money and legacy history. There is no SQL migration or automatic original-record rewrite. See [personal authority, compatibility and offline recovery](CREW_OPERATIONS.md).

## Reported work and liabilities

Schema migration 9 adds immutable encrypted settlement records and a verified revision cursor. Personal bearer capabilities can submit only their own time reports through `/api/crew/settlement`; exact current producer sessions separately approve rates, request corrections and approve reviewed liabilities through `/api/settlement`. Every action atomically binds its original instruction, actor/session, roster identity and both current revisions. A corrected report adds a separately reviewed adjustment and preserves earlier liabilities. Browser recovery requires the original command, actor and full canonical instruction digest. No recipient or provider dispatch is authorized by this ledger. See [settlement authority and verification](CREW_SETTLEMENT.md).


## Exact-recipient payout authority

Schema 10 adds encrypted immutable payout instructions/observations, sequential revision verification and merchant-scoped provider ownership. Reports and payable approval never imply transfer authority. `/api/payouts` requires the exact current producer session; server-admitted recipient versions and a four-check review bind original liabilities/credits, receiver, currency, amount, merchant and ten-minute authority. A unique durable dispatch commits before any POST, and every continuation after it is an original-resource read. Full batch collection plus direct item identity/status determine current payment proof. Unknown or mismatched items retain allocation; historical receipts survive adverse current observations. `/api/crew/payouts` exposes only the bearer capability's own person. `/api/payouts/work` can run only this production's payout jobs. Controlled fixtures cannot project actual money. See [Payouts](PAYOUTS.md) for exact authority, cancellation, configuration and qualification limits.
