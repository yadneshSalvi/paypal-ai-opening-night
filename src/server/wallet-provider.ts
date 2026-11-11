import type { PaypalError, PaymentTokenRequest, PaymentTokenResponse, SetupTokenRequest, SetupTokenResponse } from "paypal";
import { providers } from "./paypal-providers";

type Outcome<T> = { ok: true; value: T; status: number; headers: Headers } | { ok: false; status: number; headers: Headers; payload: unknown };
export class WalletProviderError extends Error {
  constructor(public readonly code: string, public readonly outcome: "unknown" | "refused" | "not_sent", public readonly status: number) { super(code); this.name = "WalletProviderError"; }
}
function responseFailure(status: number): WalletProviderError {
  const code = status === 401 || status === 403 ? "WALLET_CAPABILITY_REQUIRED" : status === 404 ? "WALLET_RESOURCE_NOT_FOUND" : status === 429 ? "WALLET_RATE_LIMIT" : status >= 400 && status < 500 ? "WALLET_REQUEST_REFUSED" : "WALLET_RESPONSE_UNCERTAIN";
  return new WalletProviderError(code, status >= 400 && status < 500 ? "refused" : "unknown", status);
}
function translate(error: unknown): never {
  if (error instanceof WalletProviderError) throw error;
  if (!error || typeof error !== "object" || !("kind" in error) || !("uri" in error)) throw error;
  const typed = error as PaypalError;
  switch (typed.kind) {
    case "api": throw responseFailure(typed.status);
    case "auth": throw new WalletProviderError("WALLET_AUTH_FAILED", "not_sent", 502);
    case "encode": throw new WalletProviderError("WALLET_REQUEST_INVALID", "not_sent", 400);
    case "decode": if (typed.status >= 400) throw responseFailure(typed.status); throw new WalletProviderError("WALLET_RESPONSE_INCOMPLETE", "unknown", 502);
    case "connection": case "timeout": throw new WalletProviderError("WALLET_RESPONSE_LOST", typed.uri.endsWith("/v1/oauth2/token") ? "not_sent" : "unknown", 502);
    default: throw error;
  }
}
async function invoke<T>(work: (signal: AbortSignal) => Promise<Outcome<T>>, signal: AbortSignal) {
  try {
    const result = await work(AbortSignal.any([signal, AbortSignal.timeout(25000)]));
    if (!result.ok) throw responseFailure(result.status);
    const debug = result.headers.get("paypal-debug-id");
    return { value: result.value, status: result.status, debugId: debug && /^[a-zA-Z0-9_-]{1,128}$/.test(debug) ? debug : null };
  } catch (error) { translate(error); }
}
/** Exactly the four resolved Vault calls, on the venue's existing generated SDK client. */
export const walletProvider = {
  createSetup: (body: SetupTokenRequest, requestId: string, signal: AbortSignal) => invoke<SetupTokenResponse>(s => providers.venue.client.vault.createSetupToken({ payPalRequestId: requestId, body }, { signal: s }).asApiResult(), signal),
  readSetup: (id: string, signal: AbortSignal) => invoke<SetupTokenResponse>(s => providers.venue.client.vault.getSetupToken({ id }, { signal: s }).asApiResult(), signal),
  exchange: (body: PaymentTokenRequest, requestId: string, signal: AbortSignal) => invoke<PaymentTokenResponse>(s => providers.venue.client.vault.createPaymentToken({ payPalRequestId: requestId, body }, { signal: s }).asApiResult(), signal),
  readToken: (id: string, signal: AbortSignal) => invoke<PaymentTokenResponse>(s => providers.venue.client.vault.getPaymentToken({ id }, { signal: s }).asApiResult(), signal),
};
