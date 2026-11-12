/** Actual additive migration, immutable history and GET-only fresh-process recovery. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { digest } from "../src/domain/hash";
import { audienceHarness } from "./audience-harness";
const h = await audienceHarness(); after(h.close);
const originals = ["on_audience_capabilities", "on_audience_revocations", "on_audience_drafts", "on_audience_approvals", "on_audience_stops", "on_audience_commands", "on_audience_delivery_passes", "on_audience_deliveries"];

async function existingRows() {
  const tables = (await h.database.pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name NOT LIKE 'on_audience_%' ORDER BY table_name")).rows;
  const result: Record<string, { rows: number; digest: string }> = {};
  for (const { table_name } of tables) {
    assert.match(table_name, /^[a-z0-9_]+$/);
    const rows = (await h.database.pool.query(`SELECT to_jsonb(t) AS row FROM "${table_name}" t ${table_name === "on_schema_migrations" ? "WHERE version<=16" : ""} ORDER BY to_jsonb(t)::text`)).rows.map(item => item.row);
    result[table_name] = { rows: rows.length, digest: digest(rows) };
  }
  return result;
}

test("additive migration17 preserves every preexisting version16 table row, authority, capture and original expiry", async () => {
  const value = await h.fresh(); await h.capture(value);
  // Construct the prior schema boundary only in this new owned test schema. No
  // audience record exists yet, and no original row or capability is renewed.
  for (const table of ["on_audience_workspaces", ...originals, "on_audience_delivery_progress"]) assert.equal((await h.database.pool.query(`SELECT 1 FROM ${table}`)).rowCount, 0);
  await h.database.pool.query("DROP TABLE on_audience_delivery_progress,on_audience_deliveries,on_audience_delivery_passes,on_audience_stops,on_audience_approvals,on_audience_drafts,on_audience_revocations,on_audience_capabilities,on_audience_commands,on_audience_workspaces CASCADE");
  await h.database.pool.query("DROP FUNCTION on_audience_history_immutable()"); await h.database.pool.query("DELETE FROM on_schema_migrations WHERE version=17");
  const before = await existingRows(), providerCalls = h.wire.calls.length;
  delete (globalThis as typeof globalThis & { openingNightMigration?: Promise<void> }).openingNightMigration;
  await h.store.migrate(); assert.deepEqual(await existingRows(), before); assert.equal(h.wire.calls.length, providerCalls);
  assert.equal((await h.database.pool.query("SELECT version FROM on_schema_migrations WHERE version=17")).rowCount, 1);
  const receipt = (await h.audience.readAudienceWorkspace(value.authority)).tickets[0]!; assert.equal(receipt.verification, "verified"); assert.equal(receipt.admissionMinor, 3500); assert.equal(receipt.perkMinor, 1500);
});

test("all original capability, content, approval, stop, command, pass and recipient receipts reject update and deletion", async () => {
  const value = await h.fresh(), one = await h.capture(value), two = await h.capture(value), a = await h.invite(value, one.ticket.id), b = await h.invite(value, two.ticket.id), draft = await h.draft(value, [a.capabilityId, b.capabilityId]);
  const approved = await h.approve(value, draft.draft.id); await h.deliver(value, draft.draft.id, 1); await h.reserve(value, draft.draft.id, 1);
  await h.audienceAct(value.authority, { type: "stop_message", approvalId: approved.view.approval!.id, approvalDigest: approved.view.approval!.digest, detail: "Controlled producer stops this remaining pass while retaining original per-recipient history.", confirmed: true });
  await h.audienceAct(value.authority, { type: "revoke_invite", capabilityId: b.capabilityId, confirmed: true });
  for (const table of originals) {
    assert.ok((await h.database.pool.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [value.actor.tenantId])).rowCount);
    await assert.rejects(h.database.pool.query(`UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`, [value.actor.tenantId]), { code: "23000" });
    await assert.rejects(h.database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [value.actor.tenantId]), { code: "23000" });
  }
  assert.equal((await h.audience.readAudienceMessage(value.authority, draft.draft.id)).deliveries.length, 1);
});

test("a fresh process recovers exact encrypted original invitation, draft and inbox with GETs and zero row changes", async () => {
  const value = await h.fresh(), original = await h.capture(value), link = await h.invite(value, original.ticket.id), draft = await h.draft(value, [link.capabilityId]); await h.approve(value, draft.draft.id); const delivered = await h.deliver(value, draft.draft.id);
  const directory = await mkdtemp(".artifacts/audience-stage17/process-"), input = directory + "/input.json";
  await writeFile(input, JSON.stringify({ schema: h.database.schema, producerToken: value.token, attendeeToken: link.token, tenantId: value.actor.tenantId, commandId: link.result.receipt.commandId, draftId: draft.draft.id }), { mode: 0o600, flag: "wx" });
  const before = await existingRows(), audienceBefore = await h.database.pool.query("SELECT (SELECT count(*) FROM on_audience_capabilities) AS caps,(SELECT count(*) FROM on_audience_commands) AS commands,(SELECT count(*) FROM on_audience_deliveries) AS deliveries"), providerCalls = h.wire.calls.length;
  const child = spawn(process.execPath, ["--import", "./scripts/qa/audience-controlled-wire-runtime.mjs", "--import", "tsx", "scripts/qa/audience-recovery-process.ts", input], { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  await writeFile(directory + "/result.json", JSON.stringify({ exitCode: code, stdout, stderr }), { mode: 0o600, flag: "wx" });
  assert.equal(code, 0, "The retained private child-process result contains failure evidence");
  const proof = JSON.parse(stdout.trim()); assert.equal(proof.requests, 4); assert.equal(proof.mutations, 0); assert.equal(proof.replayed, true); assert.equal(proof.commandDigest, digest(link.result.receipt)); assert.equal(proof.invitationDigest, digest(link.result.invitation)); assert.equal(proof.draftDigest, digest(draft.draft)); assert.deepEqual(proof.deliveryDigests, delivered.view.deliveries.map(item => item.digest)); assert.deepEqual(proof.inboxDigests, proof.deliveryDigests);
  assert.equal(proof.originalExpiryDigest, digest(link.result.invitation!.expiresAt)); assert.deepEqual(await existingRows(), before); assert.deepEqual((await h.database.pool.query("SELECT (SELECT count(*) FROM on_audience_capabilities) AS caps,(SELECT count(*) FROM on_audience_commands) AS commands,(SELECT count(*) FROM on_audience_deliveries) AS deliveries")).rows, audienceBefore.rows); assert.equal(h.wire.calls.length, providerCalls);
});
