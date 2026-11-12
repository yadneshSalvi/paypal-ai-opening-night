# Native planning controls

This additive UI correction follows the frozen `4c5d3b5` model presentation unit. Its actual native review accepted the readable desktop/mobile transcript and rich saved responses, and retained two further failures: the Close, Send and microphone interactive areas were narrower than 44 pixels; closing an unused voice session replaced its original guidance with an audio-stop notice.

The actual installed widget configurations now give Close, Send, microphone and response-stop triggers explicit 44-by-44-pixel dimensions. Scoped nonshrinking CSS applies to those interactive buttons, independently of their icon glyphs. Native handlers, keyboard semantics and typed drafts are retained.

The popup records audio activity before native hide cleanup. An untouched dialog preserves its original help or prior permission notice. Active recording, unresolved permission, pending transcription, pending read-aloud and active playback still cancel through the original native controller and reviewed audio manager. Late streams are stopped; late transcripts do not enter or send the draft. No provider, server, data, authority or saved-response behavior changes.

Run the new installed-widget regression with an explicitly supplied approved project license, without application credentials:

```sh
node --env-file=<license-only-file> --import ./tests/intelligence-presentation-runtime.mjs --import tsx --test --test-concurrency=1 tests/intelligence-controls-native.test.ts
```

The tests use the real Gantt AIBase factory, ChatButton, reviewed popup and native audio controller. Hardware and audio requests in the active lifecycle cases are explicitly controlled in-memory seams. The transport guard blocks all external and database connections. DOM layout is a controlled shim: explicit interactive dimensions, state transitions and native ownership are measured here; actual browser hit bounds and viewport layout require the next native review.

The original native failure receipt and first failing test logs are retained privately. The first geometry shim was too broad to measure hit boxes; the strengthened regression checks each actual interactive element's explicit dimensions. A later test-only Node/DOM EventTarget mismatch and overly narrow stopped-notice wording were corrected without changing the cancellation invariant. Neither an offline compilation nor these component results constitutes new model/provider or microphone qualification.
