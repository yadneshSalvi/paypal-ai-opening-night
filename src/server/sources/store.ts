import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { digest } from "@/domain/hash";
import { sourceParserVersion, sourceUploadSchema, type SourceBinding, type SourceDocument, type SourceExtraction, type SourceState, type SourceUpload } from "@/domain/sources";
import { pool } from "../store";
import { planningFail, requirePlanningAuthority, withPlanningTransaction, type IntelligenceAuthority } from "../intelligence/ledger";
import { byteHash } from "../intelligence/voice";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import { parseSource, sourceFormat } from "./parser";

export interface SourceRow {
  id: string; tenant_id: string; actor_id: string; request_id: string; request_hash: string; family_id: string; version: number; current: boolean;
  kind: SourceDocument["kind"]; format: string; media_type: string; byte_length: number; content_hash: string; metadata_cipher: string | null;
  extraction_cipher: string | null; extraction_digest: string | null; state: SourceState; created_at: Date; deleted_at: Date | null; failure_code: string | null;
}
type SourceMetadata = Pick<SourceUpload, "title" | "role" | "rights"> & { filename: string };
export const sourceContext = (id: string, part: string) => `source:${id}:${part}`;
export function sourceView(row: SourceRow, includeExtraction = false): SourceDocument {
  const metadata = row.metadata_cipher ? openIntelligence<SourceMetadata>(row.tenant_id, sourceContext(row.id, "metadata"), row.metadata_cipher) : null;
  const extraction = includeExtraction && row.extraction_cipher ? openIntelligence<SourceExtraction>(row.tenant_id, sourceContext(row.id, "extraction"), row.extraction_cipher) : null;
  if (extraction && digest(extraction) !== row.extraction_digest) planningFail("SOURCE_EXTRACTION_INTEGRITY", "The saved extraction cannot be verified.", 503);
  return { id: row.id, familyId: row.family_id, version: row.version, title: metadata?.title ?? "Deleted source", filename: metadata?.filename ?? "", role: metadata?.role ?? "other", rights: metadata?.rights ?? null, kind: row.kind, mediaType: row.media_type, byteLength: row.byte_length, contentHash: row.content_hash, extractionDigest: row.extraction_digest, state: row.state, current: row.current, createdAt: row.created_at.toISOString(), deletedAt: row.deleted_at?.toISOString() ?? null, extraction, failureCode: row.failure_code };
}
export async function sourceRow(db: PoolClient, tenantId: string, id: string, lock = false) {
  const row = (await db.query<SourceRow>(`SELECT * FROM on_source_documents WHERE tenant_id=$1 AND id=$2${lock ? " FOR SHARE" : ""}`, [tenantId, id])).rows[0];
  if (!row) planningFail("SOURCE_NOT_FOUND", "This source is not in the current production.", 404);
  return row;
}
export async function readSource(authority: IntelligenceAuthority, id: string) {
  return withPlanningTransaction(async db => { await requirePlanningAuthority(db, authority); return sourceView(await sourceRow(db, authority.actor.tenantId, id), true); });
}
export async function findSourceRequest(authority: IntelligenceAuthority, requestId: string) {
  return withPlanningTransaction(async db => { await requirePlanningAuthority(db, authority); const row = (await db.query<SourceRow>("SELECT * FROM on_source_documents WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3", [authority.actor.tenantId, authority.actor.id, requestId])).rows[0]; if (!row) planningFail("SOURCE_NOT_FOUND", "This upload identity has not been saved in the current production.", 404); return sourceView(row, true); });
}
export async function listSources(authority: IntelligenceAuthority) {
  return withPlanningTransaction(async db => { await requirePlanningAuthority(db, authority); return (await db.query<SourceRow>("SELECT * FROM on_source_documents WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 150", [authority.actor.tenantId])).rows.map(row => sourceView(row)); });
}
async function sourceBytes(db: PoolClient, row: SourceRow) {
  const object = (await db.query<{ bytes_cipher: string }>("SELECT bytes_cipher FROM on_source_objects WHERE tenant_id=$1 AND source_id=$2", [row.tenant_id, row.id])).rows[0];
  if (!object || row.state === "deleted") planningFail("SOURCE_DELETED", "The private bytes of this source were deleted. Its identity remains in the audit record.", 410);
  const bytes = Buffer.from(openIntelligence<string>(row.tenant_id, sourceContext(row.id, "object"), object.bytes_cipher), "base64");
  if (bytes.length !== row.byte_length || byteHash(bytes) !== row.content_hash) planningFail("SOURCE_OBJECT_INTEGRITY", "The original source bytes cannot be verified.", 503);
  return bytes;
}
export async function readSourceFile(authority: IntelligenceAuthority, id: string) {
  return withPlanningTransaction(async db => { await requirePlanningAuthority(db, authority); const row = await sourceRow(db, authority.actor.tenantId, id); return { source: sourceView(row), bytes: await sourceBytes(db, row) }; });
}

