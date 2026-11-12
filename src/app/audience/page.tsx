import type { Metadata } from "next";
import { ProducerAudience } from "@/components/audience/producer";
import { audienceAuthority } from "@/server/audience/http";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audience updates — Opening Night", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function AudiencePage() {
  let tenantId: string | null = null;
  try { const authority = await audienceAuthority(); tenantId = authority.actor.tenantId; } catch { /* The dedicated client presents explicit access and retry states; it never creates a session. */ }
  return <ProducerAudience tenantId={tenantId} />;
}
