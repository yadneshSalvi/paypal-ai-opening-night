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

Open `http://localhost:4105`. Set the required database, session and isolated sandbox credentials in `.env` before building or using financial routes. The ticket seller and Brightline supplier must have **different PayPal merchant apps**. Locally `.env` is authoritative; hosted environments supply their own variables. Set `APP_BASE_URL` to the exact public origin before deployment.

```sh
npm run typecheck
npm test
npm run test:integration
npm run build
npm run start
```

The integration suite requires local PostgreSQL. Most cases use temporary tenants; the durable worker suite creates and drops a separate schema and kills its own worker process to verify recovery. SDK and signature-postback tests use controlled wire fixtures; they do not make sandbox purchases or establish authentic signed delivery. Actual provider qualification is a separate workflow.

## Working milestone

- A durable private rehearsal; 10 production views; mobile drawer, keyboard search, reduced motion and printable call sheets.
- 82 canonical tasks, 11 critical crew and an excluded reserve; explicit Chicago instants and Denver/Chicago incident arithmetic.
- Twelve stored recovery alternatives with deterministic resource, skill, cost, curfew, rest and approval rules. Independent **real Bryntum Node engine commits** validate proposals. The generator is currently deterministic and labeled accordingly.
- Native Gantt and Scheduler share a browser project and synchronized axis. Baselines, styled dependencies, a native utilization histogram and an independent Calendar are present. Venue day groups and spoken dates use Chicago time.
- Revision-checked plan approval; distinct publication, crew acknowledgment, DOORS, SUPPORT_START and HEADLINER_START gates. A fixture clock change creates no execution evidence.
- Separate controlled crew and supplier clients. Each acknowledgment binds the exact personal sheet version and digest; historical acknowledgments cannot clear the current gate.
- Guarded sandbox rental checkout/callback, $480 nonfinal fee capture, $300 residual authorization closure, itemized ticket checkout and a capture-specific $15 remedy adapter. Operations use current domain authority, durable PostgreSQL identities, provider ownership, fresh budgets and safe reconciliation.
- Payment intents and webhook inbox entries commit their wakeup jobs atomically. Leased PostgreSQL work survives request/process loss; bounded retries expose unresolved outcomes for review. The payment panel shows saved work and authentic-delivery counts separately from configuration.
- Merchant-specific signature verification, duplicate/conflict handling and owned-resource readback are implemented and locally tested. Current adverse reads withdraw readiness while preserving historical receipts. Money milestones and native dependency styles follow that evidence.

A created PayPal order is **not** an authorization or capture. The rental flow requests a $780 authorization from the distinct supplier merchant, captures $480 only after supplier confirmation and attributed delivery acceptance, and retains the $300 hold for a recorded undamaged return. PayPal buyer approval occurs in the official sandbox. An actual browser qualification completed the supplier authorization, nonfinal fee capture and residual hold closure; subsequent provider reads confirm the $480 capture remains completed and the authorization is voided. See the [redacted qualification record](docs/evidence/brightline-rental-qualification.json). Saved-wallet setup and the full bounded cohort remain an upcoming milestone.

## Rehearsal journey

1. Open a rehearsal. Load the labeled flight and console incident sources.
2. Compute recovery alternatives. Preview the rejected artist/rest scenario, then review Protect doors and its explicit approvals.
3. In Execution, advance the labeled fixture clock to 16:10. Review the exact $780 supplier authorization and complete PayPal approval with an isolated sandbox buyer.
4. Open the controlled supplier client, review the exact offer and record reservation confirmation. At 17:15, record controlled department acceptance; at 17:20, review the $480 fee capture.
5. Publish the current run sheet and open individual crew clients. Record acknowledgments by using those clients; none are seeded.
6. Continue the outstanding ticket/remedy, technical, performer and crew evidence. GO stays closed until every current DOORS gate is satisfied.
7. At wrap, record the controlled supplier’s undamaged-return inspection before requesting residual hold closure.

Physical production facts are explicitly controlled rehearsal records. They do not prove a real concert, crew or equipment inspection occurred.

## Capability boundaries

This is an implementation milestone, not a completed submission. Full required scope remains: rider compilation, model-grounded recovery agents, native Bryntum AI and voice, supplier RFQs/holds/compensation and signed handoff, all 80 actual sandbox captures and 38 original-capture refunds, the 11 controlled client acknowledgments, actual-hour approvals and Payouts/invoices, hosted worker and authentic signed-webhook qualification, the second-incident/cancellation branch, tour/network coordination, broader evaluation, real-phone evidence and the filmed demonstration. No participant study or physical proof is fabricated. Planned cohorts and SDK wire fixtures do not satisfy actual provider requirements.

See [architecture and authority](docs/CONTRACTS.md) and [the capability register](docs/CAPABILITIES.md). The private implementation ledger is intentionally not in Git; public documents keep a fresh checkout understandable without it.

## PayPal and APIMatic

The app consumes immutable `@fracture/paypal-core` 0.2.4 and verifies its archive SHA-256. The core uses the real APIMatic-generated **paypal 2.29.0** SDK pinned to `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`; it is not `@paypal/paypal-server-sdk`. Installed operation maps and declaring models inform the integration contract. See [APIMatic setup and usage](APIMATIC_SETUP.md).

Secrets, local plans, private account state and recordings are ignored. Source remains private, with the hosted checkpoint linked above. Each later deployment, webhook registration and demo submission needs its own recorded verification.

## Durable worker and webhook setup

Register each sandbox merchant's stable endpoint separately: `/api/webhooks/paypal/venue` and `/api/webhooks/paypal/brightline`. Store their returned IDs in `PAYPAL_WEBHOOK_ID` and `OPENING_NIGHT_SUPPLIER_PAYPAL_WEBHOOK_ID`. The receiver uses the existing core verifier and the explicit current v2 event catalog in `src/server/payment-webhooks.ts`. It never executes a financial action from a webhook payload.

After reviewing the deployed migration and pending work, configure a secret of at least 32 characters in `CRON_SECRET` and have the deployment scheduler call `/api/jobs/tick` with its Bearer capability. Scheduling is deliberately separate from compiling this route. `npm run worker:once` runs one bounded batch locally and can resume previously approved, proved-undispatched work; use it only against the intended sandbox database. Producer clients may resume due work for their own rehearsal. Neither mechanism resends an ambiguous provider write or creates new approval.

The first durable checkpoint passed 68 domain tests, 52 PostgreSQL/Bryntum/SDK integration tests, TypeScript and the production build. The preserved paid local rehearsal's snapshot hash was unchanged after integration testing. Hosted scheduling and authentic signed delivery are still separate qualification gates. See [durability and webhook boundaries](docs/DURABLE_WORK.md).

## License

Application code and the shared payment core are MIT licensed. Bundled APIMatic context retains its upstream license/provenance. Bryntum requires its own entitlement and is installed from official package distribution, not vendored here.
