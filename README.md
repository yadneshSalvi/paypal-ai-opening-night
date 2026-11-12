# Opening Night

**Four hours before doors, the headliner's flight is delayed and the lighting console fails its self-test. Opening Night repairs the show schedule, rents a replacement console with a PayPal authorization that is captured only when the console is accepted, refunds the VIP soundcheck that can no longer happen, sends every crew member the new run sheet, and lets the stage manager call GO only when the evidence supports it.**

It is a production console for the people who run a live show: one model of the schedule, the crew, the equipment and the money, built on Bryntum 8 and PayPal.

**Try it:** <https://paypal-ai-opening-night.vercel.app> (one click, no signup; see [Demo access](#demo-access))

<!-- SCREENSHOTS: the lead captures these from the live app, saves them under docs/screenshots/ with exactly these
     filenames, then removes this comment wrapper. Route and state for each image are listed in the docs-platform report.

![The production plan after the flight delay and console failure: a Bryntum Gantt with the original baseline, the late tasks on the critical path, and the crew utilization histogram below](docs/screenshots/01-incident-cascade.png)

![Recovery studio comparing three named plans: Protect doors and Protect budget can be approved, Protect artist is rejected because two crew members would get nine and a half hours of rest instead of ten](docs/screenshots/02-recovery-comparison.png)

![The planning assistant refusing to put Tom on lighting programming because he lacks the qualification, and offering the qualified options](docs/screenshots/03-planning-assistant-refusal.png)

![Review of the rental commitment before PayPal approval: a 780 dollar authorization, of which 480 dollars is the rental fee and 300 dollars is a damage deposit hold](docs/screenshots/04-review-commitments.png)

