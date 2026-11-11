# Personal crew authority and offline readback

The crew client is `/crew/access`. A producer creates a private, 24-hour link from Crew readback or an assigned duty desk. Its fragment capability is removed from the address bar immediately and retained only in that tab's session storage. Opening a link sends no external message and records no acknowledgment.

These are controlled fictional identities. A recorded client action proves application participation, not worker attendance, a physical inspection, or performance in a real venue.

## Private API boundary

`GET /api/crew` requires the explicit personal Bearer capability. It ignores producer cookies and returns a strict allowlist: the person's public identity, own published calls and changes, exact sheet identity, own readback and signed history, assigned duties/cues, necessary aggregate readiness, access expiry, and own next-call/rest calculation. It excludes the production snapshot, other workers' assignments/rates, supplier documents, financial amounts and provider resource IDs. Both success and error responses are private and `no-store`.

`POST /api/crew` accepts a strict, bounded envelope with a UUID `idempotencyKey`, `expectedRevision`, and one permitted command. Person, role, tenant and permissions come from the server-held capability and current roster; they cannot be supplied in the body. The server checks capability expiry/revocation again after acquiring the production lock and before looking up an exact replay. Reads also check current access under the production transaction.

Crew, supplier and delivery capabilities cannot use the general `/api/show` response. A production operator cannot acknowledge, sign a technical duty, issue GO, open the house, or start an act through the producer command API.

`/api/crew/access` lets a producer review and revoke the current links for one rostered person. The reviewed request has an immutable UUID and revision. Exact replay preserves its original result and cannot revoke a new link created later. Revocation denies subsequent access and replay; it preserves previously recorded history and does not change the completed action's provenance.

## Publication and durable readbacks

An acknowledgment binds the exact published sheet version/digest and the changed task IDs the person reviewed. A newly published digest resets the changed-call checkboxes. Acknowledging a known older sheet is permitted, but is explicitly historical and never clears the current gate. Only the 11 active critical crew count; the reserve is separate.

The client stores a versioned, scoped cache under the capability's complete SHA-256 fingerprint. It records cache age and access expiry and rejects malformed, mismatched, future-dated or expired copies. The raw Bearer is never stored in local storage.

A queued readback is saved before sending, including one immutable UUID, person, sheet version/digest, reviewed changes, offline provenance and creation time. Its first attempted revision is saved before the request. A timeout, unreadable reply or server failure keeps that exact envelope for recovery. Only an explicit `STALE_REVISION` rejection permits a checked revision under the same UUID, because that response means no command committed. The client checks personal server history before replaying and identifies already-recorded or historical results. A readback completed through another personal request is identified as such, rather than claiming the queued UUID was executed.

Live signoffs and cues require a current online review and explicit confirmation. They are never sent automatically after reconnecting. An uncertain live request keeps its exact reviewed envelope; the user can check its receipt or explicitly retry that envelope. A rejected stale review remains open with a visible explanation and requires a fresh review. The dialog preserves the originally reviewed scenario time and revision; changed context is shown separately. Opening a fresh review clears earlier action feedback. Damaged queues can be downloaded and explicitly removed after checking server history. Ended access does not erase saved recovery data or transfer authority to another link.

The old truncated-key full-snapshot cache is removed during upgrade. An older queued draft has no recoverable request identity, so it is preserved separately for download and explicit review; it is never silently discarded or upgraded into an authenticated replay.

## Offline shell

The service worker at `/crew/sw.js` is scoped only to `/crew/`. The personal page reports **Offline reload ready** after it has saved an anonymous `/crew/access` shell and the required same-origin static scripts/styles/fonts. Open a personal link online once and wait for that indicator before relying on offline reload. A first visit cannot work without an initial shell. Unsupported browsers display that limitation explicitly.

The worker never caches API responses, writes, RSC requests, producer pages, foreign assets or capabilities. Scoped personal data and queued identities remain in the separately versioned client store. Reconnection refreshes state but does not automatically post a readback or live cue. Cached readiness is visibly stale and cannot authorize a live action. A disconnected device learns of server revocation when it reconnects; its cached access still expires locally. The personal call list remains available when the native Calendar's optional assets could not be loaded.

