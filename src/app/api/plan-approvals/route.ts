import { producerConsentEnvelopeSchema } from "@/domain/plan-consents";
import { assertSameOrigin } from "@/server/http";
import { planningAuthority, planningBody } from "@/server/intelligence/http";
import { consentCommandId, consentError, consentJson } from "@/server/plan-consents/http";
import { consentWorkspace, executeProducerConsent, readProducerConsentCommand } from "@/server/plan-consents/service";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const id = consentCommandId(request), authority = await planningAuthority(request);
    return consentJson(id ? await readProducerConsentCommand(authority, id) : await consentWorkspace(authority));
  } catch (error) { return consentError(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return consentJson(await executeProducerConsent(await planningAuthority(request), await planningBody(request, producerConsentEnvelopeSchema)));
  } catch (error) { return consentError(error); }
}
