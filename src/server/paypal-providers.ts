import { SandboxPayPalProvider } from "@fracture/paypal-core";
import type { PaymentSeller } from "@/domain/payment-authority";
import { merchantConfig } from "./payment-config";

const shared = globalThis as typeof globalThis & { openingNightProviders?: Record<PaymentSeller, SandboxPayPalProvider> };
/** Vault and checkout share the exact merchant client, sandbox host and zero-retry configuration. */
export const providers = shared.openingNightProviders ??= {
  venue: new SandboxPayPalProvider(merchantConfig("venue")),
  brightline: new SandboxPayPalProvider(merchantConfig("brightline")),
};
