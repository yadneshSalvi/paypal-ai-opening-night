# Durable commitments and verified delivery

The app stores a job in the same PostgreSQL transaction that prepares an approved payment intent. A request may complete synchronously, but closing its browser or losing the process does not remove the saved follow-up. Payment identity, exact action, provider request ID and original approval remain immutable.

Workers claim due jobs with `FOR UPDATE SKIP LOCKED`. A 75-second lease has a fresh UUID fencing token; only that token can commit the result before lease expiry. A tick has at most eight jobs and a 50-second execution budget. Retry delay increases to at most one hour, and at most 12 normal attempts lead to an explicit review state. The test suite kills its own child process immediately after a real database claim, recovers the expired lease and rejects the dead worker's completion.

A prepared intent or expired claim that never dispatched can resume only after current domain authority passes. The expired claim is fenced before retrying its same provider request identity. A dispatching or ambiguous operation is reconciled with reads. Refused or proved-unsent terminal operations require an explicit producer retry. A lost create with no known provider ID remains reserved; neither a clock change nor repeated worker ticks send another order.

## Merchant webhook boundary

`/api/webhooks/paypal/venue` and `/api/webhooks/paypal/brightline` use different merchant credentials and registered webhook IDs. `PayPalWebhookVerifier` performs OAuth postback signature verification against the fixed sandbox API. The app accepts bounded JSON and transmission headers, retains a redacted verification audit, and uses an explicit current v2 event catalog. The contract follows PayPal's [signature verification operation](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post) and [event catalog](https://developer.paypal.com/api/rest/webhooks/event-names/).

An event is a wakeup, never a payment instruction or an authoritative balance. Tenant ownership comes from existing merchant resource bindings or exact server-generated intent metadata. Contradictory owners are quarantined. Unknown resources remain unmatched until an actual receipt establishes their owner. That receipt rebinds the inbox and queues its read in the same transaction. Merchant-scoped advisory locking serializes intake and receipt ownership, including simultaneous arrivals. Arbitrary event links are never requested. Refund resources under `PAYMENT.CAPTURE.REFUNDED` retain their refund identity.

The core audit and app inbox are independently idempotent. A redelivery repairs the gap if a process died after the core audit but before the app inbox transaction. The app inbox and its job commit together. Same-ID/different-body events never replace the first verified payload. Unsupported signed events are retained but do not dispatch; invalid signatures are rejected. Verification outages return503 so PayPal can redeliver.

Webhook work only reads and reconciles existing owned intents. It cannot create an order or convert a buyer-approved event into authorization to capture. Fresh readbacks are audited independently of the event's claimed status. A direct capture or refund read whose parent was omitted by core0.2.4 must be corroborated through its exact original order before domain import. The original core receipt remains unchanged.

## Current evidence and history

Current resource observations use a database timestamp and production revision taken before the provider read. A slower older read cannot overwrite a newer observation. Adverse signed updates create a separate reconciliation requirement that immediately holds affected readiness until fresh reads resolve it; a provider outage cannot leave the previous gate green. The event itself still creates no monetary fact. An older in-flight read cannot clear a newer requirement. Local fixture observations cannot replace genuine provider observations. A reversal or inconsistent amount withdraws readiness and GO; historical gross capture and refund receipts remain intact. The original closed Brightline rental remains a78000 authorization,48000 capture and30000 residual release, with zero authorization remaining.

Task completion and financial dependency styles derive from current financial and operational evidence. Completed money edges use green/solid styling; unresolved edges use amber/dashed styling. Clock advancement and a proposed schedule never complete those tasks.

## Operation and evidence

`GET /api/jobs` exposes only the producer's own safe job summaries and authentic delivery counts. `POST /api/jobs` requires the exact browser Origin and can resume due work for that tenant. `/api/jobs/tick` requires the configured `CRON_SECRET` Bearer capability; the deployment scheduler is configured separately. `npm run worker:once` is one bounded local invocation, not an automatically running daemon.

