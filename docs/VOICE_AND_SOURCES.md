# Reviewed voice and production sources

The planning desk uses the installed Bryntum 8 audio controller and chat popup. Recording begins only after the operator chooses Record. A transcription enters the editable message field; it cannot dispatch a planning request until the operator chooses Send. Cancel, Clear, hiding the panel and hiding the page suppress late transcripts. Recording is bounded to one minute and 4 MB. Permission denial leaves the complete typed planning flow available.

Read-aloud is labeled AI-generated. It uses the fixed `marin` voice through `gpt-realtime-2.1-mini`, with no tools, automatic turn detection, voice cloning or person impersonation. A server WebSocket bridge verifies the provider session, model, response identity and completion receipt, persists bounded PCM chunks, and returns a verified 24 kHz WAV to Bryntum's native file player. It does not depend on the retiring `/audio/speech` endpoint. Saved audio plays the original bytes without another generation request. Stop and panel/page hiding end playback.

## Media authority and durable identity

Migration 7 adds encrypted voice requests, results, receipts and ordered audio chunks. Each operation is bound to the current production, actor, exact authenticated session, native conversation scope, input hash and fixed model. The immutable request is saved before its one provider dispatch. Exact retries return the original result. Lost or uncertain dispatches remain held; the adapter never reconnects or sends a replacement generation to recover them. The audio record exposes a safe summary and the operator's original transcript or verified WAV.

Native AjaxHelper cannot add the production header used by other mutations. Its fixed endpoints carry the displayed production and conversation scope in their URL, and the server checks those against the current session. Same-origin, role and session checks still apply before dispatch and every read. Media has no operational tools and cannot acknowledge crew instructions, approve a plan, sign physical work or commit money.

The native contract is:

| Endpoint | Input | Result |
|---|---|---|
| `POST /api/intelligence/voice/transcribe?production=<uuid>&scope=<uuid>` | One multipart `audio` file | Plain transcript text and original request header |
| `POST /api/intelligence/voice/speak?production=<uuid>&scope=<uuid>` | JSON `{ "text": "…" }`, up to 6,000 characters | Verified original WAV, streamed after durable completion |
| `GET /api/intelligence/voice?production=<uuid>` | Current authenticated session | Safe audio history |
| `GET /api/intelligence/voice?production=<uuid>&runId=<uuid>` | Exact original request | Original saved WAV |

The transcription model is `gpt-transcribe`. Browser recorder bytes are inspected as WAV, WebM or MP4; a native recorder's misleading filename is not treated as its container format. Inputs, provider responses, output audio and event queues have separate bounds. No credentials, raw provider history or internal reasoning are exposed to the browser.

## Source desk

`/sources` accepts owned or authorized UTF-8 text, Markdown, CSV, TSV, text PDFs and XLSX workbooks. The operator records the source title, purpose, owner, rights basis and confirmation before upload. Every immutable version retains its original hash, bytes, metadata and extraction. Originals are stored as encrypted bounded objects in PostgreSQL, atomically with their source identity; they do not depend on a serverless filesystem or a public upload bucket.

Parsing runs in a separate bounded worker without application environment variables. Text records exact line offsets. PDF text retains page and bounding-box locations. Workbook values retain sheet/cell coordinates, formula metadata and caution notes. The source preview labels a PDF location diagram as a position guide; the original PDF remains available for inspection. Formulas are never evaluated. Scanned pages, cached formulas, hidden content, images, missing facts and unsupported structures remain visible rather than silently becoming verified facts.

Bounds are 4 MB per file, 32 PDF pages, 12 workbook sheets, 5,000 extracted units/cells, 180,000 text characters, 512 ZIP entries and 12 MB inflated workbook content. ZIP preflight rejects encrypted, duplicate, macro, external-link, embedded-object and entity-bearing input. Extraction has a 30-second deadline and a separate heap limit. Failed parsing retains the original file and its failure code; explicit retry re-reads the same immutable source.

