# Authenticated supplier commitments and signed handoff

New rehearsals use `commercialProtocol:2`. Existing saved rehearsals keep their original workflow and exact financial history. The originally qualified Brightline authorization, fee capture and residual release are not recreated by this extension.

## What is real, and what is controlled

Three independently authenticated supplier scopes run at `/api/enrolled-suppliers/{brightline|northside|sister}/rpc`. Requests, immutable quotes and responses use distinct purpose-separated HMAC signatures derived from the existing server session secret. These are enrolled fixture services within this app; the companies, equipment, capacity, drivers and inspections are controlled fictional data. Successful HTTP and database execution is real system behavior, not evidence of a physical rental company or delivery.

PayPal outcomes remain a separate evidence class. A quote, hold, driver scan or condition record never creates financial actuals. Only the existing merchant-specific SDK importer and verified current provider reads do that. The shared core remains the immutable `@fracture/paypal-core@0.2.4` archive.

## Commitment sequence

1. The producer requests three supplier quotes. Each service returns a signed offer revision, console identity, delivery window, driver/condition evidence, fee, deposit and cancellation terms. The sister-venue loan retains its missing driver and condition evidence. A partial collection preserves the existing offers and reuses the same durable request identities after an outage.
2. A real Bryntum Node comparison and explicit producer approval bind the selected quote, production version and decision digest. A provisional hold requires that exact approved quote and explicit consent to its fee only after assigned condition acceptance.
3. The hold reserves the exact unit within this rehearsal's fictional supplier network. PostgreSQL locks the show, then inventory; overlapping active holds cannot use the same unit. Separate rehearsals have separate fictional networks. The ten-minute hold and fifteen-minute quote use real time, independently of the scenario clock.
4. A buyer authorizes the separately reviewed Brightline $780 sandbox order: $480 fee plus $300 damage hold. Authorization creates a durable supplier-confirmation wakeup. Expired capacity cannot become confirmed because a late authorization arrived; its original resource is retained and the supplier must explicitly reconfirm capacity or the producer must review cancellation.
5. The confirmed supplier or producer issues a signed delivery code. It binds tenant, execution, supplier, unit, approved plan, delivery version, a 256-bit nonce and real expiry. Only the nonce hash is stored. Replacement revokes an unconsumed prior code; a lost raw code is never reconstructed from storage.
6. The execution-scoped driver records the current code at the delivery step. A scan is single-use and changes only the attributed handoff. The assigned qualified lighting lead separately reports power-on, accessories and condition, then accepts or rejects. Neither the driver nor another crew member can accept.
7. Acceptance and the producer-approved, original-authorization $480 nonfinal capture intent commit in one transaction. A failed intent insert rolls back the acceptance and its facts. The worker sends or reconciles the same intent; no second fee identity is created. The $300 deposit remains held.
8. At 23:30, the supplier records the ordinary controlled undamaged return. The producer then reviews release of the original authorization's exact $300 remainder through the established payment path.

A confirmed reservation retains its accepted terms after the quote's offer period; the UI labels those terms as reserved. A new proposal still requires fresh applicable terms. Reconfirmation never rewrites the original payment identity.

## Rejection and cancellation

A rejected inspection records a blocker and no fee instruction. Only the scoped supplier can record receipt of that exact rejected unit. This is `returned_unaccepted`, not an accepted delivery or ordinary undamaged-return fact. The producer can then approve cancellation of its still-uncaptured original authorization.

Unfulfilled authorizations also have an explicit cancellation review. Cancellation saves a distinct, immutable `rental_cancel` intent for the exact original $780 authorization. It does not claim a refund. Current SDK reads must prove the authorization is fully uncaptured; any completed or pending provider capture, existing fee instruction, accepted delivery or unknown history blocks dispatch. A lost void response is reconciled under the same operation identity without another write. Only a confirmed provider void closes the execution and removes current authorization availability; historical gross authorization remains visible.

Unused holds can be released without a payment. Once a checkout or authorization exists, its identity remains retained for review. An expired unpaid hold may be explicitly renewed on the same terms and continues its existing checkout. Earlier unresolved executions remain visible when a plan changes.

## Focused interfaces

