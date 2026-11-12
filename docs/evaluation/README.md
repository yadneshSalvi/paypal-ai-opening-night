# The rehearsal ledger

This unit evaluates the actual Opening Night domain planner and Bryntum Gantt Enterprise 8.0.0 against fresh fictional inputs. The standalone `/evaluation` page reads immutable saved evidence. It creates no production, session, admission, approval, purchase or provider receipt.

The current result is bound to application base `96ff4cd357c6653f5bdfaaf6177f786762fc81a8`. Evaluator checkout identity, exact source/dependency hashes and application-base equivalence are recorded separately. Committing this evaluation unit does not silently relabel the application's source version. A changed shared application refuses a full qualification until a new corpus source binding is frozen; focused observations remain available with their actual checkout attribution.

## Declared corpus and observed result

The 66-case contract was frozen before execution. It contains 33 single-show and 24 tour cases, plus 6 supporting time checks and 3 readiness checks. All 66 expectations match in the current report. This means neither 66 feasible plans nor AI accuracy: many expectations require a refusal or an unresolved evidence state.

The declared sample records 0 false-feasibility outcomes across 41 cases expected to be infeasible, rejected or unapprovable. All 12 expected unknown/review outcomes remain visible. The three actual negative approval boundaries reject changed source, current quote expiry and insufficient role. No positive approval is granted. These are adversarial corpus counts, not statistical estimates for unseen productions.

- Single-show cases cover delivery, artist arrival, doors sequence, costs, rest, curfew, venue access, skills, resource overlap, source windows, graph identity/cycles, durations, quote/policy revision, unknown supplier evidence and approval boundaries.
- Tour cases cover full-itinerary rest, explicit travel, unknown routes, capacity, overlap, resource kind, skills, availability, assumptions, source windows, dependency buffers, foreign scope and ambiguous onward travel.
- Supporting cases cover DST gaps/folds, elapsed durations, midnight/cross-zone clocks, and the distinction between time/proposals/reserved rows and actual readiness.

The canonical expectation array is identical in all three retained versions: SHA-256 `0b1fd2afe0ed2b57f8f6de41ad273ed9dffed8fd5797526c61aca8fc9fb94826`. The frozen contracts and receipts are in `src/domain/evaluation/corpus-v*.json` and `docs/evaluation/corpus-freeze-v*.json`.

## Separate evidence layers

1. `validatePatch`, `evaluateTour`, `candidatePlan`, `applyCommand`, `readiness` and `financialSummary` are the actual domain functions. Modeled source/availability declarations are explicitly synthetic inputs, not human approvals or physical facts.
2. The product `commitEngine`/`tourEngine` adapters actually commit temporal task/dependency graphs. They do not populate native resource or assignment stores. A passing temporal commit cannot override a domain rest, capacity or qualification failure.
3. The evaluation-owned `commitNativeResources` additionally constructs 100 actual native resource records and one native assignment per task. It checks exact task dates, resource identities, assignment identities/units and nonmutation. This does not prove automatic resource leveling, optimality or browser timeline frame rate.
4. Model quality, manual planning/human intervention studies, publication-to-real-crew timing, provider completion/reconciliation age and later N1/N1b integration remain unmeasured. The report carries explicit pending gates and null human/provider metrics.

## Measured scale

Every size retains three independent measured repetitions within its worker, semantic result digests and pre/post heap observations. First repetitions include cold module loading. Later repetitions reuse that worker's module cache. The host is shared; these are local observations, not portable latency guarantees. Reported p95 is simply the largest of three observations. Heap is the highest observed pre/post value, not transient peak allocation.

| Workload | Population | Invariant |
| --- | --- | --- |
| Actual rescue planner | 12 candidates per run | 12 generated, 3 approvable, 7 rejected, 2 pending; 10 distinct operational patches across 4 family labels; no approvals or canonical-source changes |
| Native ProjectModel |120 and 500 tasks; 100 resources |Actual task/dependency/resource/assignment stores; exact proposed dates; stable repeated semantic results; caller-owned objects unchanged |
| Actual tour domain + temporal engine | 3/10/30 shows; 90/300/900 calls; 100 modeled shared resources |Explicit cross-zone travel paths, rest/capacity/window evaluation; no hard/unknown findings; actual temporal commits; unchanged source inputs |
| Computational cohort | 400 reserved-only rows |No capture ID, no provider evidence, no settled refunds or captured sales; readiness blocked |

