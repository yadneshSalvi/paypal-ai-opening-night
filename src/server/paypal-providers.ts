import { SandboxPayPalProvider } from "@fracture/paypal-core";
import { DomainError } from "@/domain/contracts";
import type { PaymentSeller } from "@/domain/payment-authority";
import { merchantConfig } from "./payment-config";
import { env } from "./env";

const shared = globalThis as typeof globalThis & { openingNightProviders?: Partial<Record<PaymentSeller, SandboxPayPalProvider>> };
const cached = shared.openingNightProviders ??= {};

/** Importing a crew route must not construct either merchant client. On first
 * use, Vault, checkout and jobs retain the same validated, zero-retry client. */
export const providers = Object.defineProperties({}, Object.fromEntries(
  (["venue", "brightline"] as const).map(seller => [seller, {
    enumerable: true,
    get() {
      if (env.controlledQa) throw new DomainError("PROVIDER_QA_DISABLED", "Payment providers are disabled in this controlled crew rehearsal.", 403);
      return cached[seller] ??= new SandboxPayPalProvider(merchantConfig(seller));
    },
    // Existing controlled-fetch integration fixtures install the real provider
    // through this process-local seam; it is never an HTTP capability.
    set(provider: SandboxPayPalProvider) { cached[seller] = provider; },
  }]),
)) as Record<PaymentSeller, SandboxPayPalProvider>;