![The schedule's money milestones after approval: the PayPal authorization is recorded and lighting focus stays blocked until the console is delivered and the fee is captured](docs/screenshots/05-money-lane.png)

![A crew member's run sheet on a phone, showing what changed for them and the acknowledge button](docs/screenshots/06-crew-run-sheet-phone.png)

![Readiness for doors: every gate satisfied, eleven of eleven crew acknowledgments, and the GO control](docs/screenshots/07-readiness-go.png)

![Box office: eighty ticket captures and thirty-eight partial refunds with their verified PayPal states](docs/screenshots/08-box-office-refunds.png)

![Wrap desk: a Bryntum Grid of budget lines linked to AG Charts cost comparison and waterfall charts](docs/screenshots/09-wrap-desk.png)

![Bryntum Calendar showing the next-day rest conflict for two crew members](docs/screenshots/10-calendar-rest-conflict.png)

![The evaluation ledger page listing the sixty-six predeclared cases and their results](docs/screenshots/11-evaluation-ledger.png)

![The guided tour overlay with a QR code for acknowledging a run sheet from a phone](docs/screenshots/12-guided-tour.png)
-->

## The story in one minute

The show is fictional: *Night Ferries* at Alder Hall, Chicago, 14 November 2026. Everything that happens to it is real application behavior.

1. **Two incidents arrive.** The headliner's Denver flight now lands at 18:55 Chicago time, and the lighting console fails. The Bryntum scheduling engine pushes the delay through every dependent task, in both time zones, and the schedule shows what is now late and who is overbooked.
2. **The app computes rescue plans and rejects the impossible ones.** Each candidate is checked by the real Bryntum engine and by the show's own rules: crew skills, rest hours, curfew, budget, supplier delivery times. Rejected plans stay visible with the reason.
3. **A person chooses and approves.** The producer reviews one plan and its exact costs: $480 console rental, $180 overtime, $570 in VIP refunds.
4. **PayPal secures the plan.** The buyer approves a $780 authorization in the official PayPal window. Nothing is captured yet. Lighting focus stays blocked on the timeline until the console is delivered, a named crew member accepts it, and the $480 fee capture is verified by PayPal. The remaining $300 hold is released after the console is returned undamaged.
5. **The crew gets the new plan.** Each person opens their own run sheet on their phone, sees what changed for them, and acknowledges it.
6. **GO is computed, not declared.** Doors readiness is a checklist of verified facts. If any refund is pending or any acknowledgment is missing, GO is unavailable.
7. **After the show**, approved hours become a PayPal payout, and a wrap report reconciles what was collected, refunded, held and paid.

## Demo access

Open <https://paypal-ai-opening-night.vercel.app> and press **Start the guided tour**. No account or signup is needed; each visitor gets a private copy of the show that nobody else can see or change. Full instructions, including how long each session and link lasts, are in [docs/JUDGE_ACCESS.md](docs/JUDGE_ACCESS.md).

Two ways to explore:

- **Guided rehearsal (recommended).** A private walkthrough of the whole story. The schedule, the Bryntum engine, the AI planning assistant and the crew flows run live. PayPal outcomes in this mode are **replayed controlled outcomes**: no request is sent to PayPal, and every such record is labeled as replayed wherever it appears, so you do not need a PayPal account. The actual sandbox transactions from the original qualification are documented separately under `docs/evidence/`. You can acknowledge a run sheet from your own phone by scanning a QR code; the app labels this as you standing in for a fictional crew member. No real crew phone is claimed.
- **Blank live-sandbox rehearsal.** For anyone with their own PayPal sandbox buyer account: the same journey, where each approval opens the official PayPal sandbox window and each result is read back from PayPal.

Labels used throughout the app: **live** (happening now against the real service), **replayed** (a recorded real sandbox result shown again), **controlled** (the real application code ran with an explicitly declared test input), **modeled** (computed from the fictional show), **sample** (illustrative only).

## Who this is for and what problem it solves

A stage manager, production manager or small-venue producer on show day. When something breaks, the fix today is a group chat, a spreadsheet and a phone: one person works out the new schedule by hand, someone else finds and pays for a replacement, someone else tells the box office, and the crew learn about it late or from an old message.

Opening Night keeps those consequences together. Changing the plan shows who is affected, what it costs, what must be paid or refunded, and who has not yet seen the new call time. The payment and the schedule are linked: a task that depends on rented equipment cannot start until the equipment is accepted and paid for.

## How AI uses PayPal

**The AI never moves money on its own.** Money moves only after an explicit human approval of the exact amount and scope, and only while the application's current records still support it (the approved plan, quote, ticket or liability has not changed or expired). Every write uses a saved operation identity so a retry cannot pay twice, and a result counts only after it is read back from PayPal. A webhook never triggers a payment; it only prompts a fresh read.

The AI's part is upstream and read-only: the planning assistant proposes a rescue plan for review, and the wrap finance assistant reads PayPal records through the official Agent Toolkit and drafts findings for review.

| PayPal capability | What triggers it in the product | Who or what authorizes it | Verified PayPal state it produces | Evidence |
|---|---|---|---|---|
| **Orders: create and authorize** (replacement console) | Producer approves a recovery plan and reviews the supplier hold | Producer approval of the exact $780 commitment, then the buyer's approval in the official PayPal window. No AI tool can start it | Order approved and a $780 authorization on the supplier's separate merchant account | Actual sandbox: [rental receipt](docs/evidence/brightline-rental-qualification.json), [hosted repeat](docs/evidence/supplier-hosted-protocol2-qualification.json) |
| **Payments: partial capture** of the authorization | The assigned lighting lead accepts the delivered console | The fee was approved by the producer at commitment; acceptance is recorded by the named crew member, not the producer | Capture `COMPLETED` for $480, marked not final | Actual sandbox: same receipts |
| **Payments: void the remaining authorization** | Supplier records an undamaged return | Producer reviews the closeout | Authorization `VOIDED`; the $300 hold is released (a released hold, not a refund) | Actual sandbox: same receipts; later closeout journeys are [controlled](docs/evidence/retained-rental-closeout-qualification.json) |
| **Orders: create and capture** (tickets) | Box office sells the 80-ticket cohort | Producer approval of the exact cohort (80 tickets, $3,370 ceiling, 24-hour expiry), plus buyer approval | 80 captures `COMPLETED`, $3,370 total | Actual sandbox: [80 captures, independently read with 160 GETs](docs/evidence/original-ticket-cohort-hosted-qualification.json) |
| **Vault: save a wallet without charging** | Box office asks the buyer to save a payment method | Buyer approves saving in PayPal. Saving reserves no funds and permits no charge by itself | Setup token `VAULTED`, payment token readable, $0 charged | Actual sandbox: [wallet receipt, 20 read-only checks](docs/evidence/wallet-hosted-qualification.json) |
| **Vault: merchant-initiated ticket purchases** from the saved wallet | Producer starts the reviewed cohort | Separate producer approval of the exact cohort; can be stopped; each ticket rechecks authority before dispatch | One order and capture per ticket | Implemented; [controlled tests](docs/TICKET_COMMERCE.md). The public capture receipt above does not record which approval path each capture used |
| **Payments: refund a specific capture** (partial) | A plan cancels the VIP soundcheck; producer reviews the remedy batch | Producer approval of exactly $15 from each of 38 named original captures | 38 refunds `COMPLETED`, $570 total; each $35 admission untouched | Actual sandbox: [38 refunds, independently read with 114 GETs](docs/evidence/original-remedies-hosted-qualification.json) |
| **Payouts** (crew pay) | Crew report hours; producer approves rates and the exact payable | Producer approval of the liability, then a separate approval of the recipient and amount | Batch `SUCCESS`, item `SUCCESS`, fee read separately | Actual sandbox: [one $1.00 payout, $0.25 fee](docs/evidence/payouts-actual-provider-qualification.json). Larger batches are controlled only |
| **Invoicing: create, issue share link, cancel** | Producer prepares an invoice for an approved revenue line at wrap | Producer review of each step; email sending is disabled | Invoice created, link issued, final state `CANCELLED`; $0 collected | Actual sandbox: [one $1.00 invoice](docs/evidence/invoice-toolkit-assistant-stage16.json) |
| **Webhooks with signature verification** | PayPal notifies either merchant endpoint | No approval involved: a verified event only queues a read of a resource the app already owns | Event verified by PayPal's verification API, deduplicated, matched to an owned resource | Actual sandbox: [4 signed rental events](docs/evidence/supplier-hosted-protocol2-qualification.json); 118 signed ticket and refund deliveries [reconciled](docs/evidence/original-remedies-hosted-qualification.json) |
| **Agent Toolkit: scoped reads** (`get_invoice`, `get_order`, `get_refund`) | Producer asks the wrap finance assistant a question | Producer starts the analysis; the app permits only a `GET` of one resource it already owns; every other Toolkit call is refused | A verified read attached to the report, with a digest of the response | Actual sandbox: [one `get_invoice` read](docs/evidence/invoice-toolkit-assistant-stage16.json); `get_order` and `get_refund` are controlled only |

All of this is the PayPal **sandbox**. One owned sandbox buyer made all 80 ticket purchases; that is 80 logical tickets, not 80 people.

## What each AI role does

Every model call is made from the server. Model output is treated as a proposal: a deterministic check or a human approval stands between it and any change to the show.

| Role | Model | How it is configured | Why this choice | What bounds it |
|---|---|---|---|---|
| **Planning assistant** in the Bryntum AI panel. Tools: read the production, check a crew assignment, compare recovery plans, prepare a proposal; plus Bryntum's built-in ask-the-user and planning-checklist tools | OpenAI `gpt-6.1-sol`, reasoning effort `max` | Fixed in `src/server/intelligence/provider.ts`; needs `OPENAI_API_KEY` | Multi-step tool use over the whole production record. Its output is reviewed by a person, so answer quality is preferred over speed | The qualification check is ordinary code (it is what refuses "put Tom on lighting programming"). A proposal must match a plan the Bryntum engine already validated, the producer must review the exact proposal, and approving a plan is a further separate step. It has no payment, crew or cue tools |
| **Voice transcription** | OpenAI `gpt-transcribe` | Fixed in `src/domain/voice.ts` | A dedicated speech-to-text model for short spoken commands (at most one minute) | The transcript appears as editable text and is sent only when the person presses Send |
| **Read-aloud** of assistant replies | OpenAI `gpt-realtime-2.1-mini`, voice `marin` | Fixed in `src/domain/voice.ts`; server-side WebSocket | It only speaks text that already exists, so a small, fast speech model is enough | No tools, labeled as AI-generated audio, opt-in |
| **Source compiler**: turns an uploaded rider, PDF or spreadsheet into a cited schedule proposal | OpenAI `gpt-6.1-sol`, reasoning effort `max`, strict JSON schema, no tools | Fixed in `src/server/sources/compiler.ts` | Long documents with cross-references; errors are costly, latency is acceptable | Every extracted fact must quote its source location or be marked as an assumption; quotes are verified against the file; the Bryntum engine checks the result; the producer reviews before anything is applied |
| **Wrap finance assistant** | OpenAI `gpt-6.1-sol`, reasoning effort `max`, background mode, responses not stored | Fixed in `src/server/wrap/assistant.ts` | Reconciliation questions across many ledger lines, reviewed afterwards | Three tools only: read the account, read one owned PayPal record through the Toolkit, propose a review note. At most eight steps. It cannot create, change or approve any financial record |
| **Recovery strategy agent** (Planning workbench, "Propose with the model") | OpenAI, model from `OPENAI_PLANNER_MODEL` (recorded output was produced with `gpt-6-astra`) | `src/server/intelligence/strategy-agent.ts`; needs `OPENAI_API_KEY` | Proposes diverse typed recovery patches; diversity matters more than latency | Output is untrusted: strict schema check, then the same Bryntum engine proof and domain rules as the deterministic families. Candidates may reference only existing offers, people and tasks. Per-rehearsal and global daily caps. A labeled recorded output (one real run, checked in) can be validated live instead. Database-tested; one real model run recorded; not measured for quality |
| **Communications writer** (server endpoint only; no screen yet) | OpenAI, configured model | `src/server/intelligence/writer-agent.ts`, `src/server/audience/writer.ts` | Drafts attendee notices from approved facts only | A deterministic fact check compares every time, amount and status with the approved plan and ledger before a draft can be saved; a producer still approves through the existing audience path. Tested with a stubbed provider only: no real model run has been recorded and there is no producer screen for it yet |

Notes on configuration, stated plainly:

- Except for the two newer agents (strategy agent and communications writer, which read `OPENAI_PLANNER_MODEL` / `OPENAI_MODEL`), the model names above are constants in the source code. The application does not read `GEMINI_MODEL` at runtime; they appear in `.env.example` and in development configuration (currently `gpt-6.1-sol`, `gpt-6-astra` and `gemini-3.8-flash`). `OPENAI_REASONING_EFFORT` is read only by the offline scripts in `scripts/model-evaluation/`.
- **Gemini is not used.** A key name and a model name exist in configuration, but no code calls a Gemini API.
- The recovery candidates themselves are produced by a deterministic enumerator and validated by the Bryntum engine. A model can propose; it cannot make an infeasible plan approvable.
- Model quality has not been measured broadly. Five actual-model records and their failures are retained in [the product qualification](docs/PRODUCT_COMPLETION_STAGE18.md) and [the planning assistant qualification](docs/evidence/intelligence-live-qualification.json).

## Bryntum features

Bryntum Enterprise 8.0.0 is the scheduling core, in the browser and on the server.

| Bryntum feature | How Opening Night uses it |
|---|---|
| **Gantt** with dependencies, critical path and baselines | The 82-task production plan. Incidents move real dependent tasks; the original approved dates stay visible as a baseline |
| **Scheduler** partnered with the Gantt | Crew and equipment rows share one project and one time axis with the plan |
| **Resource histogram** | Shows the overtime and overbooking that a delay causes, computed from actual assignments |
| **Calendar** | Each person's calls and the next-day rest conflict (9h30 of rest against a 10-hour rule) |
| **Time zones** | The project runs in venue time (America/Chicago); the Denver departure is converted, not retyped |
| **Dependency styling** | The money milestones (authorized, captured, released) are real dependencies whose line style and color follow verified PayPal state |
| **Native AI panel and voice** | The planning assistant, its tools, the ask-the-user choices and the planning checklist run inside Bryntum's AI feature; recording and read-aloud use its voice hooks through this app's server |
| **Node scheduling engine** (`@bryntum/gantt-node-enterprise`) | Every recovery candidate, source proposal and tour change is committed in a headless engine on the server before a person can approve it |
| **Grid** | The wrap desk ledger, linked to the charts beside it |

**Charts.** The cost comparison and cost waterfall on the wrap desk are drawn with AG Charts Community 14.3.0, the charting library Bryntum 8 adopted for its own chart rendering; here it is used directly and linked to the Bryntum Grid's selection. Crew utilization is Bryntum's own resource histogram. <!-- LEAD: add the cost S-curve here once it is integrated, and state whether it uses Bryntum's built-in v8 AG Charts rendering or AG Charts directly. -->

Every row is compiled against the installed 8.0.0 packages. The engine-backed behavior is exercised by the [evaluation](#measured-results). Features that were planned but are not claimed are listed in the [capability register](docs/CAPABILITIES.md).

## APIMatic

The PayPal integration was built with the **APIMatic PayPal Context Plugin** (v0.4.1, installed in `.agents/`) and runs on the **APIMatic-generated `paypal` SDK 2.29.0**, pinned to an exact commit. Orders, Payments and Vault calls go through the generated SDK; Payouts, Invoicing and webhook verification, which the SDK does not cover, use small typed adapters with the same safety rules.

[docs/apimatic/README.md](docs/apimatic/README.md) maps every PayPal operation to its SDK call, the file that uses it and its evidence, and states exactly what record of plugin use exists. Setup is in [APIMATIC_SETUP.md](APIMATIC_SETUP.md).

## Measured results

Only measured values are reported. Where a planned measurement was not made, it says so.

<!-- EVALUATION-RESULTS:BEGIN
     LEAD: after re-running the evaluation on the release commit, update the commit, run ID, date and numbers in this
     block only. Nothing outside this block repeats them. Source file: docs/evidence/evaluation-stage16.json (or its
     successor) and public/evaluation/index.json. -->

**Source binding.** Evaluation run `run-20261112T074915063Z-ba7f8ef4`, 12 November 2026, application commit `96ff4cd`, Bryntum Gantt Enterprise 8.0.0, Node 22.22.3 on one shared Apple-silicon machine. It has not been re-run on later commits. The live results page is [/evaluation](https://paypal-ai-opening-night.vercel.app/evaluation); the machine-readable summary is [docs/evidence/evaluation-stage16.json](docs/evidence/evaluation-stage16.json).

| Planned closing-card measurement | What was measured | Result |
|---|---|---|
| **1. Time and coordination steps from incident to an approved, valid rescue, against a manual baseline** | Computation time for the full set of 12 rescue candidates, each validated by the Bryntum engine (3 repetitions) | Median **379 ms**, slowest of three **651 ms**. Each run: 12 generated, 3 approvable, 7 rejected, 2 pending review |
| | Human time to an approved rescue | **Not measured** |
| | Manual baseline (the same incident handled by chat and spreadsheet) | **Not measured.** No practitioner study was run |
| **2. Hard-constraint admission across the predeclared corpus** | 66 cases frozen before execution (33 single-show, 24 tour, 9 supporting time and readiness checks). A case passes when the outcome matches its predeclared expectation, which is often a refusal | **66 passed, 0 failed, 0 unknown** |
| | Cases expected to be infeasible, rejected or unapprovable | **41 tested, 0 wrongly admitted as feasible** |
| | Cases where the correct answer is "unknown, needs review" | **12 tested, 12 kept as unknown** (none counted as a pass for feasibility) |
| **3. Time from run-sheet publication to all 11 crew acknowledgments** | Real crew response time | **Not measured.** No real crew took part |
| | Controlled check that the count works | In one controlled browser rehearsal, 11 of 11 fictional crew clients acknowledged the current run sheet and the reserve was excluded ([record](docs/evidence/crew-local-qualification.json)). This is a count, not a response time |

Supporting scale measurements from the same run (3 repetitions each; "slowest" is the largest of three observations, not a statistical percentile):

| Workload | Size | Median | Slowest of three |
|---|---|---|---|
| Bryntum project with native resources and assignments | 120 tasks, 100 resources | 67 ms | 247 ms |
| | 500 tasks, 100 resources | 254 ms | 438 ms |
| Tour validation with travel, rest and capacity | 3 shows, 90 calls | 105 ms | 313 ms |
| | 10 shows, 300 calls | 316 ms | 527 ms |
| | 30 shows, 900 calls | 991 ms | 1,233 ms |

Separately, three end-to-end **controlled** journeys (doors, tour and soundcheck variants) ran the real application services from incident to sealed wrap report on commit `47cf2d7`: 547, 568 and 551 application steps, each with 80 ticket captures, 38 refunds and 4 crew cues, and **zero** calls to PayPal or a model ([record](docs/evidence/planning-workbench-qualification.json)). They show the full workflow holds together; they are not timings and not provider evidence.

<!-- EVALUATION-RESULTS:END -->

These are counts over a deliberately adversarial corpus and local timings on one machine. They are not accuracy estimates for unseen productions, not AI quality measurements, and not a latency guarantee. Earlier failed evaluation runs are kept and listed in [docs/evaluation/README.md](docs/evaluation/README.md), which also explains how to reproduce the run.

## What is implemented and what is not claimed

A condensed view of the [capability register](docs/CAPABILITIES.md), which is the complete and authoritative list.

| Capability | Implemented | Evidence level | Not claimed |
|---|---|---|---|
| Schedule, crew, calendar and histogram views | Yes | Browser-checked at desktop and phone widths | Broad assistive-technology and device coverage |
| Recovery planning with engine validation | Yes | 66-case evaluation; browser-checked | A global optimum; measured AI strategy quality |
| Rental: authorize, capture on acceptance, release hold | Yes | **Actual PayPal sandbox**, twice | Physical delivery or inspection |
| Tickets and capture-specific refunds | Yes | **Actual PayPal sandbox**: 80 captures, 38 refunds | 80 real attendees; other currencies or account types |
| Saved wallet and merchant-initiated purchases | Yes | Wallet save: actual sandbox. Cohort from wallet: controlled tests | General merchant eligibility |
| Crew run sheets, acknowledgment, offline shell, signed cues | Yes | Controlled browser rehearsal with fictional crew | Real people, real phones, safety sign-off |
| Crew pay through Payouts | Yes | **Actual PayPal sandbox**: one $1 payout | Payroll, bank posting, larger batches |
| Invoices and Agent Toolkit reads | Yes | **Actual PayPal sandbox**: one $1 invoice, one Toolkit read | Email delivery; any collected invoice payment |
| Webhooks and durable retry-safe work | Yes | Actual signed deliveries reconciled | Behavior under provider outages beyond the tested cases |
| AI planning assistant, voice, source compiler, wrap assistant | Yes | A small number of actual model runs, with failures retained | Measured model accuracy |
| Second disruption, no-feasible-rescue and cancellation branches | Yes | Controlled journeys | Physical disruption or real attendee messaging |
| Tours, supplier administration, production inputs, learning templates | Yes | Controlled journeys; browser-checked | Multi-venue real operation; real supplier ownership |
| Practitioner research and impact | **No** | None | No practitioner study, manual baseline or real crew timing exists |

| Guided judge tour (nine beats, restart, replayed payment outcomes) | Yes | Database suite end to end with zero network egress; browser-checked | Replayed outcomes are not PayPal transactions |
| Run-sheet acknowledgment from the judge's own phone by QR, plus a labeled controlled-device window | Yes | Acknowledgment path covered by the director suite | No real crew member or crew phone is claimed |
| Model-proposed recovery strategies checked by the engine | Yes | Stubbed-provider database tests; one real recorded run | Strategy quality is not measured |
| Communications writer | Server only | Stubbed-provider tests | No screen, no real model run |
| Time-phased cumulative cost chart, print run sheet to PDF through the browser | Yes | Unit tests reconcile the curve with plan cost; browser-checked | Print uses the browser's dialog, not a server-side PDF export |
| Light theme | Built, not switched on | Unit tests | Not visually verified, so no toggle is shown |
| Content-Security-Policy | Baseline enforced; full policy report-only | Header tests | Full policy is not yet enforced |
| Continuous integration workflow | Written | Not yet executed on GitHub | |

## Architecture

```text
Browser (Next.js 16, React 19)
  Bryntum Gantt, Scheduler, Calendar, Grid, AI panel; AG Charts; crew offline shell
        |  same-origin API routes only
Server (Next.js route handlers on Vercel)
  Domain rules ........ plain TypeScript: skills, rest, curfew, budget, readiness, approvals
  Bryntum Node engine . validates every proposed schedule before it can be approved
  Payment core ........ durable operation identity -> APIMatic-generated PayPal SDK -> read-back
  Model adapters ...... OpenAI Responses, transcription and Realtime speech, server-side only
  Durable worker ...... leased PostgreSQL jobs, driven by a one-minute cron and by signed webhooks
        |
PostgreSQL ............ revisioned show state, approvals, payment intents, webhook inbox, receipts
PayPal sandbox ........ two separate merchants: the venue (tickets) and the rental supplier
```

Three rules hold the design together:

1. **One revisioned model.** The schedule, crew, commitments and money share one saved state with a revision number. Every approval names the exact revision and digest it approved; a stale approval is rejected.
2. **Proposals are separate from authority.** The planner, the models and the engine produce proposals. Only a recorded human approval turns one into something executable.
3. **Money follows verified state.** A PayPal write happens once per saved intent, and the app believes the result only after reading it back from PayPal. An uncertain result stays "unknown" for review; it is never retried blindly or assumed to have succeeded.

Details: [architecture and authority contracts](docs/CONTRACTS.md), [durable work and webhooks](docs/DURABLE_WORK.md), and one document per area in [docs/](docs/).

## Run it locally

Requirements: Node **22.x**, npm, PostgreSQL, and a Bryntum Enterprise 8 license key (Bryntum packages install from npm; the license key is not included).

```sh
cp .env.example .env        # then fill in DATABASE_URL, JUDGE_SESSION_SECRET and BRYNTUM_LICENSE_KEY
npm ci
npm run verify:packages     # checks the pinned payment core, PayPal SDK and Bryntum versions
npm run db:migrate
npm run dev                 # http://localhost:4105
```

PayPal features additionally need two **different** sandbox merchant apps (the venue and the supplier); model features need `OPENAI_API_KEY`. `.env.example` lists every variable name. Never commit real values.

Production build: `npm run build` then `npm run start`.

Webhooks, the background worker, the cron secret and deployment notes are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Tests

```sh
npm run typecheck
npm test                    # domain rules, scheduling on the real Bryntum engine, finance, payment policy, crew
npm run test:integration    # needs local PostgreSQL; each suite creates and drops its own schema
node --import tsx --test tests/security-headers.test.ts
```

No test calls PayPal or a model provider: payment tests drive the real installed SDK against an injected transport, and those results are never counted as sandbox evidence. Further focused suites (voice, sources, settlement, payouts, wrap, tour, disruptions and others) are listed in [docs/OPERATIONS.md](docs/OPERATIONS.md). Continuous integration is defined in `.github/workflows/ci.yml`.

### Re-running the evaluation

The evaluation runs without any application secret, database or network access. It needs only the Bryntum license key in a private file.

```sh
# 1. Run all 66 cases and the scale measurements (writes .artifacts/evaluation-stage16/runs/<run-id>/)
env -i PATH="$PATH" node --env-file=.private/root-authorized-engine.env \
  --import ./scripts/evaluation/isolate.mjs --import tsx scripts/evaluation/run.ts

# 2. Publish that run for the /evaluation page, newest first, keeping earlier runs
env -i PATH="$PATH" node --import ./scripts/evaluation/isolate.mjs --import tsx \
  scripts/evaluation/publish.ts <new-run-id> <previous-run-ids...>
```

The runner refuses a full qualification when the application source differs from the commit the corpus was frozen against, so a new release commit first needs a new corpus source binding; [docs/evaluation/README.md](docs/evaluation/README.md) describes that step, the isolation rules and the retained failures.

## Security

- Secrets live only in server environment variables. They are not sent to the browser or to a model.
- Sessions are HttpOnly cookies; only hashed capabilities are stored. Crew, supplier, driver and attendee links are separate, narrowly scoped capabilities.
- State-changing requests check the request origin, a bounded body size, a strict schema and the current revision.
- Webhooks are verified with PayPal before use and never carry authority to pay.
- Security headers and a Content-Security-Policy are set site-wide. A baseline policy is enforced; the complete nonce-based policy currently runs in report-only mode until it has been checked in a browser against a production build. See [docs/OPERATIONS.md](docs/OPERATIONS.md#security-headers-and-content-security-policy).
- Known dependency advisories, all inside the PayPal Agent Toolkit's own dependencies, are reviewed in [docs/architecture/wrap-dependency-review.md](docs/architecture/wrap-dependency-review.md).

## Limitations

- **The show is fictional.** Night Ferries, Alder Hall, the crew, the supplier and the flight are an invented fixture. No concert took place.
- **Controlled declarations are not physical work or real people.** A recorded delivery, inspection, sound check or crew signature in a rehearsal is a labeled test input made through the real application, not proof that anything physical happened or that a real person acted.
- **One sandbox buyer is not 80 people.** All ticket purchases were made by one owned PayPal sandbox account. Sandbox money is not real money.
- **No practitioner study.** No stage manager or production professional was interviewed or observed. There is no manual baseline, no measured time saving and no real crew response time.
- **AI quality is not measured.** A handful of actual model runs worked, some failed and are retained; that is not an accuracy figure.
- **Evaluation numbers are bound to one commit and one machine**, as stated above.
- **Sandbox only.** Production PayPal access, payout funding, tax, payroll and legal working-time rules are out of scope. The rest and curfew rules are settings of this fictional show, not legal advice.
- The guided rehearsal replays recorded PayPal results; only the blank live-sandbox rehearsal makes new PayPal calls.

## License

Application code is MIT licensed; see [LICENSE](LICENSE). The bundled payment core is MIT. The APIMatic context skills keep their upstream MIT license and provenance in `.agents/apimatic-paypal/`. Bryntum is commercial software that requires its own license and is not redistributed here. Other third-party notices are in [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).
