# Wrap desk focus continuity

Async wrap actions retain their initiating control before it becomes disabled. Once the DOM commits the settled state, focus returns only if the same account, actor, role and section are still mounted and the person has not moved elsewhere. A removed or still-disabled control falls back to the section heading. Native dialogs keep ownership of their own opener restoration; crew transfer dialogs are unchanged.

The same rule covers verified PDF/JSON downloads, invoice work and reconciliation, scoped assistant requests, owned-record reads, manual proposals and their error/recovery paths. The original busy, unknown-outcome and exact-request replay guards remain in place. A two-stage invoice reconciliation retains one opener across both requests. Background assistant follow-through does not acquire focus.

At either end of the accessible account table, pagination focuses a labelled page status when its initiating control becomes disabled. The status distinguishes visible rows from the whole-account export denominator. Intermediate pages preserve the initiating control.

Analyze and source links select and focus the destination tab. A live status identifies the analysis cohort or selected source rows. The six tabs retain their existing Home, End and arrow-key behavior.

The assistant initially displays **LOADING ASSISTANT…** while model readiness and retained history are requested. Analysis and owned-provider reads remain disabled until metadata settles. **MODEL UNAVAILABLE** is reserved for a settled unavailable response; a failed metadata read has separate error copy.

## Local verification

Use the pinned Node 22.22.3 toolchain and install the lockfile, then run:

```sh
node --import ./scripts/qa/disabled-providers.mjs --import tsx --test tests/wrap-focus.test.tsx
npm run typecheck
```

The 31 component DOM tests cover async success and error, verified download bytes, explicit click origins, movement away and back, changed account/actor/role, unmount, disappearing controls, exact unknown-request recovery, native-dialog ownership, automatic continuation, all readiness states, both pagination boundaries and programmatic section navigation. Nineteen existing wrap-domain, UI-label and provider-egress cases also passed for this repair.

The DOM tests use synthetic data and stub layout/native-dialog behavior. Dynamic Bryntum and chart modules remain at their server loading boundary in these tests. They do not establish native browser, real file-download, chart, actual-provider or model qualification. Those require their separately recorded acceptance runs.

The focus restoration runs after React's DOM commit, following the documented [layout-effect lifecycle](https://react.dev/reference/react/useLayoutEffect). The DOM test environment has the explicit rendering limitations documented by [jsdom](https://github.com/jsdom/jsdom#pretending-to-be-a-visual-browser).
