import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { digest } from "@/domain/hash";
import type { InputEnvelope, InputSource, InputSourceView } from "@/domain/production-inputs/contracts";
import { sourceLocationLabel } from "@/domain/sources";
import { bindingsCurrent, sourceBindings } from "../sources/store";
import { sealIntelligence } from "../intelligence/private-payload";
import { inputContext, inputFail, inputNow, inputObject } from "./store";

interface SourceRow { id: string; tenant_id: string; family_id: string; version: number; source_cipher: string; source_digest: string; content_hash: string; document_id: string | null }
export async function retainedInputSource(db: PoolClient, tenantId: string, id: string) {
  const row = (await db.query<SourceRow>("SELECT * FROM on_production_input_sources WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
  if (!row) inputFail("INPUT_SOURCE_NOT_FOUND", "This retained source is outside the current production.", 404);
  const source = inputObject<InputSource>(tenantId, id, "source", row.source_cipher, row.source_digest);
  if (source.id !== row.id || source.familyId !== row.family_id || source.version !== row.version || source.contentHash !== row.content_hash || digest(source.units) !== source.extractionDigest || (source.documentBinding?.id ?? null) !== row.document_id) inputFail("INPUT_SOURCE_INTEGRITY", "The original source identity cannot be verified.", 503);
  if (!source.documentBinding && (typeof source.originalText !== "string" || createHash("sha256").update(source.originalText, "utf8").digest("hex") !== source.contentHash)) inputFail("INPUT_SOURCE_INTEGRITY", "The original exact UTF-8 source bytes cannot be verified.", 503);
  return source;
}
export async function inputSourceCurrent(db: PoolClient, tenantId: string, source: InputSource) {
  const later = await db.query("SELECT 1 FROM on_production_input_sources WHERE tenant_id=$1 AND family_id=$2 AND version>$3", [tenantId, source.familyId, source.version]);
  if (later.rowCount) return false;
  return !source.documentBinding || bindingsCurrent(db, tenantId, [source.documentBinding], true);
}
export async function inputSources(db: PoolClient, tenantId: string): Promise<InputSourceView[]> {
  const ids = (await db.query<{ id: string }>("SELECT id FROM on_production_input_sources WHERE tenant_id=$1 ORDER BY created_at DESC,id", [tenantId])).rows;
  const values: InputSourceView[] = [];
  for (const { id } of ids) { const source = await retainedInputSource(db, tenantId, id), current = await inputSourceCurrent(db, tenantId, source); values.push({ ...source, current, blocker: current ? null : "A newer source version exists or its original document is no longer current. This exact version remains historical." }); }
  return values;
}
export async function retainInputSource(db: PoolClient, envelope: InputEnvelope) {
  const command = envelope.command, tenantId = envelope.scope.tenantId;
  if (!["retain_source", "admit_document"].includes(command.type)) inputFail("INPUT_SOURCE_COMMAND", "Choose a supported source instruction.", 400);
  const count = (await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM on_production_input_sources WHERE tenant_id=$1", [tenantId])).rows[0]!.count;
  if (count >= 200) inputFail("INPUT_SOURCE_LIMIT", "This production has reached its 200 retained input-source bound. All original versions remain readable.", 422);
  const id = randomUUID(), createdAt = await inputNow(db);
  let source: InputSource;
  if (command.type === "retain_source") {
    const previous = command.replacesId ? await retainedInputSource(db, tenantId, command.replacesId) : null;
    if (previous && (!await inputSourceCurrent(db, tenantId, previous) || previous.documentBinding)) inputFail("INPUT_SOURCE_VERSION_CHANGED", "Replace the current declared source version; source documents are versioned in the existing source desk.");
    const units = command.text.split(/\r?\n/).flatMap((line, index) => line.trim() ? [{ id: `line-${index + 1}`, text: line, location: `Line ${index + 1}` }] : []);
    if (units.some(unit => unit.text.length > 12000) || units.length > 1500) inputFail("INPUT_SOURCE_LINES", "Use at most 1,500 lines and 12,000 characters per line.", 422);
    source = { id, familyId: previous?.familyId ?? randomUUID(), version: (previous?.version ?? 0) + 1, title: command.title, provenance: command.provenance, authorityNote: command.authorityNote, rights: command.rights, contentHash: createHash("sha256").update(command.text, "utf8").digest("hex"), extractionDigest: digest(units), units, originalText: command.text, createdAt, documentBinding: null, originalDocument: null };
  } else if (command.type === "admit_document") {
    const { documents, bindings } = await sourceBindings(db, tenantId, [command.documentId]), document = documents[0]!, binding = bindings[0]!;
    if (binding.hash !== command.contentHash || !document.rights || document.state !== "ready" || !document.extraction) inputFail("INPUT_DOCUMENT_CHANGED", "Review the current complete parsed source and its exact hash before retaining it.");
    if ((await db.query("SELECT 1 FROM on_production_input_sources WHERE tenant_id=$1 AND document_id=$2", [tenantId, document.id])).rowCount) inputFail("INPUT_DOCUMENT_RETAINED", "This exact document version is already retained. Use its original source identity.");
    const previous = (await db.query<{ version: number }>("SELECT version FROM on_production_input_sources WHERE tenant_id=$1 AND family_id=$2 ORDER BY version DESC LIMIT 1", [tenantId, document.familyId])).rows[0];
    const units = document.extraction.units.map(unit => ({ id: unit.id, text: unit.text, location: sourceLocationLabel(unit.locator) }));
    source = { id, familyId: document.familyId, version: (previous?.version ?? 0) + 1, title: command.title, provenance: command.provenance, authorityNote: command.authorityNote, rights: document.rights, contentHash: document.contentHash, extractionDigest: digest(units), units, originalText: null, createdAt, documentBinding: binding, originalDocument: document };
  } else return inputFail("INPUT_SOURCE_COMMAND", "Choose a source instruction.", 400);
  await db.query("INSERT INTO on_production_input_sources(id,tenant_id,family_id,version,source_cipher,source_digest,content_hash,document_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, tenantId, source.familyId, source.version, sealIntelligence(tenantId, inputContext(id, "source"), source), digest(source), source.contentHash, source.documentBinding?.id ?? null, createdAt]);
  return source;
}
