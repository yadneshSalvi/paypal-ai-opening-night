import { reviewerConsentEnvelopeSchema } from "@/domain/plan-consents";
import { assertSameOrigin } from "@/server/http";
import { planningBody } from "@/server/intelligence/http";
import { consentCommandId, consentError, consentJson, reviewToken } from "@/server/plan-consents/http";
import { executeReviewerConsent, readReviewerConsentCommand, reviewConsent } from "@/server/plan-consents/service";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const id = consentCommandId(request), token = reviewToken(request);
    return consentJson(id ? await readReviewerConsentCommand(token, id) : await reviewConsent(token));
  } catch (error) { return consentError(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return consentJson(await executeReviewerConsent(reviewToken(request), await planningBody(request, reviewerConsentEnvelopeSchema)));
  } catch (error) { return consentError(error); }
}
