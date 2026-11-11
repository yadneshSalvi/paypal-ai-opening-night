import { createHash } from "node:crypto";
import { DomainError } from "@/domain/contracts";
import { canonical, digest } from "@/domain/hash";
import { reportRequestSchema, type WrapReport } from "@/domain/wrap/contracts";
import { openIntelligence, sealIntelligence } from "../intelligence/private-payload";
import type { SettlementAuthority } from "../settlement/service";
import { renderWrapPdf } from "./pdf";
import { reportEditions, wrapData, wrapReceipt } from "./service";
import { appendWrapRecord, assertWrapAuthority, readWrapState, wrapContext, wrapRequestHash, wrapShow, wrapTransaction } from "./store";

export const byteHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export async function sealWrapReport(authority: SettlementAuthority, raw: unknown) {
  const request = reportRequestSchema.parse(raw), retainedRequest = { action: "seal_report", request }, hash = wrapRequestHash(authority, retainedRequest);
  const prepared = await wrapTransaction(async db => {
    const show = await wrapShow(db, authority.actor.tenantId); await assertWrapAuthority(db, authority, show); const state = await readWrapState(db, show), previous = (await db.query<{ payload_hash: string }>("SELECT payload_hash FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [show.tenantId, request.idempotencyKey])).rows[0];
    if (previous) { if (previous.payload_hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This edition identity belongs to different source instructions or access."); return { replayed: true as const }; }
    const data = await wrapData(db, show, state, authority);
    if (show.revision !== request.expectedShowRevision || state.revision !== request.expectedRevision || data.report.contentDigest !== request.reportDigest) throw new DomainError("WRAP_REPORT_STALE", "The complete account changed. Review the current source definition before sealing it.");
    if (data.editions.length >= 1000) throw new DomainError("WRAP_REPORT_LIMIT", "This production already has 1,000 retained report editions. All original bytes remain available.", 409);
    const { contentDigest: _oldDigest, ...content } = data.report, definition = { ...content, id: request.idempotencyKey, edition: data.editions.length + 1, title: request.title }, report: WrapReport = { ...definition, contentDigest: digest(definition) };
    return { replayed: false as const, report };
  });
  let rendered: Awaited<ReturnType<typeof renderWrapPdf>> | null = null, json: Buffer | null = null;
  if (!prepared.replayed) { rendered = await renderWrapPdf(prepared.report); json = Buffer.from(canonical(prepared.report) + "\n", "utf8"); if (rendered.bytes.byteLength > 64_000_000 || json.byteLength > 32_000_000) throw new DomainError("WRAP_EXPORT_LIMIT", "The complete edition exceeds the supported export size. No partial or truncated export was retained.", 413); }
  return wrapTransaction(async db => {
    const show = await wrapShow(db, authority.actor.tenantId, true); await assertWrapAuthority(db, authority, show); const state = await readWrapState(db, show), previous = (await db.query<{ payload_hash: string }>("SELECT payload_hash FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [show.tenantId, request.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.payload_hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "The original edition identity differs from this request.");
      const record = state.records.find(record => record.commandId === request.idempotencyKey && record.kind === "report_sealed"), edition = (await reportEditions(db, show.tenantId)).find(item => item.id === request.idempotencyKey);
      if (!record || !edition) throw new DomainError("WRAP_REPORT_UNAVAILABLE", "The original sealed edition cannot be verified. It has not been regenerated.", 503);
      return { data: await wrapData(db, show, state, authority), receipt: wrapReceipt(record), edition, replayed: true };
    }
    const data = await wrapData(db, show, state, authority);
    if (prepared.replayed || !rendered || !json || show.revision !== request.expectedShowRevision || state.revision !== request.expectedRevision || data.report.contentDigest !== request.reportDigest) throw new DomainError("WRAP_REPORT_STALE", "The source account changed while the complete export was rendered. Review the current account before sealing.");
    const report = prepared.report, pdfHash = byteHash(rendered.bytes), jsonHash = byteHash(json), now = new Date().toISOString();
    const next = await appendWrapRecord(db, show, state, { kind: "report_sealed", reportId: report.id, reportDigest: report.contentDigest, edition: report.edition!, pdfHash, jsonHash, pages: rendered.pages }, { request: retainedRequest, authority, commandId: request.idempotencyKey });
    await db.query("INSERT INTO on_wrap_reports(id,tenant_id,edition,command_id,request_hash,report_cipher,report_digest,pdf_cipher,pdf_hash,json_cipher,json_hash,pages,title,as_of,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)", [report.id, show.tenantId, report.edition, request.idempotencyKey, hash, sealIntelligence(show.tenantId, wrapContext(report.id, "definition"), report), report.contentDigest, sealIntelligence(show.tenantId, wrapContext(report.id, "pdf"), Buffer.from(rendered.bytes).toString("base64")), pdfHash, sealIntelligence(show.tenantId, wrapContext(report.id, "json"), json.toString("base64")), jsonHash, rendered.pages, report.title, report.asOf, authority.actor.id, now]);
    return { data: await wrapData(db, next.show, next.state, authority), receipt: wrapReceipt(next.record), edition: (await reportEditions(db, show.tenantId)).find(item => item.id === report.id)!, replayed: false };
  });
}
export async function readSealedReport(authority: SettlementAuthority, id: string, format: "pdf" | "json" | "definition") {
  return wrapTransaction(async db => {
    const show = await wrapShow(db, authority.actor.tenantId); await assertWrapAuthority(db, authority, show); await readWrapState(db, show);
    const row = (await db.query<{ report_cipher: string; report_digest: string; pdf_cipher: string; pdf_hash: string; json_cipher: string; json_hash: string; pages: number; edition: number; title: string }>("SELECT report_cipher,report_digest,pdf_cipher,pdf_hash,json_cipher,json_hash,pages,edition,title FROM on_wrap_reports WHERE tenant_id=$1 AND id=$2", [show.tenantId, id])).rows[0];
    if (!row) throw new DomainError("WRAP_REPORT_NOT_FOUND", "This sealed edition is not part of the current production.", 404);
    const report = openIntelligence<WrapReport>(show.tenantId, wrapContext(id, "definition"), row.report_cipher), { contentDigest, ...definition } = report;
    if (report.id !== id || report.tenantId !== show.tenantId || contentDigest !== row.report_digest || digest(definition) !== contentDigest) throw new DomainError("WRAP_REPORT_INTEGRITY", "The original sealed definition could not be verified. It has not been replaced.", 503);
    if (format === "definition") return { format, report, bytes: null, hash: contentDigest, pages: row.pages, edition: row.edition };
    const bytes = Buffer.from(openIntelligence<string>(show.tenantId, wrapContext(id, format), format === "pdf" ? row.pdf_cipher : row.json_cipher), "base64"), expected = format === "pdf" ? row.pdf_hash : row.json_hash;
    if (byteHash(bytes) !== expected || format === "json" && canonical(JSON.parse(bytes.toString("utf8"))) !== canonical(report) || format === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new DomainError("WRAP_REPORT_BYTES_CHANGED", "The original export bytes could not be verified. No new file was substituted.", 503);
    return { format, report, bytes, hash: expected, pages: row.pages, edition: row.edition };
  });
}
