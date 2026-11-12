# Original planning requests and model continuity

The production planner uses an explicit stateless Responses contract. Each new request uses `store: false`, `background: false` and a foreground response stream, requests encrypted reasoning items, and retains the complete original request and response. Continuation appends every original output item in order, followed by the exact saved tool receipt. It never uses `previous_response_id`, rewrites an earlier production snapshot, or silently truncates history. A source change is a new appended snapshot. The 64-response and request-size bounds produce a visible hold.

The first `response.created` event is encrypted and retained before the terminal event. Browser recovery binds that original ID and waits for the active stream without a competing provider read. The terminal event and received stream bytes are a second observation of the same HTTP POST, not another create. A stream interruption retains the original ID and permits only its original read; an unavailable or incomplete response cannot be silently replaced. The stream has a 270-second transport bound inside the 300-second route budget. Saved background conversations stay readable but cannot use this continuation transport without their complete compatible history.

Actual account qualification accepted `background:true,store:false` one-shot responses, but their GET bodies omitted encrypted reasoning. A documented include query returned HTTP400: encrypted content could not be requested for persisted responses. All original results and failures are retained. One-shot assessment/compiler output remains distinct from tool continuation; a completed JSON assessment does not need opaque reasoning to be graded locally. The source compiler remains a single-turn, original-ID background job.

The planner still offers seven typed tools. A model can read production data, check qualifications, compare saved alternatives, save an engine-checked proposal, ask for a preference, and maintain an evidence-backed checklist. Producer review remains a separate command. A checklist does not attest physical work.

## Exact access and recovery

New conversations and source compilations retain the original session-token hash and its full PostgreSQL microsecond expiry. Every read, continuation and tool action rechecks the current role and original access. Browser dispatch also carries the original expiry and a purpose-separated access fingerprint, so a never-received instruction cannot adopt a replacement token or a changed expiry.

The browser retains the complete planning instruction before sending. A lost or unreadable response keeps its identity. Recovery first reads the exact original request. Only an explicit review and retry after a missing-result lookup can send the same instruction again; that action checks the original access and reads the original result once more. A confirmed result is recovered without a second create. Historical journals containing only a request ID remain readable and held when their missing content cannot be reconstructed safely.

Each provider POST and original-ID GET retains a private encrypted HTTP observation, request identifiers, status, body digest and outcome. This includes HTTP rejection, unreadable bodies and transport uncertainty. A process interruption between retaining an observation and projecting its state can recover the saved original response locally. Unknown provider create outcomes never cause another provider POST.

Source compilation uses the same storage policy and observation journal. Its separate source review and actual headless engine validation remain unchanged. Explicit source deletion purges eligible private observation bodies while preserving their identities, digests and deletion markers.

## Additive compatibility

Migration 18 adds four scope and observation tables. Existing sessions, requests, failed runs, source selections, tool receipts and provider history are retained. Legacy planning conversations are readable; new continuations require a separately opened conversation with the complete stateless contract. The accepted deterministic evaluation assets keep their original application/source binding.

## Qualification

Controlled tests cover complete ordered reasoning replay, exact tool outputs, stale sources, same-actor replacement tokens, microsecond expiry changes, HTTP failures, process interruptions before and after response binding, original-ID polling, privacy deletion, and explicit browser retry. Mounted tests cover history selection and recovery state; native widget/audio rendering is a separate browser qualification.

The strict controlled runtime refuses an application `.env`, external credentials and provider transport. Load only a new local database, its exact database/role identifiers, a fresh session secret and the licensed engine value. It checks database and role before the client opens a socket. The separately retained live-model report supplies actual provider outcomes; controlled responses are never counted as model accuracy or human evidence.

Official contracts: [Background requests](https://developers.openai.com/api/docs/guides/background), [ordered reasoning context](https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context), [response streaming](https://developers.openai.com/api/docs/guides/streaming-responses), [original response retrieval](https://developers.openai.com/api/reference/resources/responses/methods/retrieve). Observed account behavior and the retained failures take precedence over an assumed transport compatibility.
