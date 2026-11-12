import { randomUUID } from "node:crypto";
import type { ProviderResource } from "@fracture/paypal-core";
import { DomainError, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { PaymentIntent } from "@/domain/payment-authority";
import type { RentalCloseoutCheck } from "@/domain/rental-closeout";
import { paymentTransaction } from "../payment-store";
import { sealIntelligence } from "../intelligence/private-payload";
import { pool } from "../store";
import { saveSupplierSnapshot } from "../supplier-storage";
import { readCloseoutGrant } from "./store";

export async function beginCloseoutRead() {
  const row = (await pool.query<{ sequence: string; started_at: Date }>("SELECT nextval('on_rental_closeout_read_sequence') AS sequence,clock_timestamp() AS started_at")).rows[0]!;
  const sequence = Number(row.sequence); if (!Number.isSafeInteger(sequence)) throw new DomainError("RENTAL_CLOSEOUT_READ_SEQUENCE", "The original read sequence cannot be verified.", 503);
  return { id: randomUUID(), sequence, startedAt: row.started_at.toISOString() };
}
/** Later-started reads win; uncertain or adverse reads withdraw current proof, never historical receipts. */
export async function recordCloseoutRead(intent: PaymentIntent, started: Awaited<ReturnType<typeof beginCloseoutRead>>, result: { verified: boolean; code: string | null; order: ProviderResource[] | null; authorization: ProviderResource[] | null; capture: ProviderResource[] | null }) {
  await paymentTransaction(async db => {
    const { grant, progress } = await readCloseoutGrant(intent.tenantId, intent.rentalCloseoutId!, db);
    if (progress.intentId !== intent.id || grant.rootIntentId !== intent.parentId) throw new DomainError("RENTAL_CLOSEOUT_READ_SCOPE", "This read does not belong to the original retained closure.", 403);
    const show = (await db.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [intent.tenantId])).rows[0]?.snapshot;
    if (!show) throw new DomainError("SHOW_NOT_FOUND", "This production is unavailable.", 404);
    const document = { ...started, tenantId: intent.tenantId, grantId: grant.id, intentId: intent.id, finishedAt: new Date().toISOString(), verified: result.verified, code: result.code, residualMinor: grant.residualMinor, authorizationId: grant.authorizationId, captureId: grant.captureId, rootIntentId: grant.rootIntentId, source: "original_sdk_read", resources: { order: result.order, authorization: result.authorization, capture: result.capture } };
    const hash = digest(document);
    await db.query("INSERT INTO on_rental_closeout_reads(tenant_id,id,grant_id,intent_id,sequence,started_at,digest,document_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [intent.tenantId, started.id, grant.id, intent.id, started.sequence, started.startedAt, hash, sealIntelligence(intent.tenantId, `rental-closeout-read:${started.id}`, document)]);
    const check: RentalCloseoutCheck = { id: started.id, grantId: grant.id, intentId: intent.id, sequence: started.sequence, startedAt: started.startedAt, finishedAt: document.finishedAt, verified: result.verified, code: result.code, residualMinor: grant.residualMinor, digest: hash };
    const previous = show.rentalCloseoutChecks?.find(value => value.grantId === grant.id);
    if (previous && previous.sequence >= check.sequence) return;
    show.rentalCloseoutChecks = [...(show.rentalCloseoutChecks ?? []).filter(value => value.grantId !== grant.id), check];
    await saveSupplierSnapshot(db, show, "worker:original-rental-read", result.verified ? "rental.closeout_verified" : "rental.closeout_unverified", result.verified ? "The original authorization, accepted fee and exact remaining release were corroborated. The receipt stays with its original rental." : "The original hold-closure read is incomplete or adverse. Historical receipts remain retained; current released amount needs reconciliation.");
  });
}
