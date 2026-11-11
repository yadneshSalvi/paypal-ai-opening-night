# Opening Night

[Hosted integration checkpoint](https://paypal-ai-opening-night.vercel.app) — verified on Vercel with isolated durable sessions, native scheduling and reviewed decision persistence. Full product scope remains under implementation. Hosted checks: `docs/evidence/hosted-http-qualification.json` and `docs/evidence/hosted-browser-qualification.json`.

A production console for the moments before a live show. Recover a disrupted schedule, secure replacement equipment, keep ticket promises, publish the right calls, and issue GO only when the current evidence supports it.

The running fixture is a fictional Night Ferries show at Alder Hall, Chicago, on 14 November 2026. A delayed flight and failed lighting console connect the schedule, supplier, box office and crew. Controlled fixture actions, computed proposals and actual PayPal sandbox receipts have separate provenance.

## Run locally

Use Node **22.x**, npm and PostgreSQL. The application uses Next.js 16.4.6, React 19.3.1 and Bryntum Enterprise 8.0.0. A valid Bryntum entitlement is required; proprietary distributions and license keys are not included.

```sh
cp .env.example .env
npm ci
npm run verify:packages
npm run db:migrate
npm run dev
```

Open `http://localhost:4105`. Set the required database, session and Bryntum configuration in `.env`. Merchant clients are initialized lazily; isolated sandbox credentials are required before using financial routes. The ticket seller and Brightline supplier must have **different PayPal merchant apps**. Locally `.env` is authoritative; hosted environments supply their own variables. Set `APP_BASE_URL` to the exact public origin before deployment.

```sh
npm run typecheck
npm test
npm run test:integration
npm run build
npm run start
```

The integration suite requires local PostgreSQL. Every database suite creates and drops its own disposable schema, including the older store/payment/session suites. The durable worker suite also kills its own worker process to verify recovery. Existing rehearsal schemas are not used for fixtures. SDK and signature-postback tests use controlled wire fixtures; they do not make sandbox purchases or establish authentic signed delivery. Actual provider qualification is a separate workflow.

## Working milestone

- A durable private rehearsal; 10 production views; mobile drawer, keyboard search, reduced motion and printable call sheets.
- A saved rehearsal workspace with separate creation, naming and selection. Original actors, expiry, plans and receipts remain with their rehearsal; stale tabs block actions until explicitly reloaded.
- 82 canonical tasks, 11 critical crew and an excluded reserve; explicit Chicago instants and Denver/Chicago incident arithmetic.
- Twelve stored recovery alternatives with deterministic resource, skill, cost, curfew, rest and approval rules. Independent **real Bryntum Node engine commits** validate proposals. The generator is currently deterministic and labeled accordingly.
- Native Gantt and Scheduler share a browser project and synchronized axis. Baselines, styled dependencies, a native utilization histogram and an independent Calendar are present. Venue day groups and spoken dates use Chicago time.
- A native Bryntum AI planning panel with durable encrypted conversations, deterministic qualification checks, source-bound proposals, proven checklist progress and exact producer review. Its local controlled-input qualification is separate from actual model evidence and deployment. See [grounded production planning](docs/PRODUCTION_INTELLIGENCE.md).
- Native opt-in recording, an editable transcript that requires Send, and AI-generated read-aloud through the current Realtime API. A private source desk extracts text, PDF locations and spreadsheet cells into cited proposals, checks the real scheduling engine, and requires an exact producer review before applying a supported working graph. See [voice and source boundaries](docs/VOICE_AND_SOURCES.md).
- Revision-checked plan approval; distinct publication, crew acknowledgment, DOORS, SUPPORT_START and HEADLINER_START gates. A fixture clock change creates no execution evidence.
- Strictly scoped personal crew, supplier, driver and assigned lighting-lead clients. Crew have a versioned private cache, durable offline readback identities, a crew-only offline shell, native personal Calendar, real next-call rest checks, and signed person/plan/sheet-bound duties. Separate DOORS GO, HOUSE OPEN, SUPPORT START and HEADLINER START records drive execution; historical evidence remains distinct.
- Personal time reports, explicit producer-approved rate versions and an immutable liability ledger. Corrections retain the original payable and add an exact debit or credit adjustment; payment requires a separate recipient approval and provider receipt. See [reported work and approved liabilities](docs/CREW_SETTLEMENT.md).
- Three signed fixture-service RFQs, exact-quote inventory holds, real-time expiry/reconfirmation, single-use delivery QR and separately attributed inspection. Acceptance atomically saves the one approved fee instruction; rejected equipment has its own return and uncaptured-cancellation path.
- Separate save-only Vault approval, an exact expiring/revocable 80-ticket cohort, buyer-present fallback, per-ticket durable dispatch and a 38-capture refund batch. The box office shows reviewable limits, stop/recovery controls and current versus historical evidence. Actual save-only wallet, all 80 original captures and all 38 original-capture remedies passed independent root provider qualification.
- Guarded sandbox rental checkout/callback, $480 nonfinal fee capture, $300 residual authorization closure, itemized ticket checkout and a capture-specific $15 remedy adapter. Operations use current domain authority, durable PostgreSQL identities, provider ownership, fresh budgets and safe reconciliation.
- Payment intents and webhook inbox entries commit their wakeup jobs atomically. Leased PostgreSQL work survives request/process loss; bounded retries expose unresolved outcomes for review. The payment panel shows saved work and authentic-delivery counts separately from configuration.
- Merchant-specific signature verification, duplicate/conflict handling and owned-resource readback are implemented and locally tested. Current adverse reads withdraw readiness while preserving historical receipts. Money milestones and native dependency styles follow that evidence.

A created PayPal order is **not** an authorization or capture. The rental flow requests a $780 authorization from the distinct supplier merchant, captures $480 only after supplier confirmation and attributed delivery acceptance, and retains the $300 hold for a recorded undamaged return. PayPal buyer approval occurs in the official sandbox. An actual browser qualification completed the supplier authorization, nonfinal fee capture and residual hold closure; subsequent provider reads confirm the $480 capture remains completed and the authorization is voided. See the [redacted qualification record](docs/evidence/brightline-rental-qualification.json). A separate fresh hosted protocol-2 cycle also passed signed supplier, single-use handoff, assigned acceptance and the exact $780/$480/$300 lifecycle, followed by independent read-only provider corroboration and four authentic signed deliveries. See the [hosted protocol-2 receipt](docs/evidence/supplier-hosted-protocol2-qualification.json). Actual save-only wallet approval passed [twenty independent read-only checks](docs/evidence/wallet-hosted-qualification.json) with $0 charged at that readback. The original 80 captures total $3,370 and were independently checked with 160 provider GETs. The 38 original-capture $15 refunds total $570 and were independently checked with 114 GETs, leaving $2,800 net admission. Final hosted observation showed 118 authentic signed deliveries reconciled and no pending jobs. These are one controlled sandbox buyer’s logical tickets, not 80 people or attendance. See [original capture proof](docs/evidence/original-ticket-cohort-hosted-qualification.json), [original remedy proof](docs/evidence/original-remedies-hosted-qualification.json), and [ticket commerce](docs/TICKET_COMMERCE.md).

## Rehearsal journey

1. Open a rehearsal. Load the labeled flight and console incident sources.
2. Request three authenticated supplier quotes, then compute recovery alternatives. Preview the rejected artist/rest scenario, then review Protect doors and its explicit approvals.
3. In Execution, review the exact unit and ten-real-minute hold, including consent to the $480 fee after assigned acceptance. Hold it, then separately review the $780 authorization and complete official PayPal sandbox buyer approval.
4. Resume the saved supplier-confirmation work if needed. Issue the current handoff QR and open the execution-scoped driver and Priya clients. At scenario 17:15, the driver records the handoff; Priya inspects and accepts condition. Acceptance queues the one approved $480 nonfinal fee, and provider confirmation remains separate.
5. Publish the current run sheet and open individual crew clients. Review each person’s changes and record their exact-sheet acknowledgment. Assigned people separately sign lighting focus, programmed cues, FOH contingency and performer/stage readiness. A producer cannot sign on their behalf. See [crew authority, offline recovery and Calendar](docs/CREW_OPERATIONS.md).
6. In Box office, save a wallet without a charge, then review the separate exact 80-ticket approval or use individual PayPal approvals. Each original capture must be verified. Review the 38 original-capture $15 remedies under the approved canceled-perk plan. Continue the outstanding technical, performer and crew evidence. GO stays closed until every current DOORS gate is satisfied.
7. Sam reviews DOORS GO against all eight current gates. Avery separately records HOUSE OPEN; Sam separately calls SUPPORT START and HEADLINER START when each later readiness scope and scheduled time is clear. Clock advance creates no execution record.
8. At wrap, record the controlled supplier’s undamaged-return inspection before requesting residual hold closure. Each person can report completed rehearsal time through their private Hours tab; the producer separately approves the rate agreement and exact payable in Wrap & settlement. Corrections retain their earlier reports and approved amounts.

New sessions use this signed workflow. Older saved sessions retain their original rental history and workflow. Physical production facts are explicitly controlled rehearsal records; they do not prove a real concert, crew or equipment inspection occurred. See [supplier execution and migration](docs/SUPPLIER_EXECUTION.md).

## Capability boundaries

This is an implementation milestone, not a completed submission. Full required scope remains: broader source admission and production compilation, microphone and broader voice qualification, broader supplier negotiation and real-camera qualification, native settlement qualification and exact-recipient Payouts/invoices, actual fees/P&L and Toolkit integration, wider adverse-provider and event coverage, the second-incident/cancellation branch, tour/network coordination, broader evaluation, real-phone evidence and the filmed demonstration. The source compiler passed one actual-model case and a separate controlled native review; see the [compiler v2 receipt](docs/evidence/source-compiler-v2-root-qualification.json). Native playback and keyboard controls have their own [scoped voice receipt](docs/evidence/voice-controls-native-qualification.json). The settlement checkpoint has [372 passing local tests and seven targeted recovery HTTP checks](docs/evidence/settlement-normalization-local-qualification.json); these do not establish physical attendance or paid wages.

Native desktop review completed 11 personal readbacks and all eight attestations/four cues in an isolated rehearsal with declared supplier/payment prerequisites. Native 390px/keyboard, offline hard reload with explicit readback sync, revocation, and a separate stale-review rejection also passed; see the [crew qualification record](docs/evidence/crew-local-qualification.json) for the exact scope and remaining gates. That crew exercise is separate from the original provider audits. No participant study or physical proof is fabricated. Planned cohorts and SDK wire fixtures do not satisfy actual provider requirements.

See [architecture and authority](docs/CONTRACTS.md) and [the capability register](docs/CAPABILITIES.md). The private implementation ledger is intentionally not in Git; public documents keep a fresh checkout understandable without it.

## PayPal and APIMatic

The app consumes immutable `@fracture/paypal-core` 0.2.4 and verifies its archive SHA-256. The core uses the real APIMatic-generated **paypal 2.29.0** SDK pinned to `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`; it is not `@paypal/paypal-server-sdk`. Installed operation maps and declaring models inform the integration contract. See [APIMatic setup and usage](APIMATIC_SETUP.md).

Secrets, local plans, private account state and recordings are ignored. Source remains private, with the hosted checkpoint linked above. Each later deployment, webhook registration and demo submission needs its own recorded verification.

## Durable worker and webhook setup

Register each sandbox merchant's stable endpoint separately: `/api/webhooks/paypal/venue` and `/api/webhooks/paypal/brightline`. Store their returned IDs in `PAYPAL_WEBHOOK_ID` and `OPENING_NIGHT_SUPPLIER_PAYPAL_WEBHOOK_ID`. The receiver uses the existing core verifier and the explicit current v2 event catalog in `src/server/payment-webhooks.ts`. It never executes a financial action from a webhook payload.

After reviewing the deployed migration and pending work, configure a secret of at least 32 characters in `CRON_SECRET` and have the deployment scheduler call `/api/jobs/tick` with its Bearer capability. Scheduling is deliberately separate from compiling this route. `npm run worker:once` runs one bounded batch locally and can resume previously approved, proved-undispatched work; use it only against the intended sandbox database. Producer clients may resume due work for their own rehearsal. Neither mechanism resends an ambiguous provider write or creates new approval.

Commerce dispatch locks use a separate direct PostgreSQL connection, selected from `DATABASE_URL_UNPOOLED`, `POSTGRES_URL_NON_POOLING`, or `DIRECT_URL`; a local direct `DATABASE_URL` is sufficient for development. A Neon pooler URL is refused for this connection. Each lock lives in a bounded read-only transaction and ends on rollback or disconnect. This follows [Neon's transaction-pooling limitations](https://neon.com/docs/connect/connection-pooling#connection-pooling-in-transaction-mode) and [PostgreSQL's transaction-level advisory-lock semantics](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

When a deployment changes, retain the exact originally approved checkout origin in the trusted runtime configuration (for example, `NEXT_PUBLIC_APP_URL`). An origin failure is checked before a new ticket reservation. Resume retains the original approval, expiry, ticket allocation and any existing payment identity; an existing identity qualifies only if its exact terms still match and no operation, attempt, dispatch, binding or import exists. An operation already in the payment core must use its original retry or reconciliation path.

Root qualified the hosted minute scheduler and registered both merchant endpoints with 11 supported events. Fresh source cd0dc62 passed hosted protocol-2 qualification: four authentic signed authorization/order/capture/void events reconciled, while the original earlier rental remains separate. Hosted migration 3 preserved all six existing snapshot hashes. The supplier checkpoint passed 70 domain and 83 integration checks; the ticket extension adds its own controlled SDK/PostgreSQL and API cases. No test fixture counts as an actual purchase or genuine delivery. See [durability and webhook boundaries](docs/DURABLE_WORK.md) and [supplier qualification evidence](docs/evidence/supplier-local-qualification.json).

## License

Application code and the shared payment core are MIT licensed. Bundled APIMatic context retains its upstream license/provenance. Bryntum requires its own entitlement and is installed from official package distribution, not vendored here. QR library notices and license copies are in [third-party notices](docs/THIRD_PARTY.md).