The operator chooses up to eight current versions for one compilation. `gpt-6.1-sol` with maximum reasoning receives the exact extracted units and bounded current-production context. It has no tools. A strict graph schema requires all fields, quoted source citations or explicit assumptions, conflicts, unknowns and unsupported requirements. Document text is data, including any attempted instructions in it. A citation check proves the quotation exists at the saved location; it does not prove that the model interpreted the quotation correctly. The review makes that distinction explicit.

## Exact graph review

Migration 8 adds encrypted source objects, versioned extraction, compiler requests and provider output, retained reviews and immutable producer acceptance. The compiler request binds the complete current-production digest, exact source versions, actor and current session before one Responses POST. Known response IDs recover through GET only. The actual resolved model, observed storage flag, original provider receipt and encrypted reasoning remain server-side. An unavailable or unknown original response does not trigger regeneration.

Every supplied citation is checked against the retained extraction. Existing resource identity and qualifications, time zones, availability, exclusivity, dependencies, minimum rest, curfew and source-specific time windows are validated independently. An isolated real Bryntum Node project must return exactly one unchanged interval per proposed task. The producer reviews each source version, every explicit assumption, the complete graph and the final acceptance. The application command binds that exact review digest and the still-current production/source versions. Duplicate acceptance replays its original result.

This unit can apply a graph only to the selected production with its existing admitted roster, before subsequent approval, financial or operational history. The initial fictional published baseline and completed sample preparation are retained. New roster admissions, different productions, tour legs, inventory capacities beyond the existing model, payroll/pay rules and commercial conditions are represented or explicitly flagged and remain uncommitted. Hard policies cannot be weakened through a source import. Completed tasks, published instructions, crew acknowledgments, physical attestations, cues, GO and financial history retain their separate authority. A reviewed source graph changes the working planning data only.

An explicit deletion review purges an unapplied source's private original, extraction and associated uncommitted compiler payloads, while retaining a redacted identity/hash tombstone. Sources supporting an applied graph stay with that graph; a new immutable version can supersede them. Changing a source invalidates unapplied reviews against the prior version.

## Local qualification and remaining gates

Use Node 22 and the existing local PostgreSQL test configuration:

```sh
npm run test:voice
npm run test:sources
npm run verify:packages
```

These test scripts import the provider-disable guard before application environment loading. They use disposable schemas and explicit injected transports. The actual voice and source adapters independently refuse transport in QA mode. The browser fixture preloader is `scripts/qa/voice-source-fixture-provider.mjs`; it must run only from a dedicated runtime whose `.env` contains its own disposable database schema and session secret. It returns labeled controlled transcripts, generated tones and one owned lighting-addendum graph. It never claims microphone capture, natural speech or actual model execution.

At this source handoff, 116 existing unit tests, 189 existing integration tests, 35 voice/source tests and three additional real-engine regression cases pass. The production build passes. Twenty-five HTTP checks on the isolated 4516 build cover source upload/rights/bounds, exact replay, private download, cross-origin/tenant denial, transcription and saved audio identity, real engine review, explicit assumptions, application, source versioning, conflict holds and deletion. The first HTTP audit reached 24 checks before a report-only query used an incorrect table name; that attempt is retained, and the corrected audit passed all 25. These are controlled provider inputs. Payment storage was never initialized by the source/media journey, and no planning request was dispatched by transcription.

Native desktop/mobile/keyboard, actual microphone behavior, actual transcription/Realtime/compiler providers, hosted migrations and deployment are separate qualification gates owned by the release operator. Broader production admission, the full incident/tour corpus, 500-task/100-resource scale, independent practitioner/phone evidence and the full product demonstration remain required work. This source unit does not declare the full product complete.

Provider references: [transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create), [Realtime WebSocket guide](https://developers.openai.com/api/docs/guides/realtime-websocket), [current text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech), and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Parser references: [PDF.js](https://mozilla.github.io/pdf.js/), [ExcelJS](https://github.com/exceljs/exceljs) and [yauzl](https://github.com/thejoshwolfe/yauzl).
