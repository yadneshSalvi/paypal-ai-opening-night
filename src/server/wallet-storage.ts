import type { PaymentTokenRequest, SetupTokenRequest } from "paypal";
import { DomainError } from "@/domain/contracts";
import type { DatabaseReader } from "./commerce-storage";
import { pool } from "./store";

export interface WalletSetup {
  id: string; tenantId: string; actorId: string; origin: string; merchantCustomerId: string;
  saveConsentDigest: string; createdAt: string; expiresAt: string; cancelledAt: string | null;
  setupTokenId: string | null; customerId: string | null; savedWalletId: string | null; checkedAt: string | null;
}
export interface WalletResult {
  id: string; status: string | null; customerId: string | null; merchantCustomerId: string | null;
  paypal: boolean; usageType: string | null; usagePattern: string | null; payerHash: string | null;
  approvalUrl: string | null;
}
export interface WalletOperation {
  id: string; tenantId: string; setupId: string; providerRequestId: string;
  request: { phase: "setup"; body: SetupTokenRequest } | { phase: "exchange"; body: PaymentTokenRequest };
  payloadHash: string; status: "prepared" | "dispatching" | "succeeded" | "refused" | "not_sent" | "pending_reconciliation";
  result: WalletResult | null; attempts: number; startedAt: string | null; observedAt: string | null;
  lastCode: string | null; httpStatus: number | null; debugId: string | null; responseHash: string | null;
  transport: "apimatic_sdk";
}
export interface SavedWallet {
  id: string; tenantId: string; setupId: string; actorId: string; seller: "venue";
  tokenId: string; customerId: string | null; merchantCustomerId: string; payerHash: string | null;
  savedAt: string; checkedAt: string; active: boolean;
}
export async function readWalletSetup(tenantId: string, id: string, client: DatabaseReader = pool, lock = false) {
  const result = await client.query<{ document: WalletSetup }>("SELECT document FROM on_wallet_setups WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR UPDATE" : ""), [tenantId, id]);
  if (!result.rows[0]) throw new DomainError("WALLET_SETUP_NOT_FOUND", "This wallet request does not belong to the current production.", 404);
  return result.rows[0].document;
}
export async function readWalletOperation(tenantId: string, setupId: string, phase: "setup" | "exchange", client: DatabaseReader = pool): Promise<WalletOperation | null> {
  const result = await client.query<{ document: WalletOperation }>("SELECT document FROM on_wallet_operations WHERE tenant_id=$1 AND setup_id=$2 AND phase=$3", [tenantId, setupId, phase]);
  return result.rows[0]?.document ?? null;
}
export async function saveWalletSetup(client: DatabaseReader, setup: WalletSetup) { await client.query("UPDATE on_wallet_setups SET document=$3,provider_setup_id=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2", [setup.tenantId, setup.id, setup, setup.setupTokenId]); }
export async function saveWalletOperation(client: DatabaseReader, operation: WalletOperation) { await client.query("UPDATE on_wallet_operations SET document=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [operation.tenantId, operation.id, operation]); }
export async function readSavedWallet(tenantId: string, id: string, client: DatabaseReader = pool) {
  const result = await client.query<{ document: SavedWallet }>("SELECT document FROM on_saved_wallets WHERE tenant_id=$1 AND id=$2 AND seller='venue'", [tenantId, id]);
  if (!result.rows[0]) throw new DomainError("SAVED_WALLET_NOT_FOUND", "This saved wallet does not belong to this venue production.", 403);
  return result.rows[0].document;
}
