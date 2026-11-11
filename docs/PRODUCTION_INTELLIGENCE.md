# Grounded production planning

The production plan contains the installed Bryntum 8 native AI panel. Its seven allowed tools read the current production, check qualifications, compare saved recovery alternatives, prepare an independently validated proposal, ask for a preference, and maintain a native checklist. The panel's default task/store mutation tools are removed. The server enforces this same tool policy; browser history and model-selected authority are never accepted.

For the qualification journey, ask to assign Tom to LX programming. The deterministic skill validator rejects the assignment and supplies its source. Choosing Priya is a preference, not a plan approval. The assistant may prepare a copy of a current recovery candidate; the real Bryntum Node engine validates the proposed graph. The review shows changed, added and canceled calls, changed dependencies, modeled costs and remaining approvals. Saving that exact review adds an alternative to the recovery workbench. The existing separate producer approval and execution gates still control operational changes.

## Durable authority and recovery

Migration 6 adds four planning tables; it does not rewrite financial, crew or production records. Each request binds the exact current session, tenant, actor, production revision and source digest. The complete canonical provider request is encrypted and committed before its single POST. The provider adapter uses OpenAI Responses with `gpt-6.1-sol`, maximum reasoning, background processing and 16,000 maximum output tokens.

Known response identities recover through GET only. A disconnect without a confirmed response identity stays held; automatic replacement requests are forbidden. Terminal output, exact function calls and tool results are immutable. AES-256-GCM payload encryption is tenant and record bound. Every read, tool execution and proposal review checks the current session and role. A returned model response grants no authority.

Server reconstruction uses only persisted user prompts, assistant calls and matching tool receipts. Clients cannot inject assistant history, reorder calls or omit a failed check. Repeated calls return their exact saved result. Native checklist progress requires matching successful receipts at the same production revision and source digest; a completed qualification check can include a rejected assignment. Restoring the native conversation does not dispatch a model request or rerun tools.

Production review binds the proposal digest, source digest, current revision and a durable command identity. The producer must explicitly check the review confirmation. A stale proposal cannot be accepted. Review does not approve a plan, commit money, alter calls, acknowledge another person's instructions, sign technical work or issue a cue.

## Local qualification

`npm run test:intelligence` exercises the domain and disposable PostgreSQL integration cases. Native panel QA has its own schema and cookie on port 4513. It blocks model/payment providers and uses explicitly labeled controlled response fixtures, while exercising real persisted tools and the installed Bryntum engine.

```sh
node --import tsx scripts/intelligence-qa.mjs --init
node scripts/intelligence-qa.mjs --build
node scripts/intelligence-qa.mjs --start
```

`--init` refuses to replace an existing QA workspace. `--refresh` copies changed source without resetting the saved records. Private setup metadata is stored only in ignored `.artifacts/`. Native qualification covers the rejected Tom check, Priya preference, real engine proposal, exact review, reload recovery, 390px layout and keyboard focus return. Controlled browser input is not actual-model, independent-person or physical evidence.

An explicit live qualification driver freezes every tracked source file from a clean committed checkout, creates a separate local schema, blanks payment keys, and records every request and failure. It never uses an existing production tenant. The fixed protocol uses an automated Priya preference and cannot approve the proposal.

```sh
OPENING_NIGHT_QUALIFICATION=live node scripts/qualify-intelligence-model.mjs --prepare --credentials /private/path/.env
# Run from the frozen runtime with its own tsconfig and the printed workspace path:
OPENING_NIGHT_QUALIFICATION=live TSX_TSCONFIG_PATH=/private/output/runtime/tsconfig.json node --import tsx /private/output/runtime/scripts/qualify-intelligence-model.mjs --run --workspace /private/output
```

Preparation does not call the model. The actual run requires the existing server OpenAI key and creates one distinct request per saved continuation. Reports preserve unsuccessful criteria and unknown outcomes. A single qualification case is not the planned incident/tour evaluation corpus.

## Remaining scope

This unit is the native grounded planning foundation. Voice input/output, cited rider/PDF/spreadsheet compilation, broader incident/tour evaluation, practitioner and real-phone evidence remain separate unfinished work. A local passing result does not establish deployment or provider success; release records identify those independently.
