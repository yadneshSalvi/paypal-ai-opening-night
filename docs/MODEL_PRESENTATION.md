# Readable saved planning conversations

The native planning popup keeps its reviewed audio and request controls at desktop and mobile widths. Its registered button adapter preserves that popup instead of the installed SDK's narrow-screen drawer substitution. Numeric bounds come from the current visual viewport, including keyboard offsets, and update on resize. Height and width animations are disabled. Escape, close, focus return and destruction remain native behavior.

The planning checklist opens as a compact summary with its real saved-step and pending counts. Its full goal and every step remain in bounded, expandable detail. Checklist completion is planning evidence, never approval or execution. Voice instructions are expandable; an actual recording, permission or playback notice remains visible. Clear draft appears only when editable text exists. The composer is bounded, and the transcript keeps its own scrolling area. Actual native field triggers use44px target styles.

Both restored and live messages use the same small Markdown renderer as the saved React history. It supports paragraphs, headings, lists, emphasis, inline/fenced code and semantic tables. Tables have a focusable horizontal scroll region. Raw HTML, image syntax and unsafe links remain visible inert text. Safe absolute HTTP(S) links require a person's click and open with no referrer or opener. Unsupported or oversized structures fall back to complete escaped text.

Formatting applies only to display copies. The saved provider response, prompt, tool arguments, source references, request identity and authority are unchanged. The native response object is cloned before being handed to the SDK. No model, commercial, crew, source-provider or capability contract changes are introduced by this presentation unit.

The separately reviewed voice-history fix reads first and avoids a stale-cleanup write when no abandoned voice instructions exist. Its original real-PostgreSQL qualification belongs to that fix's owning workstream; this display unit does not access the original model database or credentials.

## Checks

The new deterministic corpus has43 checks:27 formatting/security/bounds,12 installed Enterprise8.0.0 popup/factory/lifecycle and4 mounted React history checks. Another6 saved-history and7 pure voice checks passed. All use explicitly synthetic inputs. The native suite keeps the installed SDK and reviewed popup, with DOM geometry shims; those results are not a real-browser pixel measurement.

Run the self-contained display suite with Node22 and a private, approved Bryntum-license-only configuration:

```sh
node --env-file=/absolute/private/engine-only.env \
  --import ./tests/intelligence-presentation-runtime.mjs --import tsx \
  --test --test-concurrency=1 \
  tests/intelligence-presentation-format.test.ts \
  tests/intelligence-presentation-native.test.ts \
  tests/intelligence-presentation-history.test.tsx
```

The test preload refuses hosted execution, clears provider/database credentials and blocks network/database transport. Its only tooling exception suppresses an unconnected attempt to the exact optional parent IPC pipe from the two pinned tsx4.20.6 clients; no socket is opened. That tooling count is kept separate from transport attempts.

The original native desktop/mobile failures remain retained. Subsequent strict test failures also remain retained: the first tooling guard intercepted optional tsx startup IPC; the initial geometry shim omitted the native layout's offset parent; test setup assumed an incorrect config shape and native empty/visible defaults. The added44px check then found the real field-trigger selector defect. These corrections do not change declared outcomes or saved response data.

Final source, dependency and production-build manifests, offline compiler-IPC audit, original font hashes and privacy closure are recorded with the isolated handoff. The offline build uses only the already approved public font bytes and a nonconnectable build-only module descriptor under strict egress denial. It is not a database/session configuration for a running application.

Real desktop/mobile viewport geometry, transcript scrolling, keyboard and source-reference acceptance on the successor runtime remain the root review gate. The earlier five functional saved-model records stay separate; this unit makes no new model call, human evaluation, payment or external delivery claim.
