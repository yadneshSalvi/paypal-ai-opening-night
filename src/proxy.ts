import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { THEME_BOOT_SCRIPT } from "@/components/theme";

/**
 * Site-wide Content-Security-Policy for documents.
 *
 * next.config.ts enforces a four-directive baseline on every response. This proxy adds the complete policy with a
 * fresh per-request script nonce. Next.js reads the nonce from the request's policy header and applies it to its own
 * bootstrap and chunk scripts on dynamically rendered pages (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
 *
 * The complete policy is sent as Content-Security-Policy-Report-Only until the browser checks in docs/OPERATIONS.md
 * ("Content-Security-Policy") have been completed against a production build. Setting the server environment variable
 * OPENING_NIGHT_CSP_ENFORCE=1 then sends the same policy as an enforced Content-Security-Policy; unsetting it reverts
 * without a code change.
 *
 * What the application actually loads, by directive:
 * - script-src: same-origin Next.js chunks only. No third-party script and no PayPal JS SDK; buyer approval is a
 *   top-level navigation to PayPal. Inline scripts must carry this request's nonce. Development adds 'unsafe-eval'
 *   because React uses eval for debugging there; production does not.
 * - style-src: Bryntum and AG Charts write inline style attributes and style elements at runtime, so inline styles are
 *   allowed. A nonce is deliberately absent from style-src: browsers ignore 'unsafe-inline' when a nonce is present.
 * - img-src: same-origin, data: (server-drawn delivery QR codes, Bryntum CSS images) and blob: (QR photo upload preview).
 * - font-src: next/font and Bryntum Font Awesome files are self-hosted by the build.
 * - connect-src: only same-origin API routes. OpenAI and PayPal are called from the server, never the browser.
 * - media-src: read-aloud audio is played from a blob: URL; the microphone is a MediaStream, outside CSP.
 * - worker-src: the crew offline shell service worker at /crew/sw.js.
 * - frame-src: none. The app embeds no frame.
 */
/**
 * Pages whose source has no request-time data, so `next build` prerenders them and their inline bootstrap scripts
 * cannot carry a per-request nonce. They receive the same policy with script-src 'self' 'unsafe-inline' instead of a
 * nonce. To tighten one, make it request-rendered (`await connection()` from next/server in the page) and remove it
 * here. Every other document, including unknown paths, is rendered per request by the catch-all console route.
 */
const prerenderedDocuments = new Set(["/evaluation", "/attendee", "/planning-workbench", "/approvals", "/approvals/review", "/inputs", "/suppliers/manage", "/suppliers/manage/owner"]);
/**
 * Reviewed inline scripts that cannot receive the nonce attribute because the layout that emits them must stay
 * prerenderable. Each is allowed by the SHA-256 of its exact text, computed from the same constant the layout renders,
 * so the allowance follows the script when it changes. Currently: the no-flash theme script in src/app/layout.tsx.
 * A script rendered with `nonce={(await headers()).get("x-nonce") ?? undefined}` needs no entry.
 */
const reviewedInlineScripts = [THEME_BOOT_SCRIPT];
const reviewedInlineScriptHashes = reviewedInlineScripts.map(text => `'sha256-${createHash("sha256").update(text).digest("base64")}'`);

function completePolicy(nonce: string | null, development: boolean) {
  // A prerendered page has no request at build time, so its inline bootstrap scripts cannot carry a nonce.
  const script = nonce ? ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...reviewedInlineScriptHashes].join(" ") : "'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    `script-src ${script}${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const prerendered = prerenderedDocuments.has(path.length > 1 ? path.replace(/\/+$/, "") : path);
  const nonce = prerendered ? null : Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
  const enforce = process.env.OPENING_NIGHT_CSP_ENFORCE === "1";
  const name = enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
  // upgrade-insecure-requests is ignored (with a console warning) in a report-only policy.
  const policy = completePolicy(nonce, process.env.NODE_ENV === "development") + (enforce && process.env.NODE_ENV === "production" ? "; upgrade-insecure-requests" : "");
  const headers = new Headers(request.headers);
  // Never let a client choose the nonce Next.js stamps onto scripts.
  headers.delete("content-security-policy"); headers.delete("content-security-policy-report-only"); headers.delete("x-nonce");
  if (nonce) { headers.set("x-nonce", nonce); headers.set(name, policy); }
  const response = NextResponse.next({ request: { headers } });
  response.headers.set(name, policy);
  return response;
}

export const config = {
  matcher: [{
    // Documents only: API routes keep the baseline from next.config.ts; build assets and public files need no document policy.
    source: "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)",
    missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }],
  }],
};