Exact timings and hashes are in [the machine-readable qualification summary](../evidence/evaluation-stage16.json) and each linked immutable report. Candidate batch-ready time is an upper bound on time to a useful proposal; the runner does not instrument the first individual useful candidate. No manual-baseline comparison is claimed.

## Retained failures and construction corrections

Nothing was reclassified or overwritten to make the matrix pass.

- V1's first run conservatively failed all cases because the guard counted two optional tsx parent-pipe connections per worker as network attempts. Inspection proved the exact computed temporary pipe and the installed ESM/CJS `connectToServer` call sites. The corrected guard returns an unconnected socket with a local error only for that exact path/callsite. It opens no Unix socket and separately counts suppression; all actual TCP, UDP, DNS, HTTP, TLS and database transport stays blocked. The original report remains failed.
- V1 S22 injected `strike → load-in`, which was not a cycle in the generated graph. V2 reverses an existing dependency to realize the already declared cycle. Required `GRAPH_INVALID` and all other expectations remain unchanged. Both the original input and the corrected input are retained.
- The next run passed 66 cases but failed both native-store sizes: native assignment construction enriched caller-owned objects with `event`/`resource` references. The evaluation adapter now clones resource/assignment configuration before construction. Its actual frozen-input regression verifies that boundary. The failed benchmark's retained input is the observed post-mutation object; its original pre-call digest and deterministic fixture/source hashes are also retained. It is not presented as unchanged input.
- V3 strengthens S32: it supplies an actual successful temporal engine report before expiring the current offer. Missing engine proof can no longer independently explain `PLAN_NOT_FEASIBLE`. It also retains concrete time inputs and the exact foreign-tour request. No expected status, code or numeric result changed.

All previously visible runs remain in the publication selector. Each pointer promotion archives its original bytes as a `publication-<sha256>.json` generation; individual run artifacts are immutable and verified before reuse.

## Reproduce without production authority

Use Node 22 and the pinned install. This qualification used `npm ci --offline --ignore-scripts --no-audit --no-fund` from an existing authorized package cache; it changed no package or lock pin. Cold registry installation is not a measured operation here.

Use a deliberately clean environment. The private engine file contains only the authorized non-provider `BRYNTUM_LICENSE_KEY`, mode 0600. Never copy an application `.env`, session secret, database URL or payment/model credentials. The isolation preload refuses existing authority configuration and an application `.env` file.

```sh
env -i PATH="$PATH" node --env-file=.private/root-authorized-engine.env \
  --import ./scripts/evaluation/isolate.mjs --import tsx scripts/evaluation/run.ts
```

Runs are append-only under `.artifacts/evaluation-stage16/runs/<run-id>`. Each child has a 90-second watchdog, a 1 GiB V8 heap limit and a 32 MiB output bound. A timeout/unavailable result is retained as unknown/unsupported, never a pass. The first nonpassing result is written before the next job. Bounded execution is not a latency target.

Use `--case S32` for a focused actual observation. A focused run cannot be published as a full 66-case result. When integrating later source versions, retain earlier attribution and rerun the affected declared cases; do not relabel an old full report as a new-source qualification.

Publish exact completed run identities, newest first, including all previously published runs:

```sh
env -i PATH="$PATH" node --import ./scripts/evaluation/isolate.mjs --import tsx \
  scripts/evaluation/publish.ts <new-run-id> <previous-run-ids...>
```

The page pins the publication metadata at build time. Report/corpus fetches omit credentials, accept only controlled same-origin paths, enforce byte bounds and verify SHA-256 before display. Delayed responses cannot replace a newer selection. An exact run/case selection survives remount. Failed verification retains only an already verified immutable report and exposes retry. All four match states, empty/loading/error states, keyboard focus and retained history have mounted component regressions. These are not native-browser measurements.

## Local production candidate

