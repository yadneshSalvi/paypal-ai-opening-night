import type { ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import type { SourceBaselineRetention } from "@/domain/sources";

/** Server-owned retention values are bound to the complete saved production, not inferred from uploaded text. */
export function sourceBaselineRetention(show: ShowSnapshot): SourceBaselineRetention {
  return { baseRevision: show.revision, baseDigest: digest(show), policy: { maxShiftMinutes: show.policy.maxShiftMinutes, refundCount: show.policy.refundCount, criticalCrewCount: show.policy.criticalCrewCount } };
}
