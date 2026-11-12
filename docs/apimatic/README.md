# APIMatic evidence

This page records how the APIMatic PayPal Context Plugin and the APIMatic-generated PayPal SDK were used to build Opening Night, and where each PayPal operation lives in the code. Everything below can be checked against files in this repository. Where the record of use is thin, that is stated.

## What is in the repository

| Item | Where | What it establishes |
|---|---|---|
| APIMatic PayPal Context Plugin v0.4.1, complete skill content | `.agents/skills/` (29 skills, 32 files: 9 TypeScript, 11 Python, 9 .NET) | The plugin content was installed for the coding agent that built the integration |
| Upstream manifest, README, MIT license and per-file hashes | `.agents/apimatic-paypal/` (`plugin.json`, `UPSTREAM_README.md`, `LICENSE.txt`, `provenance.json`) | Source repository `context-plugins/plugin-marketplace` at commit `7cbdf85dc95f09d9ede8c5d349506686684fa0d4`, installed 10 November 2026, repository-scoped |
| Installation record and reproducible install command | [`APIMATIC_SETUP.md`](../../APIMATIC_SETUP.md) | How the skills were installed and which skills the implementation used |
| The SDK the plugin targets | `paypal` 2.29.0 from `context-plugins/paypal-typescript-sdk` at commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`, pinned in `package-lock.json` | This is the APIMatic-generated SDK. It is **not** `@paypal/paypal-server-sdk` |
| The payment core that calls the SDK | `@fracture/paypal-core` 0.2.4-opening-invoice.1, installed from `vendor/fracture-paypal-core-0.2.4-opening-invoice.1.tgz`; its `PROVENANCE.json` records the SDK package, version, repository and commit | A small MIT-licensed library: durable operation identity, the SDK adapter, typed REST adapters for APIs the SDK does not cover, and webhook verification |
| Provenance for each vendored core release | `vendor/paypal-core-*.provenance.json`, `vendor/fracture-paypal-core-0.2.3.PROVENANCE.json` | Archive hashes, source hashes and conformance results for every core version consumed |
| Automated pin check | `npm run verify:packages` ([`scripts/verify-packages.ts`](../../scripts/verify-packages.ts)) | Fails if the core archive SHA-256, the `paypal` 2.29.0 version or the Bryntum and Toolkit pins drift |

## How the context plugin was used

`APIMATIC_SETUP.md` records that the PayPal implementation used the plugin's TypeScript integration, client initialization, authentication, endpoint calling, models, error handling, resilience and testing skills, and then read the installed SDK's operation maps and declaring models to write the integration contract in [`docs/CONTRACTS.md`](../CONTRACTS.md).

The code shows the patterns those skills teach for this generated SDK:

- One `PaypalClient` per merchant, constructed lazily (`node_modules/@fracture/paypal-core/src/provider.ts`, `src/server/paypal-providers.ts`).
- Every call goes through a resource accessor and `.asApiResult()` so that an API error is a value to classify, not an exception to guess at, for example `client.orders.createOrder({ ... }, { signal }).asApiResult()`.
- Every write carries a stable `payPalRequestId` saved in PostgreSQL before the call, and an `AbortSignal` with a 25-second deadline. SDK retries are disabled so that a lost response is reconciled by reading the same resource, never by blindly sending again.
- SDK model types (`Order`, `Money`, `PurchaseUnitRequest`, `SetupTokenRequest`, `PaymentTokenResponse`, `CheckoutPaymentIntent`) are imported from `paypal` instead of being redeclared.
- Tests drive the real installed SDK against an injected transport (`tests/payment-wire.test.ts` and the commerce, wallet, cohort and remedy suites), following the testing skill.

**What does not exist.** No transcript or log of individual skill invocations was kept, so this repository cannot show the moment each skill was read. The evidence of use is the installation record, the statement in `APIMATIC_SETUP.md`, the pinned SDK identity, and code that follows the generated SDK's documented call shape. The APIMatic Basic subscription claim mentioned in `APIMATIC_SETUP.md` was not submitted during setup.

## Operation map

The generated SDK exposes five resource groups: `orders`, `payments`, `vault`, `transactionSearch` and `subscriptions`. Opening Night uses the first three. PayPal APIs the SDK does not cover (Payouts, Invoicing, webhook signature verification) go through small typed REST adapters in the same core, with the same request identity and reconciliation rules.

**Evidence** names the strongest retained record: *actual sandbox* means the operation ran against the PayPal sandbox and was independently read back; *controlled* means the installed SDK or adapter ran against an injected transport in tests.

### Through the APIMatic-generated SDK

| PayPal API operation | SDK call | Where it is used | Evidence |
|---|---|---|---|
| Orders v2: create order (intent `AUTHORIZE` for the rental, `CAPTURE` for tickets; optional saved-wallet payment source) | `client.orders.createOrder` | Core `provider.ts`; started by `src/server/payment-service.ts` (rental checkout, ticket checkout) and `src/server/cohort-service.ts` (ticket cohort) | Actual sandbox: [rental](../evidence/brightline-rental-qualification.json), [80 ticket orders](../evidence/original-ticket-cohort-hosted-qualification.json) |
| Orders v2: show order details | `client.orders.getOrder` | Core `provider.ts` reconciliation; `src/server/payment-observations.ts`, `src/server/webhook-ownership.ts` | Actual sandbox: 160 read-only GETs across the ticket audit, of orders and captures |
| Orders v2: authorize payment for order | `client.orders.authorizeOrder` | Core `provider.ts`; rental return callback in `src/server/payment-service.ts` | Actual sandbox: $780 authorization, [rental](../evidence/brightline-rental-qualification.json) and [hosted repeat](../evidence/supplier-hosted-protocol2-qualification.json) |
| Orders v2: capture payment for order | `client.orders.captureOrder` | Core `provider.ts`; ticket capture after buyer approval | Actual sandbox: [80 captures, $3,370](../evidence/original-ticket-cohort-hosted-qualification.json) |
| Payments v2: capture authorized payment (partial, `finalCapture: false`) | `client.payments.captureAuthorizedPayment` | Core `provider.ts`; rental fee capture queued by `src/server/delivery-service.ts` on accepted delivery | Actual sandbox: $480 of $780 captured, [rental](../evidence/brightline-rental-qualification.json) |
| Payments v2: void authorized payment | `client.payments.voidPayment` | Core `provider.ts`; residual hold closure in `src/server/rental-closeout/` | Actual sandbox: authorization `VOIDED`, $300 released, same receipts |
| Payments v2: refund captured payment (partial) | `client.payments.refundCapturedPayment` | Core `provider.ts`; `src/server/remedy-service.ts` | Actual sandbox: [38 refunds of $15, $570](../evidence/original-remedies-hosted-qualification.json) |
| Payments v2: show authorized payment, captured payment, refund details | `client.payments.getAuthorizedPayment`, `getCapturedPayment`, `getRefund` | Core `provider.ts` reconciliation; `src/server/payment-observations.ts` | Actual sandbox: read-back in every receipt above (114 GETs in the refund audit) |
| Payment Method Tokens v3: create and show setup token | `client.vault.createSetupToken`, `getSetupToken` | `src/server/wallet-provider.ts`, `src/server/wallet-service.ts` | Actual sandbox: [save-only wallet, $0 charged](../evidence/wallet-hosted-qualification.json) |
| Payment Method Tokens v3: create and show payment token | `client.vault.createPaymentToken`, `getPaymentToken` | `src/server/wallet-provider.ts`, `src/server/wallet-service.ts` | Actual sandbox: same receipt |

The read-only corroboration in the rental receipt lists the exact SDK calls it used (`orders.getOrder`, `payments.getAuthorizedPayment`, `payments.getCapturedPayment`); see the `corroboration.operations` field of [the receipt](../evidence/brightline-rental-qualification.json). Provider identifiers are published only as SHA-256 hashes.

### Through typed REST adapters in the same core (not covered by the SDK)

| PayPal API operation | Adapter call (`commerce-rest.ts`, `webhook.ts`) | Where it is used | Evidence |
|---|---|---|---|
| Payouts v1: create batch payout | `createPayout` → `POST /v1/payments/payouts` | `src/server/payouts/` (`provider.ts`, `worker.ts`) | Actual sandbox: [one $1.00 payout, $0.25 fee](../evidence/payouts-actual-provider-qualification.json) |
| Payouts v1: show batch and item details | `getPayoutBatch`, `getPayoutItem` | `src/server/payouts/` read-back | Actual sandbox: 2 batch reads, 3 item reads, same receipt |
| Payouts v1: cancel unclaimed item | `cancelUnclaimedPayout` | `src/server/payouts/` | Controlled only; no actual cancellation was performed |
| Invoicing v2: create draft invoice | `createInvoice` → `POST /v2/invoicing/invoices` | `src/server/wrap/` (`provider.ts`, `service.ts`) | Actual sandbox: [one $1.00 invoice](../evidence/invoice-toolkit-assistant-stage16.json) |
| Invoicing v2: send (share link, both email flags false) and cancel | `invoiceMutation('send' \| 'cancel')` | `src/server/wrap/` | Actual sandbox: one share-link issue, one cancel; no email sent; same receipt |
| Invoicing v2: show and search invoices | `getInvoice`, `findInvoices` | `src/server/wrap/` reconciliation | Actual sandbox and [controlled parser regression](../evidence/invoice-response-qualification.json) |
| Webhooks v1: verify webhook signature | core `webhook.ts` → `POST /v1/notifications/verify-webhook-signature` | `src/app/api/webhooks/paypal/[seller]/route.ts`, `src/server/payment-webhooks.ts` | Actual sandbox: [four signed rental events](../evidence/supplier-hosted-protocol2-qualification.json) and 118 signed ticket and refund deliveries reconciled |

### Through the official PayPal Agent Toolkit

`@paypal/agent-toolkit` 1.11.0 supplies three scoped read tools to the wrap finance assistant: `get_invoice`, `get_order` and `get_refund` (`src/server/wrap/toolkit.ts`). The Toolkit is a separate official PayPal package that bundles its own `@paypal/paypal-server-sdk`; it is used only for these reads. Every Toolkit request is intercepted and allowed only if it is a `GET` for the one resource the application already owns. One actual `get_invoice` read is recorded in [the invoice receipt](../evidence/invoice-toolkit-assistant-stage16.json); `get_order` and `get_refund` are covered by controlled tests only. No money-moving Toolkit action is enabled.

## Request and response shapes

Public receipts keep amounts, statuses, counts and hashed identifiers, not raw request or response bodies, so there is no raw PayPal payload to quote here. The shapes the integration depends on are declared in code:

- Request construction: `node_modules/@fracture/paypal-core/src/provider.ts` (orders, payments) and `src/server/wallet-provider.ts` (vault).
- Response parsing for the REST adapters, including the two real response differences found during qualification (a legacy-host invoice link and omitted optional invoice fields): `node_modules/@fracture/paypal-core/src/commerce-rest.ts`, described in [`docs/architecture/invoice-response-compatibility.md`](../architecture/invoice-response-compatibility.md).

## Verify it yourself

```sh
npm ci
npm run verify:packages
node -e 'console.log(require("./node_modules/paypal/package.json").version)'   # 2.29.0
grep -n '"node_modules/paypal"' -A 3 package-lock.json                          # pinned commit
```
