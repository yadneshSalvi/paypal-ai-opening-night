# Proposed immutable core extension for reviewed invoices

Status: a request to the shared-core owner, not an implemented core feature. Opening Night remains pinned to `@fracture/paypal-core@0.2.4`; its application transport guard enforces these requirements around the existing public methods. Existing archives and callers are unchanged.

## Location and compatibility

Implement in the next immutable core release, primarily `src/commerce-rest.ts` (types, parser, guarded methods), `src/index.ts` (exports), and the commerce REST wire tests. Preserve the existing `getInvoice`, `findInvoices`, `createInvoice`, `sendInvoice` and `cancelInvoice` signatures. Introduce explicitly guarded methods; do not silently weaken or redefine old callers' reviewed scope.

Suggested additions:

```ts
interface InvoiceEnvelopeObservation {
  invoice: InvoiceObservation;
  rawDigest: string; // SHA-256 of canonical, complete bounded response JSON
  envelope: ReviewedInvoiceEnvelope;
  envelopeDigest: string;
  observedAt: string;
  httpStatus: number;
}
interface ReviewedInvoiceAuthority {
  owned: OwnedInvoice;
  envelope: ReviewedInvoiceEnvelope;
  envelopeDigest: string;
  reviewedRawDigest: string;
  reviewedAt: string;
  expiresAt: string;
}
type InvoicePreflight = (observed: InvoiceEnvelopeObservation) => Promise<void>;
getInvoiceEnvelope(id: string, signal?: AbortSignal): Promise<CommerceRestResult<InvoiceEnvelopeObservation>>;
sendReviewedInvoice(authority: ReviewedInvoiceAuthority, beforeDispatch: InvoicePreflight, signal?: AbortSignal): Promise<CommerceRestResult<InvoiceEnvelopeObservation>>;
cancelReviewedInvoice(authority: ReviewedInvoiceAuthority, beforeDispatch: InvoicePreflight, signal?: AbortSignal): Promise<CommerceRestResult<InvoiceEnvelopeObservation>>;
```

`ReviewedInvoiceEnvelope` binds exact provider ID, original invoice number/reference, complete invoicer and recipient identity digests, normalized issuer/recipient email, exactly one quantity-one item with its complete purpose/description/unit/tax/discount fields, USD integer unit and total amounts, invoice date, due date, payment-term type, terms/note/memo, and every tip/partial-payment/tax/shipping/discount/custom-charge setting. Null means observed absence, not a guessed default. Reject unsupported or ambiguous economic fields. Opening's current type and parser are in `src/domain/wrap/contracts.ts` and `src/domain/wrap/invoices.ts`.

## Dispatch contract

1. Validate the exact reviewed envelope and its digest, bounded review age, expiry, same original identity and supported operation. Always GET that original invoice immediately before any mutation. Never search for or create a replacement while sending or cancelling.
2. Parse the full fresh bounded response; reject changed issuer, recipient, purpose, item count/quantity, USD amount, date, terms or payment policy. Require a real nonfuture invoice date. Future-dated PayPal invoices can schedule email even when send flags are false, so future/absent/unknown dates cannot enter this no-notification path.
3. Bind `reviewedRawDigest` to the retained review evidence. The fresh raw digest may differ because status, links or provider metadata changed; accept only the explicitly allowlisted non-economic drift after complete envelope equality. Never compare just ID/reference/amount. Supply the full fresh raw and envelope digests to `beforeDispatch` so the application can durably record the observation and recheck tenant/member/role, exact session, admission, revocation and expiry immediately before POST.
4. If preflight rejects or throws, return `not_sent` with no mutation. Send only DRAFT; cancel only supported issued/unpaid states. An already-resolved state may be recovered only with the same full envelope and original identity. Unknown or mismatched states are held.
5. Both POST bodies must contain exactly `send_to_recipient:false` and `send_to_invoicer:false`. No email subject/message, CC/BCC, recipient override, caller amount or default notification. Preserve sandbox origin, redirect prohibition, response limit, timeout and no automatic mutation retry.
6. Once POST may have left the process, preserve `unknown` on timeout, disconnect, unreadable response or failed confirmation. Reconcile with the exact original GET only. A lost create response uses its previously persisted exact number/reference search with complete pagination and exactly one match, never another POST.

The core remains a transport library. It does not invent application approvals, own database locks, extend authority or send email. An application callback is mandatory on the new mutation methods; a caller cannot omit it and obtain an unguarded action.

## Required regression cases

- Every envelope field above changes independently between review and final GET: no POST; include same-amount but changed party address/name and item description, extra recipient, extra zero-priced item, zero-valued extra tax/discount and unsupported currency.
- Absent, future and malformed invoice dates; unknown/malformed payment terms; partial/tip flags absent or true; foreign payer URLs. Fail closed.
- Raw metadata/status drift with identical supported envelope: callback receives the exact fresh raw digest. Economic drift must not be covered by a matching stale digest.
- Current tenant/member/role/session revoked, admission removed, expiry passed, callback throw or callback timeout: no POST, durable preflight retained by the application.
- Concurrent same authority, duplicate response, response loss, create search pagination incomplete/duplicate match: original identity retained, no replacement or automatic retry.
- DRAFT to SHARED and issued to CANCELLED: exact false notification flags; later original GET required. Already-resolved recovery binds the same full reviewed envelope.
- Original payment/refund IDs change amount/currency/date/type or duplicate within/across invoices: no verified collection. PAID status without identified, complete PayPal transactions is not cash.
- Node HTTP/HTTPS/fetch injection proves guard rejection before egress; preserve the first failed test output separately. No controlled run may be described as actual provider qualification.

Primary contracts: [PayPal Invoicing v2](https://developer.paypal.com/docs/api/invoicing/v2/) and [official schema](https://developer.paypal.com/api/invoicing/v2/schema.json). The installed `0.2.4` source is the exact baseline for this extension.