`PAYPAL_WEBHOOK_ID` and `OPENING_NIGHT_SUPPLIER_PAYPAL_WEBHOOK_ID` are registered merchant IDs. Their presence is configuration, not evidence of delivery. The UI counts only `paypal_https` inbox rows as authentic signed delivery. Integration tests inject the actual core verifier's fetch transport at a server-only boundary and persist `local_fixture` provenance instead.

Local proof covers concurrent claims, process death, lease fencing, atomic rollback, bounded retries, signature postback fields, unsigned/malicious certificate rejection, duplicates, conflicts, foreign merchants, exact capture/refund readback, stale observations, current authority and tenant isolation. Actual hosted worker execution and authentic signed deliveries remain required qualification work. The full ticket, supplier, crew, AI/voice, settlement, evaluation and film scope remains active.

## Activation contract

| Seller | App credentials | Registered ID | Stable route |
|---|---|---|---|
| Venue ticket merchant | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | `PAYPAL_WEBHOOK_ID` | `https://paypal-ai-opening-night.vercel.app/api/webhooks/paypal/venue` |
| Brightline supplier merchant | `OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID`, `OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET` | `OPENING_NIGHT_SUPPLIER_PAYPAL_WEBHOOK_ID` | `https://paypal-ai-opening-night.vercel.app/api/webhooks/paypal/brightline` |

Both adapters require `PAYPAL_ENVIRONMENT=sandbox`, `PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com` and `PAYPAL_PROJECT_ISOLATED=true`. The authenticated webhook registration belongs to the exact credential pair in its row. The private venue identity is held in `PAYPAL_SANDBOX_SELLER_EMAIL`; the private supplier identity is held in `OPENING_NIGHT_SUPPLIER_PAYPAL_EMAIL` and `OPENING_NIGHT_SUPPLIER_PAYPAL_MERCHANT_ID`. No credentials or account addresses belong in public evidence.

The app accepts these exact event types for either merchant:

```text
PAYMENT.AUTHORIZATION.CREATED
PAYMENT.AUTHORIZATION.VOIDED
PAYMENT.CAPTURE.COMPLETED
PAYMENT.CAPTURE.PENDING
PAYMENT.CAPTURE.DECLINED
PAYMENT.CAPTURE.REFUNDED
PAYMENT.CAPTURE.REVERSED
PAYMENT.REFUND.PENDING
PAYMENT.REFUND.FAILED
CHECKOUT.ORDER.APPROVED
CHECKOUT.ORDER.COMPLETED
CHECKOUT.PAYMENT-APPROVAL.REVERSED
```

Register the merchant's available supported subset and record any provider capability restrictions; the receiver catalog is not proof that every event can be emitted by that merchant account. A provider simulator fixture is separate from an authentic lifecycle delivery. No repeat of the already settled Brightline rental is required to test this extension.

Run `npm run db:migrate` in the intended deployment environment before enabling worker invocation. `src/server/store.ts` applies schema migration2; `src/server/payment-store.ts` initializes the core/application payment tables and adds `on_payment_imports.readback`. Migration2 adds `on_jobs`, `on_webhook_inbox`, `on_resource_observations`, and backfills initial events while preserving the exact saved snapshot. Use hosted environment injection (`VERCEL=1`) so the local development `.env` override does not select the local database.

Read-only checks after migration:

```sql
SELECT version FROM on_schema_migrations ORDER BY version;
SELECT table_name FROM information_schema.tables
WHERE table_schema=current_schema() AND table_name IN
  ('on_jobs','on_webhook_inbox','on_resource_observations');
SELECT column_name FROM information_schema.columns
WHERE table_schema=current_schema() AND table_name='on_payment_imports'
  AND column_name='readback';
SELECT status,count(*) FROM on_jobs GROUP BY status;
SELECT seller,status,transport,count(*) FROM on_webhook_inbox
GROUP BY seller,status,transport;
```

After registration, inject the two webhook ID names and `CRON_SECRET`, then configure the deployment scheduler for authenticated `/api/jobs/tick` calls. No new public credential or service is required. Root owns production migration, deployment, registration and browser qualification. A code build or successful local fixture does not establish those activation steps.
