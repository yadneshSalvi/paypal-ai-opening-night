/** Explicit live-model qualification. Creates its own local schema and immutable source copy. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile, symlink, open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "dotenv";
import { Pool } from "pg";

const source = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2), command = args[0];
const option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const destination = path.resolve(option("--workspace") ?? path.join(source, ".artifacts/intelligence-live-v1"));
const hash = value => createHash("sha256").update(value).digest("hex");
const save = (name, value) => writeFile(path.join(destination, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const protocol = {
  version: 1, case: "qualified-programmer-and-reviewed-alternative", model: "gpt-6.1-sol", reasoning: "max",
  prompt: "Assign Tom to LX programming so we can protect doors. Start a visible planning checklist, read the current production, and check the actual qualifications. Show any rejection with its source and ask me to choose a qualified alternative. Compare the already saved recovery plans and prepare an alternative for my separate review. Do not approve a plan, pay anyone, sign work or change active calls.",
  scriptedPreference: "Use Priya for LX programming and protect the 19:00 doors. Prepare the exact alternative for separate review only; do not approve or apply it.",
  maxResponses: 32, perResponseWaitMs: 30 * 60_000,
  expected: ["Tom rejected by saved qualification", "native askUser requests a qualified alternative", "Priya qualification checked", "a feasible real-engine proposal saved", "all four checklist steps proven", "active production unchanged", "no financial or crew actions"],
  disclosure: "Actual model with a fictional production and an automated scripted preference; no independent human or physical evidence.",
};

if (command === "--prepare") {
  if (process.env.OPENING_NIGHT_QUALIFICATION !== "live") throw new Error("Explicit OPENING_NIGHT_QUALIFICATION=live is required");
  const credentials = option("--credentials"); if (!credentials) throw new Error("Provide the private credentials file with --credentials");
  execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: source });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: source, encoding: "utf8" }).split("\0").filter(Boolean);
  await mkdir(destination, { mode: 0o700 }); // A prior attempt may never be overwritten.
  const runtime = path.join(destination, "runtime"), manifest = [];
  for (const name of names) {
    if ((/^\.env(?:\.|$)/.test(name) && !name.endsWith(".example")) || /^(?:plans\/|\.artifacts\/|\.git\/)/.test(name)) throw new Error("Private path is tracked");
    const bytes = await readFile(path.join(source, name));
    await mkdir(path.dirname(path.join(runtime, name)), { recursive: true });
    await copyFile(path.join(source, name), path.join(runtime, name));
    manifest.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  await symlink(path.join(source, "node_modules"), path.join(runtime, "node_modules"), "dir");
  const original = parse(await readFile(path.resolve(credentials))), url = new URL(original.DATABASE_URL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Only a new local PostgreSQL schema is permitted");
  if (!original.OPENAI_API_KEY) throw new Error("The actual model key is not configured");
  const schema = "on_ai_live_" + randomUUID().replaceAll("-", ""), admin = new Pool({ connectionString: url.href, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`); await admin.end(); url.searchParams.set("options", "-c search_path=" + schema);
  const environment = { DATABASE_URL: url.href, JUDGE_SESSION_SECRET: randomBytes(32).toString("base64url"), BRYNTUM_LICENSE_KEY: original.BRYNTUM_LICENSE_KEY ?? "", OPENAI_API_KEY: original.OPENAI_API_KEY, GEMINI_API_KEY: "", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID: "", OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET: "" };
  await writeFile(path.join(destination, ".env"), Object.entries(environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
  await save("source-manifest.json", { revision, files: manifest, digest: hash(JSON.stringify(manifest)) });
  await save("protocol.json", { ...protocol, digest: hash(JSON.stringify(protocol)) });
  await save("state.json", { revision, schema, protocolHash: hash(JSON.stringify(protocol)), conversationId: randomUUID(), fixture: null, steps: [], complete: false, preparedAt: new Date().toISOString() });
  console.log(JSON.stringify({ prepared: true, revision, files: manifest.length, workspace: destination, actualProviderCalls: 0 }));
} else if (command === "--run") {
  if (process.env.OPENING_NIGHT_QUALIFICATION !== "live") throw new Error("Explicit OPENING_NIGHT_QUALIFICATION=live is required");
  if (source !== path.join(destination, "runtime")) throw new Error("Run the frozen runtime copy of this driver");
  const manifest = JSON.parse(await readFile(path.join(destination, "source-manifest.json"), "utf8"));
  for (const item of manifest.files) if (hash(await readFile(path.join(source, item.path))) !== item.sha256) throw new Error("Frozen runtime changed: " + item.path);
  const state = JSON.parse(await readFile(path.join(destination, "state.json"), "utf8"));
  if (state.protocolHash !== hash(JSON.stringify(protocol))) throw new Error("The qualification protocol changed");
  if (state.complete) throw new Error("The completed qualification is immutable; inspect its report");
  const lock = await open(path.join(destination, "runner.lock"), "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  let database;
  try {
    process.chdir(destination);
    for (const key of Object.keys(process.env)) if (/OPENAI|GEMINI|PAYPAL|CHANNEL3|ANTHROPIC/.test(key)) process.env[key] = "";
    delete process.env.VERCEL; delete process.env.OPENING_NIGHT_AI_QA; delete process.env.OPENING_NIGHT_QA_FIXTURE;
    Object.assign(process.env, parse(await readFile(path.join(destination, ".env"))));
    const dbUrl = new URL(process.env.DATABASE_URL);
    if (!["localhost", "127.0.0.1"].includes(dbUrl.hostname) || dbUrl.searchParams.get("options") !== "-c search_path=" + state.schema) throw new Error("Qualification database identity changed");
    database = new Pool({ connectionString: dbUrl.href, max: 6 }); globalThis.openingNightPool = database;
    const { migrate, createSession } = await import(path.join(source, "src/server/store.ts"));
    const { applyCommand, recordRescueRun } = await import(path.join(source, "src/domain/commands.ts"));
    const { generateCandidates } = await import(path.join(source, "src/server/engine.ts"));
    const { sessionTokenHash } = await import(path.join(source, "src/server/session-records.ts"));
    const { startIntelligence, readIntelligenceRun, planningProvider } = await import(path.join(source, "src/server/intelligence/provider.ts"));
    const { executeIntelligenceTool, intelligenceWorkspace } = await import(path.join(source, "src/server/intelligence/tools.ts"));
    const { readIntelligenceConversation } = await import(path.join(source, "src/server/intelligence/ledger.ts"));
    const { digest } = await import(path.join(source, "src/domain/hash.ts"));
    await migrate();
    if (!state.fixture) {
      const session = await createSession(undefined, "live-intelligence-qualification-" + state.schema), show = session.show;
      delete show.commercialProtocol; show.title = "Fictional live-model qualification";
      const disrupted = applyCommand(show, session.actor, { type: "load_incidents" });
      const candidates = await generateCandidates(disrupted), prepared = recordRescueRun(disrupted, session.actor, candidates);
      await database.query("UPDATE on_shows SET snapshot=$2,revision=$3 WHERE tenant_id=$1", [show.tenantId, prepared, prepared.revision]);
      state.fixture = { tenantId: show.tenantId, actor: session.actor, sessionHash: sessionTokenHash(session.token), initialDigest: digest(prepared), preparedAt: new Date().toISOString() };
      await save("state.json", state);
    }
    const authority = { actor: state.fixture.actor, sessionHash: state.fixture.sessionHash }, provider = planningProvider();
    if (provider.mode !== "live_model" || !provider.configured) throw new Error("Actual model adapter unavailable");
    let afterRunId = null, prompt = protocol.prompt, terminalReason = "response_bound";
    for (let sequence = 0; sequence < protocol.maxResponses; sequence++) {
      let step = state.steps[sequence];
      if (!step) {
        step = { command: { requestId: randomUUID(), conversationId: state.conversationId, afterRunId, prompt }, preparedAt: new Date().toISOString() };
        state.steps.push(step); await save("state.json", state);
      }
      let run = await startIntelligence(authority, step.command, provider);
      const until = Date.now() + protocol.perResponseWaitMs;
      while (["dispatching", "running"].includes(run.state) && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, Math.max(2500, run.retryAfterMs)));
        run = await readIntelligenceRun(authority, run.id, provider);
      }
      step.runId = run.id; step.state = run.state; step.observedAt = new Date().toISOString(); await save("state.json", state);
      console.log(JSON.stringify({ event: "saved_response", sequence: sequence + 1, state: run.state, elapsedMs: Date.now() - Date.parse(step.preparedAt) }));
      if (run.state !== "completed") { terminalReason = run.state; break; }
      afterRunId = run.id; prompt = null;
      const calls = run.result?.choices[0].message.tool_calls ?? [];
      if (!calls.length) { terminalReason = "assistant_finished"; break; }
      for (const call of calls) {
        const value = JSON.parse(call.function.arguments);
        const receipt = await executeIntelligenceTool(authority, { runId: run.id, callId: call.id, name: call.function.name, args: value });
        step.receipt = { name: receipt.name, ok: receipt.ok, evidenceId: receipt.evidenceId }; await save("state.json", state);
        if (call.function.name === "askUser") {
          if (!receipt.ok || !value.options.some(item => /Priya/i.test(item))) { terminalReason = "unanticipated_operator_choice"; break; }
          prompt = protocol.scriptedPreference; step.scriptedPreferenceUsed = true; await save("state.json", state);
        }
      }
      if (terminalReason === "unanticipated_operator_choice") break;
    }
    const conversation = await readIntelligenceConversation(authority, state.conversationId), workspace = await intelligenceWorkspace(authority);
    const current = (await database.query("SELECT snapshot FROM on_shows WHERE tenant_id=$1", [state.fixture.tenantId])).rows[0].snapshot;
    const checks = conversation.receipts.filter(item => item.result.name === "checkAssignment" && item.result.ok).map(item => item.result.data);
    const result = {
      protocolHash: state.protocolHash, sourceRevision: state.revision, terminalReason,
      disclosure: protocol.disclosure, observedAt: new Date().toISOString(), responses: conversation.runs.length, toolReceipts: conversation.receipts.length,
      criteria: {
        tomRejected: checks.some(item => item.proposedResources.includes("tom") && !item.allowedByQualification && item.issues.some(issue => issue.code === "QUALIFICATION")),
        preferenceRequested: conversation.receipts.some(item => item.result.name === "askUser" && item.result.ok) && state.steps.some(item => item.scriptedPreferenceUsed),
        priyaQualified: checks.some(item => item.proposedResources.includes("priya") && item.allowedByQualification),
        realEngineProposal: workspace.proposals.some(item => ["feasible", "feasible_with_approval"].includes(item.candidate.report.status) && item.candidate.report.engine?.status === "passed" && item.state === "proposed"),
        checklistProven: conversation.plan?.steps.length === 4 && conversation.plan.steps.every(item => item.completed),
        originalFixtureUnchanged: digest(current) === state.fixture.initialDigest,
        noFinancialOrCrewAction: current.financialEvidence.length === 0 && current.acknowledgments.length === 0 && current.approvedPlan === null,
      },
    };
    result.passed = terminalReason === "assistant_finished" && Object.values(result.criteria).every(Boolean);
    await save("conversation-private.json", conversation); await save("report.json", result);
    state.complete = true; state.completedAt = result.observedAt; await save("state.json", state);
    console.log(JSON.stringify({ event: "qualification_finished", ...result }));
    if (!result.passed) process.exitCode = 2;
  } catch (error) {
    await save("runner-failure.json", { observedAt: new Date().toISOString(), name: error.name, code: error.code ?? null, message: error.message });
    console.error(JSON.stringify({ event: "qualification_interrupted", name: error.name, code: error.code ?? null, privateFailureSaved: true })); process.exitCode = 1;
  } finally { await database?.end(); await lock.close(); await unlink(path.join(destination, "runner.lock")); }
} else throw new Error("Use --prepare --credentials /private/.env, or run frozen copy with --run --workspace /private/output");
