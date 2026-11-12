# Current supplier terms after a disruption

An accepted rental can fail after its original quote has expired. Opening Night now keeps that original rental, accepted fee, damage hold and return obligation while the producer reviews a new supplier promise.

The workflow is deliberately separate from payment and physical acceptance:

1. A scoped supplier publishes a new immutable terms edition for its own enrolled unit. It supplies current Chicago delivery and acceptance dates, exact fee and hold, a real validity window, and attributed compatibility, driver and condition evidence. Unknown evidence stays unknown.
2. The producer reviews the current disruption, supplier editions and every retained original commitment before requesting a new quote collection.
3. Each enrolled service returns a signed quote or a signed refusal. A timeout, malformed response or missing reply remains unresolved. A complete collection can contain one usable quote and two refusals; it no longer requires three positive quotes.
4. The actual installed Bryntum engine commits the candidate graphs. Deterministic resource, evidence and policy checks remain separate. The producer then approves one exact current candidate and its required exceptions.
5. A new reservation binds its own quote, plan and exact producer capability. The original rental does not become the replacement's payment, handoff, return or readiness evidence.

Full cancellation remains terminal. A supplier reported unavailable must first publish its own available-again report before offering new terms. A healthy accepted rental cannot be silently replaced without an attributed current disruption.

## Authority and clocks

Scenario dates and actual expiry are independent. A terms edition lasts 5–60 real minutes, never beyond its original supplier access. A reviewed collection lasts at most 15 real minutes, never beyond the approving producer access. Both clocks, the current source/report, exact actor, tenant and unchanged session expiry are checked before applying replies or creating a replacement reservation.

New supplier access is explicitly reviewed, private and fixed at creation. It is limited to one enrolled supplier and expires within one day or the producer's earlier expiry. No external invitation is sent. Supplier access cannot inspect another supplier, production finance or crew records.

The server retains PostgreSQL microsecond expiry precision when binding authority. It does not treat a replacement capability for the same actor, or a silently extended original expiry, as the same authority.

## Recovery and retained history

The browser saves canonical command bytes before the first POST. A lost response leaves the exact command pending and blocks competing changes. The original session can read its saved receipt. Only an exact `SUPPLIER_RECOVERY_RECEIPT_NOT_FOUND` response allows an explicit retry of the identical instruction. Unreadable responses, generic 404s, different sessions and changed content do not grant retry authority.

The server stores immutable command receipts and source editions. Old signed quotes and requests cannot be updated or deleted by the application. Late replies from another session or an earlier browser generation cannot replace the current workspace. Switching productions preserves each original pending instruction separately.

The initial supplier collection remains visible as retained history. Its older record format is not described as a replacement collection with zero signed responses.

## HTTP contract

All reads are private and uncached. Mutations require exact origin, current capability, bounded strict JSON and the viewed production scope for cookie-based clients.

| Endpoint | Purpose |
|---|---|
| `GET /api/supplier-recovery` | Current scoped sources, retained obligations and original collections |
| `POST /api/supplier-recovery/commands` | Review and save `open_supplier`, `publish_terms` or `request_quotes` |
| `GET /api/supplier-recovery/commands/:id` | Recover an original receipt for the exact actor and session |
| `POST /api/supplier-recovery/work` | Continue the approved collection's original requests |
| `POST /api/show` | Existing real-engine comparison and separate producer approval |
| `POST /api/suppliers/:supplier/holds` | Existing hold flow with new-terms authority bound server-side |

Migration 16 adds encrypted immutable terms, invitations, reviewed collection grants and command receipts, and a typed outcomes column on existing RFQs. It also protects stored supplier quote/request history from mutation. Migrations 14–15 provide the separate original-rental return and hold-closure workflow. Existing records are retained; no backfill invents approval, expiry or evidence.

## Qualification boundary

The unit has 44 focused supplier-recovery tests: 18 service/store, 7 API, 6 browser recovery and 13 mounted DOM cases. It includes actual installed-engine recovery from an accepted rental, retained fee/hold handling, unknown evidence, exact-session expiry races, source changes during replies, signed refusals, lost responses and cross-session recovery. The complete regression partitions were reconciled with bounded affected-file reruns; first failures remain in the private qualification packet.

The compiled HTTP journey completed ten checks and 39 requests on separate controlled identities: source publication, exact receipt replay, reviewed collection, signed quote/refusal responses, real engine, separate approval and a distinct replacement hold. Five additional reads verified font bytes and the generated-time comparison. A read-only SQL audit proved all 74 pre-existing rows across 70 tables unchanged. No successful mutation was repeated to repair the test report.

The native review cohort uses real application services and the installed SDK over a controlled transport. Physical observations and provider responses are explicitly fixtures. Its initial final assertion incorrectly counted the retained original RFQ as replacement work; the failed record is retained, and those same capabilities were independently qualified through a read-only transaction. No session was reseeded or renewed, no replacement snapshot was supplied, and fresh terms remain for the native reviewer to publish.

Actual financial and model qualification remains distinct. This source also incorporates the narrow invoice parser/core fix, stateless encrypted Responses continuation and safe account-message renderer. The separately observed original sandbox invoice/Toolkit/assistant result is recorded in [the sanitized receipt](evidence/invoice-toolkit-assistant-stage16.json); it is not a new provider run by this unit.

Local review is reserved to app 4586 and its isolated PostgreSQL 55575 database. The QA scripts require an explicitly supplied non-provider configuration and block provider egress. `qa:supplier-recovery:prepare` is create-once; `qa:supplier-recovery:http` uses a distinct fixture. Browser/native acceptance and hosted integration are separate gates owned by the release lead.