## Signed duties and separate cues

Permission comes from canonical skills and current task assignments, not the producer's broad fixture roles.

| Person | Permitted duty or cue |
|---|---|
| Tom | Assigned lighting focus; never programming |
| Priya | Assigned lighting focus and qualified programming/cue checks |
| Dana | Support sound readiness and headliner quiet-preparation review |
| Avery | Support-first house plan and separate HOUSE OPEN |
| Sam | Performer check-ins, stage changeover, DOORS GO, SUPPORT START, HEADLINER START |
| Other active crew | Own exact-sheet readback |
| Reserve | Own readback, excluded from the critical 11; no technical or cue authority |

Each attestation/cue binds tenant, show, actor, person, command UUID, plan version/digest, sheet version/digest, policy version, actual received time, labeled scenario time, revision, and reviewed detail. The server signs a context-separated HMAC. A missing verifier fails closed. Forged, superseded, unassigned or old-plan records cannot clear current readiness. The client shows the signature fingerprint and attributable receipt; it does not receive the signing secret. Retain the server signing key for existing receipts; an unplanned secret rotation cannot silently re-certify them.

Focus and programming require accepted delivery and the currently verified original fee capture; programming additionally follows focus. Support sound follows performer check-in and technical clearance. Quiet preparation follows headliner check-in. Changeover follows the separate support cue, quiet preparation and technical clearance.

DOORS has eight current gates. Sam's reviewed GO does not itself open the house. Avery records HOUSE OPEN at or after the published doors time. SUPPORT_START additionally requires current production clearance, HOUSE OPEN, support check-in, sound and technical readiness. HEADLINER_START requires current production clearance, the support cue, headliner arrival, quiet preparation and changeover. Each stage start is a distinct signed action at or after its canonical scheduled time. Advancing the scenario clock never creates one.

## Calendar and real rest intervals

The personal native Bryntum Calendar and accessible call list use the same own-call IDs and UTC instants. Calendar remains an independent model; it does not receive a production-wide roster. Zero-duration milestones retain their exact instant. Saturday/Sunday navigation exposes the actual next-day matinee call for Sam and Priya.

Rest is calculated from that person's last published finish to their next assigned call, against the policy minimum. The Protect doors fixture gives 23:30–10:00, or 10h30. The late-finish fixture gives 00:30–10:00, or 9h30 and a failure. Missing finish data is unknown; no next call means unassessed. Access expiry is never substituted for a work finish.

## Saved rehearsals and evidence

New rehearsals use crew protocol 1. Older snapshots keep their original facts, acknowledgments and money. A producer explicitly adopts person-scoped controls; adoption retains history, requires fresh personal evidence and returns legacy GO/HOUSE OPEN to standby. Old operator facts are shown as legacy history and are never converted into signed participation. No SQL schema migration or financial replay is required for this additive protocol.

Local QA can use `OPENING_NIGHT_QA_FIXTURE=1` only on a separate local database/schema with all venue/supplier credential fields blank. Hosted environments cannot activate that label. Provider access is rejected before construction or dispatch, financial controls are hidden, and money labels/exports name controlled inputs. Initial supplier, delivery, authorization, fee and remedy prerequisites are explicit fixtures; crew acknowledgments and signed cues start empty. This rehearsal cannot qualify actual payments.

The [local crew qualification](evidence/crew-local-qualification.json) records the controlled native client sequence, offline reload/sync, revoked reserve access, stale-review rejection, mobile/keyboard observations and independent signature audit. These checks do not replace a physical phone or real participants.

The original 80 sandbox captures and 38 refunds have their own independent provider audits in [capture evidence](evidence/original-ticket-cohort-hosted-qualification.json) and [remedy evidence](evidence/original-remedies-hosted-qualification.json). Local crew records never replace or replay those originals. Physical-phone use, real worker participation, wider accessibility/stress coverage, and the remaining product work retain separate qualification requirements.
