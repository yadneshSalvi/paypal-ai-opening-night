# The controlled ticket book

The box office implements a save-only wallet request, a separately reviewed eighty-ticket approval, and thirty-eight original-capture remedies. These are implemented workflows with controlled generated-SDK and PostgreSQL tests. When this unit was written, actual venue-wallet capability, eighty live sandbox captures and thirty-eight live sandbox refunds still required separate browser and provider qualification. That qualification was completed afterwards and is recorded separately: [save-only wallet](evidence/wallet-hosted-qualification.json), [80 original captures](evidence/original-ticket-cohort-hosted-qualification.json) and [38 original-capture refunds](evidence/original-remedies-hosted-qualification.json). Test fixtures do not establish those external results.

The previously qualified legacy Brightline rental and the fresh hosted protocol-2 rental retain their original identities. Neither rental is recreated, transferred, refunded, or changed by this extension.

## Exact approvals

| Decision | Amount and scope | Boundary |
|---|---|---|
| Save a wallet | $0 charged; one controlled venue buyer; one-hour save request | The buyer approves saving in PayPal. Saving reserves no funds and grants no ticket charge. |
| Saved-wallet cohort | At most 42 × $35 standard and 38 × $50 VIP purchases; 80 logical tickets; $3,370 USD total | Separate explicit producer review; 24-hour expiry; stop unstarted work; one saved wallet and one original allocation. |
| Individual-approval cohort | The same fixed 80-ticket allocation and ceiling | Each ticket still requires its own official PayPal buyer approval. No saved token is used. |
| VIP remedy batch | Exactly $15 from each of 38 original $50 VIP captures; $570 total | Current approved cancellation, original capture ownership, one immutable allocation per ticket, 24-hour expiry and stop control. Each $35 admission stays intact. |

One controlled buyer is not eighty independent people. Logical ticket count is not attendance. The 400-ticket load fixture is separate and cannot contribute real financial evidence.

Purchase approval records its exact ticket IDs, tier split, amount, venue, show, wallet, actor, version, digest and expiry. An instruction receives final authority immediately before dispatch. A stop prevents subsequent instructions, while an instruction already authorized at that boundary may finish. The UI explains this before approval and before stopping.

## SDK and ownership

The app retains immutable @fracture/paypal-core 0.2.4 and the installed APIMatic paypal 2.29.0 SDK. The venue's existing generated client performs exactly four resolved Vault operations: create setup token, get setup token, create payment token, and get payment token. No token-list or delete operation is added.

The save request uses MERCHANT / IMMEDIATE, a server-created merchant-customer binding, no shipping, a same-origin callback with signed state, and an explicit save-only description. Conversion requires the exact owned setup to be APPROVED. A fresh payment-token read must corroborate the token identity, PayPal source and customer binding. Provider payment-token IDs, customer identifiers and payer hashes stay in private server storage; public projections use local UUIDs and short references.

