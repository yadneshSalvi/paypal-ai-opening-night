import type { SandboxConfig } from "@fracture/paypal-core";
import type { PaymentSeller } from "@/domain/payment-authority";
import "./env";

function required(key: string) { const value = process.env[key]; if (!value) throw new Error("Missing payment configuration: " + key); return value; }
export function merchantConfig(seller: PaymentSeller): SandboxConfig {
  if (required("PAYPAL_ENVIRONMENT") !== "sandbox" || required("PAYPAL_API_BASE_URL") !== "https://api-m.sandbox.paypal.com" || required("PAYPAL_PROJECT_ISOLATED") !== "true") throw new Error("Opening Night requires isolated PayPal sandbox configuration.");
  if (required("PAYPAL_CLIENT_ID") === required("OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID")) throw new Error("Opening Night and Brightline must use different merchant apps.");
  return { environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", isolatedProject: "opening-night:" + seller,
    clientId: required(seller === "venue" ? "PAYPAL_CLIENT_ID" : "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_ID"),
    clientSecret: required(seller === "venue" ? "PAYPAL_CLIENT_SECRET" : "OPENING_NIGHT_SUPPLIER_PAYPAL_CLIENT_SECRET") };
}