- `/recovery` contains the signed quote board, source conditions and current revision comparison.
- `/execution` shows quote, hold, authorization, confirmation, handoff and condition steps with real-time lease feedback and explicit commitment/cancellation reviews.
- `/supplier/access` is a supplier-scoped controlled portal for its current reservation, signed QR issue and ordinary or rejected-unit return records.
- `/delivery/access?execution=…` is an execution-scoped driver or lighting-lead client. Private role capabilities and handoff codes arrive in fragments and are removed from the address bar. The code itself grants no role.

The driver can use a same-origin camera, locally decode a QR image, or paste the signed link. Camera permission is enabled only on the delivery page. QR pixels stay on the device. `qrcode@1.5.4` generates the code and `jsqr@1.4.0` independently decodes pixels; a matrix round-trip test verifies their interoperability. Live camera and physical-device behavior require browser/device qualification.

General show APIs reject delivery-only and supplier capabilities; their focused endpoints expose only the fields needed for their role. The existing fictional crew snapshot contract remains a separate forthcoming tightening. No invitation sends an external message.

## Deployment and migration 3

`npm run db:migrate` applies the additive `src/server/migrations/suppliers-v3.ts` migration. It creates six tables: `on_supplier_requests`, `on_supplier_quotes`, `on_supplier_rfqs`, `on_rental_executions`, `on_resource_holds`, and `on_delivery_receipts`. No existing show, session, payment intent or provider receipt is rewritten. Local migration verification compared all five pre-existing saved snapshot hashes, including the original paid rehearsal: all were unchanged.

Use the existing `DATABASE_URL`, `JUDGE_SESSION_SECRET`, `APP_BASE_URL`, merchant credentials and `CRON_SECRET`. No new secret is needed. Optional `SUPPLIER_SERVICE_BASE_URL` selects a trusted fixed service origin; omit it for the normal hosted `APP_BASE_URL` self-service route. It accepts HTTPS or a local loopback HTTP origin, never arbitrary action URLs or redirects. Hosted previews must point to their own source version, or qualification should run after promotion to the stable origin.

The existing authenticated minute tick also processes `supplier_rfq`, `supplier_expire` and `supplier_confirm` jobs. Temporary service failures remain retryable with the existing attempt budget. Invalid authority or signature responses require explicit review. Do not run a provider-mutating worker against the protected original local rehearsal as a way to qualify a fresh protocol-2 flow.

```sql
SELECT version FROM on_schema_migrations ORDER BY version;
SELECT table_name FROM information_schema.tables
WHERE table_schema=current_schema() AND table_name IN
 ('on_supplier_requests','on_supplier_quotes','on_supplier_rfqs',
  'on_rental_executions','on_resource_holds','on_delivery_receipts');
SELECT kind,status,count(*) FROM on_jobs GROUP BY kind,status;
```

Root owns the hosted migration, fixed-commit deployment, browser and sandbox account qualification. The original paid local tenant's later transfer is a separate operation requiring exact-history verification and a single writable database; financial actions must not be replayed to move it.

## Qualification boundary

The isolated supplier suite proves signed request/quote scope, lost responses, partial collections, stale revisions, exclusive inventory, expiry, late authorization, renewal, QR signature/binding/replay, assigned inspection, atomic fee preparation, rejected return, explicit cancellation and SDK request/recovery boundaries. Actual SDK wire fixtures inspect the committed provider claim before a write. They are controlled test responses, not authentic PayPal activity.

The local HTTP pass uses a fresh protocol-2 rehearsal, real supplier routes and real Bryntum commits through approval, hold, replay and unused release. It creates zero payment intents and makes no PayPal call. Fresh hosted protocol-2 provider qualification remains separate from the earlier qualified legacy rental.

The full remaining ticket cohort, refunds, crew execution, model and voice integrations, second incident, settlement, broader production, evaluation and film scope stays active. This unit is not a full-product completion claim.

## Fresh hosted protocol-2 evidence

Root completed the separate hosted buyer, supplier, one-use driver handoff, assigned Priya acceptance and controlled return flow on source `cd0dc628332c921212c693837a9b45c694021c8d`. Independent read-only SDK and PostgreSQL checks confirmed one original $780 authorization, one nonfinal $480 capture, and the exact $300 residual release. Four authentic signed authorization/order/capture/void deliveries reconciled. The physical actions remain controlled fixture reports; a real camera/device qualification is separate. The [safe derived receipt](evidence/supplier-hosted-protocol2-qualification.json) records all 17 checks without private identities.
