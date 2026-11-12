import type { PoolClient } from "pg";
import { applyCommand } from "@/domain/commands";
import { digest } from "@/domain/hash";
import type { ShowSnapshot,VerifiedPlanConsent } from "@/domain/contracts";
import type { ConsentCommandResult,ProducerConsentEnvelope,ProducerConsentScope } from "@/domain/plan-consents";
import { transactCommand } from "../store";
import { currentConsentCandidate,consentFail } from "./policy";
import { consentNow,consentShow,consentTransaction,originalConsentReceipt,producerReceiptScope,requestById,requestView,requireApprovalRevision,requireConsentProducer,requireReviewAccess,saveConsentReceipt,type ConsentAuthority } from "./store";

export async function currentVerifiedConsents(db:PoolClient,show:ShowSnapshot,authority:ConsentAuthority,scope:ProducerConsentScope,candidateId:string,candidateDigest:string):Promise<VerifiedPlanConsent[]>{
  const candidate=currentConsentCandidate(show,candidateId,candidateDigest),proofs:VerifiedPlanConsent[]=[];
  for(const requirement of candidate.approvals.filter(item=>item.role==="artist_representative")){
    const found=(await db.query<{id:string}>("SELECT id FROM on_plan_consent_requests WHERE tenant_id=$1 AND candidate_id=$2 AND candidate_digest=$3 AND requirement_id=$4",[show.tenantId,candidate.id,candidate.digest,requirement.id])).rows[0];
    if(!found)consentFail("APPROVAL_ROLE_REQUIRED",`${requirement.label} requires the invited artist representative.`,403);
    const row=await requestById(db,show.tenantId,found.id);
    if(row.issuer_session_hash!==authority.sessionHash||row.issuer_fingerprint!==scope.sessionFingerprint||row.exact_issuer_expiry!==scope.sessionExpiresAt)consentFail("PLAN_CONSENT_ORIGINAL_ISSUER","This consent was requested by different original producer access.",403);
    await requireReviewAccess(db,row);
    const view=await requestView(db,show,row,authority);
    if(view.state!=="consented"||view.decision?.decision!=="approve")consentFail("PLAN_CONSENT_NOT_APPROVED",view.blocker??"The invited representative has not approved this exact proposal.");
    const decision=view.decision;
    proofs.push({requestId:row.id,receiptId:decision.id,receiptDigest:decision.receiptDigest,requirementId:row.requirement_id,role:"artist_representative",reviewerId:decision.reviewerId,declaredName:decision.declaredName,candidateDigest:row.candidate_digest,sourceDigest:row.source_digest,baseRevision:row.base_revision,approvedAt:decision.recordedAt,expiresAt:row.exact_expiry,provenance:view.review.provenance,issuerActorId:row.issuer_actor_id});
  }
  return proofs;
}

/** Same production transaction as ordinary approval, with a separate immutable command receipt. */
export async function approveConsentedPlan(authority:ConsentAuthority,envelope:ProducerConsentEnvelope):Promise<ConsentCommandResult>{
  if(envelope.command.type!=="approve_plan")consentFail("PLAN_CONSENT_COMMAND","Choose the exact plan approval command.",400);
  const command={type:"approve" as const,candidateId:envelope.command.candidateId,candidateDigest:envelope.command.candidateDigest,approvals:envelope.command.approvals};
  const payload={...command,consentScope:envelope.scope,approvalRevision:envelope.approvalRevision};
  let proof:VerifiedPlanConsent[]=[],scope:ProducerConsentScope|undefined,next:ShowSnapshot|undefined,at="",committed=false;
  await transactCommand(authority.actor,envelope.commandId,envelope.expectedRevision,payload,show=>{
    if(!scope||!at)consentFail("PLAN_CONSENT_REVIEW_REQUIRED","The original consent authority has not been checked.");
    next=applyCommand(show,authority.actor,command,at,undefined,undefined,proof);return next;
  },async db=>{
    scope=await requireConsentProducer(db,authority,envelope.scope);
    const original=await originalConsentReceipt(db,producerReceiptScope(authority,scope),envelope.commandId,digest(envelope));
    if(original)return;
    if((await db.query("SELECT 1 FROM on_commands WHERE tenant_id=$1 AND command_id=$2",[authority.actor.tenantId,envelope.commandId])).rowCount)consentFail("PLAN_CONSENT_IDEMPOTENCY","This command identity already belongs to another production action.");
    await requireApprovalRevision(db,authority.actor.tenantId,envelope.approvalRevision);
    const show=await consentShow(db,authority.actor.tenantId);
    if(show.revision!==envelope.expectedRevision)consentFail("STALE_REVISION","The current production revision changed.");
    proof=await currentVerifiedConsents(db,show,authority,scope,command.candidateId,command.candidateDigest);at=await consentNow(db);
  },async db=>{
    if(!scope||!next)consentFail("PLAN_CONSENT_REVIEW_REQUIRED","The exact producer approval was not prepared.");
    await requireConsentProducer(db,authority,scope);
    for(const item of proof){
      await requireReviewAccess(db,await requestById(db,authority.actor.tenantId,item.requestId));
      await db.query("INSERT INTO on_plan_consent_consumptions(request_id,tenant_id,command_id,candidate_digest,producer_actor_id,issuer_session_hash,plan_version,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[item.requestId,authority.actor.tenantId,envelope.commandId,command.candidateDigest,authority.actor.id,authority.sessionHash,next.planVersion,at]);
    }
    await saveConsentReceipt(db,producerReceiptScope(authority,scope),envelope.commandId,digest(envelope),"approve_plan",{revision:next.revision,planVersion:next.planVersion,candidateDigest:command.candidateDigest,externalApprovals:next.approvedPlan?.externalApprovals??[],message:"The producer approved this exact plan with its separate saved consent. Commercial execution and publication remain separate."});
    committed=true;
  });
  return consentTransaction(async db=>{
    const current=await requireConsentProducer(db,authority,envelope.scope);
    const receipt=await originalConsentReceipt(db,producerReceiptScope(authority,current),envelope.commandId,digest(envelope));
    if(!receipt)consentFail("PLAN_CONSENT_COMMAND_NOT_FOUND","The original command receipt could not be read. Keep the same instruction identity.",404);
    return {...receipt,replayed:!committed};
  });
}