Saved-wallet Orders use payment_initiator MERCHANT, usage_pattern IMMEDIATE, and usage DERIVED. The installed SDK declaring enum and PayPal's [Orders create reference](https://developer.paypal.com/api/orders/v2/orders-create) define DERIVED so PayPal derives first or subsequent use. Policy independently constructs the saved-wallet grant from the database; it never accepts a caller's token or consent assertion. See the [Vault API](https://developer.paypal.com/api/payment-tokens/v3/).

Every ticket has one durable order identity and, if needed, one capture instruction. A successful create can contain an immediate or pending capture. The app reads that same owned order and direct capture; it never blindly captures again. A lost create with no verified provider identity keeps the logical ticket reserved. An unknown conversion never mints a replacement token.

## Recovery and current truth

The wallet_setup, cohort_ticket and remedy_item jobs use the existing leased worker. The app persists each exact request and stable PayPal request ID before transport. Cohort dispatch is serialized per production approval. A refusal, unknown result, pending capture or buyer-action requirement pauses new tickets. The approving operator may resume the remaining original tickets only after the blocked ticket has a currently verified capture and the same approval remains valid.

Explicit retries reuse only a refused or proved-unsent original request. Unknown writes remain pending. A manually checked job cannot overwrite a running worker's lease. Current wallet ownership and active local authority are checked again before charge dispatch.

Each remedy binds the original ticket, root order and capture. Existing confirmed individual remedies count once; a batch cannot implicitly dispatch a prior individual instruction under a different approval. Individual recovery remains available in its original desk. Completed batch instructions receive fresh reads of the owned order, capture and refund before they count. A partial, pending, excess or inconsistent remedy does not clear the gate.

Historical captures and current qualification are separate. An adverse current read leaves historical gross intact and marks its receipt for review. Explicit original-ticket readback can restore current qualification only after the provider corroborates the same owned resources. It cannot create a replacement payment.

## Routes and UI

GET /api/commerce returns only the current producer's production and safe wallet/cohort/remedy projections. It performs no provider write. POST /api/commerce requires the exact request origin, current producer session, a bounded 8 KiB body, strict action schema and the relevant reviewed digest/revision. Caller-supplied provider IDs or alternative amounts are not accepted.

The box office provides separate save-only, purchase, refund, stop and retry reviews; loading/error states; exact totals and expiry; current progress; original-capture references; and a paginated ticket/remedy ledger. The initial payment desk also waits for saved payments before offering another checkout. /wallet/return confirms the exact saved method without treating it as charge consent. A reload after successful return reads existing state.

## Additive migration 4

src/server/migrations/commerce-v4.ts adds these seven tables:

~~~text
on_wallet_setups
on_wallet_operations
on_saved_wallets
on_ticket_cohorts
on_cohort_tickets
on_remedy_batches
on_remedy_items
~~~

The migration rewrites no saved-show snapshot or financial receipt. Root owns hosted backup, migration and release from a frozen source archive. The original local paid tenant is outside this migration operation.

Run the established npm run db:migrate with the intended hosted environment injected and VERCEL=1, then verify:

~~~sql
SELECT version FROM on_schema_migrations ORDER BY version;
SELECT table_name FROM information_schema.tables
WHERE table_schema=current_schema()
AND table_name IN ('on_wallet_setups','on_wallet_operations','on_saved_wallets',
  'on_ticket_cohorts','on_cohort_tickets','on_remedy_batches','on_remedy_items')
ORDER BY table_name;
SELECT count(*) FROM on_wallet_setups;
SELECT count(*) FROM on_ticket_cohorts;
SELECT count(*) FROM on_remedy_batches;
~~~

Compare the exact saved-show snapshot hashes before and after. New tables should be empty before user-approved setup. Do not execute a worker against an unintended database: it may resume previously approved work.

No new secrets or webhook registrations are required. This uses DATABASE_URL, JUDGE_SESSION_SECRET, the existing venue PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, the existing sandbox/isolation settings, APP_BASE_URL, and the already configured CRON_SECRET and merchant webhook IDs. Actual Vault availability belongs to that venue merchant app and is a provider qualification gate, not something configuration alone proves.

## Qualification sequence

1. Locally review the empty box office, wallet save-only screen and individual-approval draft without completing any provider action. Check keyboard focus, 320/390px layout, exact amounts, loading/recovery and cookie/origin boundaries.
2. After reviewed hosted migration/deployment, use a fresh intended hosted production. Root performs the official controlled buyer's save-only approval. Independently verify the owned token/customer association and zero charge.
3. Review and approve the exact $3,370 / 80-ticket grant. Run the bounded saved work and observe original results; stop on unsupported capability or unresolved provider outcomes. Use individual PayPal approvals when the merchant cannot support the saved-wallet route. Never silently replace an unknown instruction.
4. Verify exactly 42 standard and 38 VIP original captures totaling $3,370, with no duplicate logical ticket or money write.
5. Review the current canceled-perk plan and exact 38-capture allocation. Approve $570 total remedies, preserving all $35 admissions. Verify 38 original-capture $15 refunds, $2,800 total retained admission and authentic signed reconciliation separately.
6. Preserve both prior rental histories and all new receipts. Eleven current controlled crew acknowledgments, AI/voice, full settlement, broader production, evaluation and film work remain separate full-plan requirements.