The offline font helper accepts an explicitly approved read-only accepted cache ending in `/.next/static`. It reads only compiled CSS and the three exact Latin Inter/Oswald/JetBrains Mono font faces, copies those bytes using APFS COW into the private cache and immutable public/evaluation/fonts assets, and records their hashes. It does not fetch external fonts or read configuration from the source checkout.

```sh
env -i PATH="$PATH" node --import ./scripts/evaluation/isolate.mjs \
  scripts/evaluation/prepare-fonts.mjs <approved-cache>/.next/static
```

Commit the exact qualified source unit before building/freezing. The build helper uses Next's installed offline font-response hook and the project's default Turbopack compiler, inside a macOS sandbox that denies non-loopback native outbound networking. Its build-only descriptor names an unreachable sentinel database and a non-authorizing placeholder session string solely to permit existing module construction. All provider, database and remote transport remains blocked and audited in every process; verified compiler IPC is counted separately. The 4587 runtime never receives those descriptors or the engine license.

```sh
env -i PATH="$PATH" node --env-file=.private/root-authorized-engine.env \
  --import ./scripts/evaluation/isolate.mjs scripts/evaluation/build.mjs
env -i PATH="$PATH" node --import ./scripts/evaluation/isolate.mjs scripts/evaluation/freeze.mjs
env -i PATH="$PATH" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
  node --import ./scripts/evaluation/isolate.mjs scripts/evaluation/serve.mjs
```

The Node guard permits only generated compiler IPC to the exact argument port after verifying that its direct Next parent owns that loopback listener; all other Node transport stays blocked. Compiler IPC is counted separately. It audits zero forbidden outbound/database attempts; the OS sandbox also denies non-loopback native outbound networking. All three served font files must match the accepted cached bytes. Qualification fails if compiled inputs change, private files enter traces, private paths enter static output, or the privately supplied engine value appears in build bytes. The exact source/dependency/production-build freeze is private; mutable `.next/cache` is explicitly excluded. The runtime serves only `/evaluation`, its allowlisted saved evidence and exact `/_next/static` assets on loopback 4587. Every other application page/API and every write method is refused before Next routing. No database, session, model, provider or engine key is configured in the running viewer.

Run the intentional loopback HTTP checks only against that owned frozen server:

```sh
env -i PATH="$PATH" node --import tsx --test --test-concurrency=1 tests/evaluation-http.test.ts
```

Other meaningful checks:

```sh
env -i PATH="$PATH" node --env-file=.private/root-authorized-engine.env \
  --import ./scripts/evaluation/isolate.mjs --import tsx --test --test-concurrency=1 \
  tests/evaluation-contract.test.ts tests/evaluation-engine.test.ts tests/evaluation-evidence.test.ts \
  tests/scheduling.test.ts tests/tour-domain.test.ts tests/bryntum.test.ts
env -i PATH="$PATH" node --import ./scripts/evaluation/dom-runtime.mjs --import tsx \
  --test --test-concurrency=1 tests/evaluation-viewer.test.ts
env -i PATH="$PATH" node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The DOM loader preserves actual CSS hook names for behavior testing; it does not simulate layout or native rendering. Root owns the separate native review. No hosted state, existing production/session, financial fixture, provider or model is used by this unit.

## Retained build qualification failures

The first webpack attempt failed in an existing production-console client import chain to node:crypto. The project's accepted default Turbopack compiler completed the application without a shared-code edit. The strict first Turbopack attempt then exposed required compiler IPC; its narrowly scoped exception checks the generated worker frame, argument port, direct Next-parent audit and actual listener ownership. The native compiler is restricted to loopback by the macOS sandbox, and all other Node transport remains denied.

The closure audit also found expected generated external-package symlinks. Only links under .next/node_modules resolving into this isolated checkout's node_modules are accepted and recorded; arbitrary symlinks remain refused. A later completed build was withheld because native font mocking left a private host path verbatim in CSS. It was never served. The final offline CSS points to the three hash-checked public/evaluation/fonts assets, with their original copyright notices and SIL Open Font License. All original build logs and guarded-process receipts remain in the ignored build history.
