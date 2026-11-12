import { DomainError, type Candidate, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { planningDigest, validatePatch } from "@/domain/scheduling";
import type { ConsentReview } from "@/domain/plan-consents";

export function consentFail(code: string, message: string, status = 409): never { throw new DomainError(code,message,status); }
export function currentConsentCandidate(show: ShowSnapshot, candidateId: string, candidateDigest: string, expectedRevision?: number): Candidate {
  if (expectedRevision !== undefined && expectedRevision !== show.revision) consentFail("PLAN_CONSENT_SOURCE_CHANGED", "The production changed after this review. Keep its history and review a current alternative.");
  const candidate = show.runs.at(-1)?.candidates.find(item => item.id === candidateId);
  if (!candidate || candidate.digest !== candidateDigest || candidate.sourceDigest !== planningDigest(show)) consentFail("PLAN_CONSENT_SOURCE_CHANGED", "This exact candidate is no longer the current production proposal.");
  if (digest({ patch:candidate.patch, approvals:candidate.approvals.map(item=>({...item,grantedBy:null})), cost:candidate.cost }) !== candidate.digest) consentFail("PLAN_CONSENT_INTEGRITY", "The saved proposal no longer matches its exact content.",503);
  const offer=show.offers.find(item=>item.id===candidate.patch.offerId);
  if (!offer) consentFail("PLAN_CONSENT_SOURCE_CHANGED", "The original supplier offer is no longer available for this review.");
  const engine=candidate.report.engine;
  if (!engine || engine.status!=="passed" || engine.inputDigest!==digest({tasks:candidate.patch.tasks,dependencies:candidate.patch.dependencies}) || engine.dates.length!==candidate.patch.tasks.length || candidate.patch.tasks.some(task=>!engine.dates.some(date=>date.id===task.id&&Date.parse(date.start)===Date.parse(task.start)&&Date.parse(date.end)===Date.parse(task.end)))) consentFail("PLAN_CONSENT_ENGINE_REQUIRED", "This proposal needs a successful engine result for its exact task graph.");
  const checked=validatePatch(show,candidate.patch,offer);
  if (!["feasible","feasible_with_approval"].includes(checked.status)) consentFail("PLAN_CONSENT_NOT_FEASIBLE", checked.issues.find(item=>item.severity!=="approval")?.message??"Resolve the current hard constraints before requesting consent.");
  return candidate;
}
export function artistRequirement(candidate: Candidate, requirementId: string) {
  const requirement=candidate.approvals.find(item=>item.id===requirementId);
  if (!requirement || requirement.role!=="artist_representative") consentFail("PLAN_CONSENT_ROLE_REQUIRED", "This access can review only the proposal's named artist requirement.",403);
  return {id:requirement.id,label:requirement.label,role:"artist_representative" as const};
}
export function artistChanges(show: ShowSnapshot,candidate: Candidate): ConsentReview["changes"] {
  const selected=new Set(["headliner","headliner-arrival","headliner-check","quiet-prep","support","changeover","vip"]);
  const ids=new Set([...show.tasks,...candidate.patch.tasks].filter(task=>selected.has(task.id)).map(task=>task.id));
  return [...ids].flatMap(id=>{
    const before=show.tasks.find(task=>task.id===id),proposed=candidate.patch.tasks.find(task=>task.id===id);
    const interval=(task:typeof before)=>task?{start:task.start,end:task.end,minutes:task.durationMinutes}:null;
    const from=interval(before),to=interval(proposed);
    return digest(from)===digest(to)?[]:[{taskId:id,name:proposed?.name??before!.name,before:from,proposed:to}];
  });
}
