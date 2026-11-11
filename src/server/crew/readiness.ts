import type { CueScope, ShowSnapshot } from "@/domain/contracts";
import { readiness as compute, allReadiness as computeAll } from "@/domain/readiness";
import { projectExecutionMilestones as project } from "@/domain/milestones";
import { verifyCrewRecord } from "./signatures";

// All server consumers share the same trusted verification boundary. Pure
// domain consumers without a verifier cannot turn signed crew gates green.
export const readiness = (show: ShowSnapshot, scope: CueScope, now?: string) => compute(show, scope, now, verifyCrewRecord);
export const allReadiness = (show: ShowSnapshot) => computeAll(show, verifyCrewRecord);
export const projectExecutionMilestones = (show: ShowSnapshot) => project(show, verifyCrewRecord);
