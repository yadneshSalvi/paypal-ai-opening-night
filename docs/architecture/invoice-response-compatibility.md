# Original invoice response compatibility

PayPal may identify a new sandbox invoice with a legacy sandbox href, omit the disabled partial-payment object, and return a nested zero-discount breakdown. These forms now retain the original invoice instead of holding an otherwise matching response as unknown.

The private core variant 0.2.4-opening-invoice.1 changes only invoice href ID extraction. The app and core use the same exact parser. It recognizes the canonical and legacy sandbox hosts with a complete invoice resource path and bounded identifier. It never follows the returned href: OAuth, reads, searches and mutations remain pinned to api-m.sandbox.paypal.com. Payout link handling and other core source remain unchanged.

The [official Invoicing v2 schema](https://developer.paypal.com/api/invoicing/v2/schema.json) documents partial payments as disabled by default and includes nested zero invoice/item discounts. The application accepts an absent partial-payment object or its existing explicit-false shape. A present unknown, null or enabled policy remains blocked. A nested discount requires both invoice and item components, exact USD zero amounts and no extra fields. The envelope retains the complete discount structure; nonzero, null, mixed, incomplete or unknown adjustments remain blocked. Existing identity, date, terms, balance, immutable history and current-authority checks still apply.

An already dispatched uncertain create is reconciled by the existing original-number/reference search and original GET. This change provides no replacement create, renewed grant, new admission, changed expiry or notification path. Issuance and cancellation still require separate exact reviews, with both email flags disabled.

Qualification uses synthetic parties, controlled transport, the installed core and official Toolkit, and isolated PostgreSQL test schemas. All 130 combined regressions pass, including 21 new focused cases; package verification, typecheck and production build pass. This does not qualify an actual financial action. The exact build and archive hashes are in docs/evidence/invoice-response-qualification.json.

Shared ownership remains fracture-lab/packages/paypal-core/src/commerce-rest.ts. This private archive proposal starts from the app's accepted 0.2.4 dependency and does not replace or publish shared core 0.2.7. Its provenance preserves the base qualification separately. The integration owner can apply the source patch and qualify a subsequent shared version independently.