/** Version and original encrypted object commit atomically before deterministic extraction starts. */
export async function uploadSource(authority: IntelligenceAuthority, raw: SourceUpload, filename: string, bytes: Buffer) {
  const command = sourceUploadSchema.parse(raw), type = sourceFormat(filename, bytes), hash = byteHash(bytes);
  const cleanFilename = filename.replaceAll("\\", "/").split("/").at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  if (!cleanFilename) planningFail("SOURCE_FILENAME", "Choose a named source file.", 400);
  const requestHash = digest({ command, filename: cleanFilename, hash, kind: type.kind });
  const saved = await withPlanningTransaction(async db => {
    await requirePlanningAuthority(db, authority);
    const tenant = authority.actor.tenantId;
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`source-upload:${tenant}`]);
    const existing = (await db.query<SourceRow>("SELECT * FROM on_source_documents WHERE tenant_id=$1 AND request_id=$2", [tenant, command.requestId])).rows[0];
    if (existing) { if (existing.request_hash !== requestHash || existing.actor_id !== authority.actor.id) planningFail("SOURCE_REQUEST_CHANGED", "This upload identity belongs to different file content or rights metadata."); return { row: existing, inserted: false }; }
    let familyId: string = randomUUID(), version = 1;
    if (command.replacesId) {
      const previous = await sourceRow(db, tenant, command.replacesId, true);
      if (!previous.current || previous.state === "deleted") planningFail("SOURCE_VERSION_CHANGED", "This source version has already changed. Open the current version before replacing it.");
      familyId = previous.family_id; version = previous.version + 1;
      await db.query("UPDATE on_source_documents SET current=false WHERE tenant_id=$1 AND id=$2", [tenant, previous.id]);
    }
    const id = randomUUID(), metadata: SourceMetadata = { title: command.title, role: command.role, rights: command.rights, filename: cleanFilename };
    const row = (await db.query<SourceRow>("INSERT INTO on_source_documents(id,tenant_id,actor_id,request_id,request_hash,family_id,version,kind,format,media_type,byte_length,content_hash,metadata_cipher,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'saved') RETURNING *", [id, tenant, authority.actor.id, command.requestId, requestHash, familyId, version, type.kind, type.format, type.mediaType, bytes.length, hash, sealIntelligence(tenant, sourceContext(id, "metadata"), metadata)])).rows[0]!;
    await db.query("INSERT INTO on_source_objects(tenant_id,source_id,bytes_cipher) VALUES($1,$2,$3)", [tenant, id, sealIntelligence(tenant, sourceContext(id, "object"), bytes.toString("base64"))]);
    return { row, inserted: true };
  });
  // Pure parsers can resume the same immutable object, unlike an unknown provider POST.
  if (saved.inserted || ["saved", "parsing"].includes(saved.row.state)) return extractSource(authority, saved.row.id);
  return readSource(authority, saved.row.id);
}
export async function extractSource(authority: IntelligenceAuthority, id: string) {
  const claimed = await withPlanningTransaction(async db => {
    await requirePlanningAuthority(db, authority); const row = await sourceRow(db, authority.actor.tenantId, id), lease = randomUUID();
    if (["ready", "needs_attention", "deleted"].includes(row.state)) return null;
    const result = await db.query("UPDATE on_source_documents SET state='parsing',parser_lease=$1,parser_lease_until=now()+interval '45 seconds',failure_code=NULL WHERE tenant_id=$2 AND id=$3 AND (state IN ('saved','failed') OR state='parsing' AND parser_lease_until<now()) RETURNING id", [lease, row.tenant_id, id]);
    if (!result.rowCount) return null;
    return { row, lease, bytes: await sourceBytes(db, row), filename: sourceView(row).filename };
  });
  if (claimed) {
    try {
      const extraction = await parseSource(claimed.filename, claimed.bytes);
      await pool.query("UPDATE on_source_documents SET state=$1,extraction_cipher=$2,extraction_digest=$3,parser_version=$4,parser_lease=NULL,parser_lease_until=NULL WHERE id=$5 AND tenant_id=$6 AND state='parsing' AND parser_lease=$7", [extraction.notices.some(item => item.blocking) ? "needs_attention" : "ready", sealIntelligence(claimed.row.tenant_id, sourceContext(id, "extraction"), extraction), digest(extraction), sourceParserVersion, id, claimed.row.tenant_id, claimed.lease]);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && /^[A-Z_]{1,100}$/.test(String(error.code)) ? String(error.code) : "SOURCE_PARSE_FAILED";
      await pool.query("UPDATE on_source_documents SET state='failed',failure_code=$1,parser_lease=NULL,parser_lease_until=NULL WHERE id=$2 AND tenant_id=$3 AND state='parsing' AND parser_lease=$4", [code, id, claimed.row.tenant_id, claimed.lease]);
    }
  }
  return readSource(authority, id);
}
export async function sourceBindings(db: PoolClient, tenantId: string, ids: string[]) {
  if (new Set(ids).size !== ids.length) planningFail("SOURCE_DUPLICATE", "Select each source version once.", 400);
  const documents: SourceDocument[] = [], bindings: SourceBinding[] = [];
  for (const id of [...ids].sort()) {
    const row = await sourceRow(db, tenantId, id, true), source = sourceView(row, true);
    if (!row.current || !["ready", "needs_attention"].includes(row.state) || !source.extraction || !row.extraction_digest) planningFail("SOURCE_NOT_CURRENT", "Every selected source must have a current, complete extraction. Open its source record first.");
    documents.push(source); bindings.push({ id, familyId: row.family_id, version: row.version, hash: row.content_hash, extractionDigest: row.extraction_digest });
  }
  return { documents, bindings };
}
export async function bindingsCurrent(db: PoolClient, tenantId: string, bindings: SourceBinding[], lock = false) {
  for (const binding of [...bindings].sort((a, b) => a.id.localeCompare(b.id))) {
    const row = (await db.query<SourceRow>(`SELECT * FROM on_source_documents WHERE tenant_id=$1 AND id=$2${lock ? " FOR SHARE" : ""}`, [tenantId, binding.id])).rows[0];
    if (!row?.current || row.state === "deleted" || row.content_hash !== binding.hash || row.extraction_digest !== binding.extractionDigest || row.version !== binding.version || row.family_id !== binding.familyId) return false;
  }
  return true;
}
export async function deleteSource(authority: IntelligenceAuthority, id: string, expectedHash: string) {
  return withPlanningTransaction(async db => {
    await requirePlanningAuthority(db, authority);
    if (!authority.actor.roles.includes("producer")) planningFail("SOURCE_PRODUCER_REQUIRED", "The producer reviews source deletion.", 403);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`source-upload:${authority.actor.tenantId}`]);
    const row = await sourceRow(db, authority.actor.tenantId, id);
    if (row.content_hash !== expectedHash) planningFail("SOURCE_CHANGED", "This deletion review belongs to different source bytes.");
    if (row.state === "deleted") return sourceView(row);
    const retained = await db.query("SELECT record_id FROM on_tour_source_bindings WHERE tenant_id=$1 AND source_id=$2 LIMIT 1", [row.tenant_id, row.id]);
    if (retained.rowCount) planningFail("SOURCE_IN_LIBRARY", "This immutable source supports a retained production or template edition. Upload a replacement; its original evidence remains available.");
    const related = (await db.query<{ id: string; state: string; applied_at: Date | null }>("SELECT id,state,applied_at FROM on_source_compilations WHERE tenant_id=$1 AND source_bindings @> $2::jsonb FOR UPDATE", [row.tenant_id, JSON.stringify([{ id }])])).rows;
    if (related.some(run => run.applied_at)) planningFail("SOURCE_IN_APPROVED_GRAPH", "This source supports an applied production graph. Its evidence is retained with that reviewed graph; upload a replacement version to supersede it.");
    if (related.some(run => ["dispatching", "running", "validating"].includes(run.state))) planningFail("SOURCE_COMPILATION_ACTIVE", "An original compilation is still processing this source. Read its saved outcome before deleting the private input.");
    await db.query("DELETE FROM on_source_objects WHERE tenant_id=$1 AND source_id=$2", [row.tenant_id, id]);
    // Source deletion also purges private transport bodies, preserving their
    // immutable identity, response status and digest as evidence tombstones.
    await db.query("UPDATE on_source_compilation_observations SET payload_cipher=NULL,purged_at=now() WHERE tenant_id=$1 AND compilation_id=ANY($2::uuid[]) AND payload_cipher IS NOT NULL", [row.tenant_id, related.map(run => run.id)]);
    await db.query("UPDATE on_source_compilations SET state='deleted',request_cipher=NULL,provider_output_cipher=NULL,result_cipher=NULL,purged_at=now(),updated_at=now() WHERE tenant_id=$1 AND source_bindings @> $2::jsonb AND state<>'deleted'", [row.tenant_id, JSON.stringify([{ id }])]);
    const deleted = (await db.query<SourceRow>("UPDATE on_source_documents SET state='deleted',current=false,metadata_cipher=NULL,extraction_cipher=NULL,parser_lease=NULL,parser_lease_until=NULL,deleted_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [row.tenant_id, id])).rows[0]!;
    return sourceView(deleted);
  });
}
