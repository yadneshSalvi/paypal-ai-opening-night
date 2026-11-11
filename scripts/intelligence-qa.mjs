import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile, symlink, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "dotenv";
import { Pool } from "pg";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const qaDir = path.join(root, ".artifacts", "intelligence-qa-4513"), metadataPath = path.join(qaDir, "qa-private.json");
const command = process.argv[2];
if (!["--init", "--refresh", "--build", "--start"].includes(command)) throw new Error("Use --init, --refresh, --build, or --start");
await mkdir(qaDir, { recursive: true, mode: 0o700 });
if (command === "--init") { try { await access(metadataPath); throw new Error("A QA workspace already exists; it cannot be reset. Use --refresh to copy updated source."); } catch (error) { if (error.code !== "ENOENT") throw error; } }
if (["--init", "--refresh"].includes(command)) {
  for (const item of ["src", "public", "scripts", "tests", "vendor", "package.json", "package-lock.json", "tsconfig.json", "next-env.d.ts", "next.config.ts"]) {
    await cp(path.join(root, item), path.join(qaDir, item), { recursive: true, force: true });
  }
  try { await symlink(path.join(root, "node_modules"), path.join(qaDir, "node_modules"), "dir"); } catch (error) { if (error.code !== "EEXIST") throw error; }
}
if (command === "--init") {
  const original = parse(await readFile(path.join(root, ".env"))), url = new URL(original.DATABASE_URL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("QA initialization requires local PostgreSQL");
  const schema = "on_qa_ai_" + randomUUID().replaceAll("-", ""), admin = new Pool({ connectionString: url.href, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`); await admin.end();
  url.searchParams.set("options", "-c search_path=" + schema);
  const environment = { DATABASE_URL: url.href, JUDGE_SESSION_SECRET: randomBytes(32).toString("base64url"), BRYNTUM_LICENSE_KEY: original.BRYNTUM_LICENSE_KEY ?? "", OPENING_NIGHT_AI_QA: "1", OPENING_NIGHT_QA_FIXTURE: "1", OPENAI_API_KEY: "", GEMINI_API_KEY: "", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID: "", OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET: "" };
  await writeFile(path.join(qaDir, ".env"), Object.entries(environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
  process.chdir(qaDir);
  for (const key of Object.keys(process.env)) if (/OPENAI|GEMINI|PAYPAL|CHANNEL3|ANTHROPIC/.test(key)) process.env[key] = "";
  Object.assign(process.env, environment);
  const db = new Pool({ connectionString: url.href, max: 6 }); globalThis.openingNightPool = db;
  const { migrate, createSession } = await import(path.join(root, "src/server/store.ts"));
  const { applyCommand, recordRescueRun } = await import(path.join(root, "src/domain/commands.ts"));
  const { generateCandidates } = await import(path.join(root, "src/server/engine.ts"));
  await migrate(); const session = await createSession(undefined, "intelligence-qa-" + schema);
  const show = session.show; delete show.commercialProtocol; show.title = "Controlled planning rehearsal";
  const disrupted = applyCommand(show, session.actor, { type: "load_incidents" });
  const candidates = await generateCandidates(disrupted), prepared = recordRescueRun(disrupted, session.actor, candidates);
  await db.query("UPDATE on_shows SET snapshot=$2,revision=$3 WHERE tenant_id=$1", [show.tenantId, prepared, prepared.revision]);
  await writeFile(metadataPath, JSON.stringify({ schema, tenantId: show.tenantId, cookieName: "opening-night-ai-qa-session", cookieValue: session.token, port: 4513, mode: "controlled_fixture", originalFinancialRowsTouched: 0, createdAt: new Date().toISOString(), fixtureHash: createHash("sha256").update(JSON.stringify(prepared)).digest("hex") }, null, 2), { mode: 0o600 });
  await db.end(); console.log(JSON.stringify({ prepared: true, schema, tenantId: show.tenantId, port: 4513, nativeEngineCandidates: candidates.length, actualProviderCalls: 0 }));
}
if (["--build", "--start"].includes(command)) {
  await access(metadataPath);
  const args = command === "--build" ? ["build"] : ["start", "--port", "4513"];
  const processEnv = { ...process.env };
  for (const key of Object.keys(processEnv)) if (/OPENAI|GEMINI|PAYPAL|CHANNEL3|ANTHROPIC/.test(key)) processEnv[key] = "";
  delete processEnv.VERCEL;
  processEnv.NODE_OPTIONS = `--import=${path.join(qaDir, "scripts/qa/intelligence-fixture-provider.mjs")}`;
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), ...args], { cwd: qaDir, env: processEnv, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", code => process.exit(code ?? 1));
}
