# Supplier administration

The producer opens **/suppliers/manage** to admit participating controlled suppliers. Each supplier independently accepts its original private invitation at **/suppliers/manage/owner**, publishes its own inventory and term editions, and delegates bounded negotiation. The producer separately reviews the current production and supplier sources before requesting a signed quote or decline.

The three original supplier services keep their existing discovery list, request ledger, signatures, quotes and obligations. Managed suppliers use additional immutable ledgers and an independent Ed25519 key for each supplier. No supplier can publish another supplier's unit, key, terms or mandate. The supplier owner cookie is HttpOnly and scoped to the administration API; it is separate from the producer cookie.

## Operating sequence

1. The producer reviews the current production, opens a fixed-expiry private supplier access, and supplies that link through an authorized channel. Creating the link sends no message and does not verify a real company or person.
2. The separate supplier owner accepts admission, creates a signing key, declares an individually identified owned unit and availability, and supplies attributed capability, driver and condition sources. Unknown evidence blocks a quote. Inventory supports up to 24 distinct units per managed supplier; the production supports up to 12 managed suppliers.
3. The owner publishes a new immutable term edition for the exact current inventory. Price, deposit, cancellation, scenario ordering deadline, delivery window and real expiry are explicit. Every earlier edition remains retained.
4. The owner reviews its fee/deposit minima and maxima, delivery window, maximum rounds and fixed real expiry. The producer separately reviews its own bounds and exact current RFQ source. Each mandate permits at most 3 rounds and 15 real minutes, clipped to the original source and capability expiries. Terms permit at most 60 real minutes.
5. A deterministic participating service counters only within the intersection of both reviewed mandates. It signs either the exact bounded quotation or a reasoned decline. It cannot invent a driver, condition source, compatible unit or capacity already committed elsewhere. No model or arbitrary external endpoint is called.
6. The producer explicitly admits a chosen signed quotation to the actual production offers. The existing licensed engine evaluates the resulting candidates, and the existing command gateway requires a separate valid plan approval. The administration desk then resumes that plan's exact provisional reservation through the existing hold service.

## Authority and retained history

Every administration command binds a UUID, full body digest, current production revision, actor, session fingerprint and the full fixed expiry including PostgreSQL microseconds. The pending invitation also pins its owner's original fingerprint and full expiry, before admission or owner revocation. Mutations serialize on the production row and recheck current authority. Source checks refresh database wall time after delayed writes, so a lock wait cannot extend an immutable negotiation deadline. Inventory, terms, admission, keys, supplier mandates, reviewed RFQs, negotiation replies, acceptances, revocations and command receipts are immutable. Refused service instructions retain their own original receipt.

Rotation generates a new independent signer. Revocation prevents future authority; old public verification material and signed replies remain available. A retained signature proves the original stored reply's cryptographic provenance. A new commitment additionally compares its signer and every source to the admitted database records, both exact original mandates and the separately approved actual-engine source under lock. An embedded public key cannot substitute for that comparison.

New source editions and original-network RFQ refreshes add a separate current-review marker to the mutable offer projection. They retain the immutable signed quote, original quote identity, status, expiry, financial facts and old rental. The engine refuses the changed source until a distinct managed negotiation is reviewed. A future timestamp is never relabeled as naturally expired because the source changed.

New keys, terms or capacity cannot replace an earlier fee, authorization, accepted delivery, original return obligation or unknown provider outcome. Replaying an administration receipt never dispatches the original financial operation. An unpaid provisional hold can be explicitly released through the original reservation service; payment or fulfillment history requires its existing separate review.

## Merchant readiness and provenance

Managed admission currently has no matching verified merchant adapter. **Actual checkout remains unavailable.** A quotation and provisional hold do not create funds, payment approval, merchant receipt, confirmed delivery or GO. The existing payment authority refuses an unmatched supplier before provider dispatch; the new supplier never inherits Brightline's seller identity.

This implementation admits declared controlled identities and attributed source statements. It does not establish real-world ownership, professional certification, physical condition, delivery, work or independent human participation. Actual external supplier identity and merchant configuration require their own verified integration. The interface and retained source details keep that distinction visible.

## Recovery and access

The browser saves and reads back only the reviewed command and its exact identity metadata before dispatch. An unknown result first reads the original receipt. Only a proven original 404 followed by a fresh matching workspace permits an explicit retry of those same instructions. A different actor, production, session or full expiry cannot adopt them. Reading, refresh and retry never extend authority. Storage failure sends nothing, and a conflicting recovery file remains retained.

The separate desks include pending, refused, expired, revoked and historical-source states, keyboard dialogs, touch targets of at least 44 CSS pixels, a single-column 320px layout, reduced motion and a print stylesheet. Mounted checks do not establish physical-device or native geometry results; the root native review remains a separate gate.

## Schema and qualification

Migration 21 adds only `on_supplier_admin_records`, `on_supplier_admin_keys`, `on_supplier_admin_commands`, `on_supplier_admin_invites` and `on_supplier_admin_requests`. It uses the existing immutable-history trigger and leaves the original service tables and constraints unchanged. The registry may apply 21 independently; the integration owner orders it after the separately owned production-input migration 20.

The focused suite uses real PostgreSQL, actual application services, the installed Bryntum engine, and the installed PayPal SDK over a controlled fetch transport. It covers exact authority/expiry, source changes, key trust and history, bounded fee/deposit negotiation, refusals, immutable replay, races, original obligations and unknown outcomes, additive migration, original-RPC isolation and browser recovery. No test claims an actual PayPal transaction, model call, external message or physical event.

With the separately provisioned local-only configuration, run:

```sh
node scripts/qa/supplier-admin-qualify.mjs
node scripts/qa/supplier-admin-build.mjs
```

The local QA guard accepts only the dedicated supplier database/role on port 55575 and the assigned schema. The offline build uses a nonconnectable descriptor, accepted tracked font bytes, denied external transport and a separate compiler IPC exception. Runtime credentials and private evidence stay excluded from source and build traces. The fixed 4619 native fixture, compiled HTTP qualification, failure register and exact source/dependency/build freeze are private handoff artifacts; they do not grant publication or deployment authority.
