# Native audience review form policy

The private local review chooser and recovery-control pages use `Referrer-Policy: same-origin`. Their password forms contain no key or capability in a URL. This lets a native same-origin POST retain its exact Origin header, which the wrapper still requires. A missing, null or foreign Origin remains forbidden, even with a correct private review key. Audience and attendee product routes keep `no-referrer`.

The original native submission was rejected with403 before a session query, cookie or audience instruction. The prior wrapper's `no-referrer` policy caused the native form Origin to serialize as null. This behavior follows the [Fetch Standard's Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header). The first failed receipt and a focused failing policy check remain preserved privately.

This successor changes only the unbundled local wrapper policy. It reuses the byte-identical qualified production build, original native fixture, database schema and fixed capabilities. It neither renews authority nor repeats fixture preparation. A read-only exact-listener check verifies the chooser policy, strict Origin/key denial, unchanged audience/attendee policies and unchanged original stored rows. Root's native browser submission is a separate acceptance step.
