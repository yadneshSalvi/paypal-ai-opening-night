import type { ShowSnapshot } from "@/domain/contracts";
import { isDemonstration } from "@/domain/judge/contracts";
import { env } from "../env";

/**
 * Judge-visible "controlled" labeling. The local QA flag stays env-global and
 * is never set on hosted deployments; a guided demonstration is labeled per
 * tenant from its immutable creation marker. No other rehearsal can be
 * labeled controlled through this helper.
 */
export function controlledPresentation(show: Pick<ShowSnapshot, "demonstration"> | null | undefined): boolean {
  return env.controlledQa || isDemonstration(show);
}
