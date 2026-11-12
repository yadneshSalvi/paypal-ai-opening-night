import { randomBytes,randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { digest } from "@/domain/hash";
import { producerConsentEnvelopeSchema,reviewerConsentEnvelopeSchema,type ConsentCommandResult,type ConsentDecision,type ConsentReview,type ConsentRequestView,type ProducerConsentEnvelope,type ProducerConsentWorkspace,type ReviewerConsentEnvelope,type ReviewerConsentView } from "@/domain/plan-consents";
import { env } from "../env";
import { sealIntelligence } from "../intelligence/private-payload";
import { requireSupplierTermsForApproval } from "../supplier-recovery/approval";
import { approveConsentedPlan } from "./approval";
import { artistChanges,artistRequirement,consentFail,currentConsentCandidate } from "./policy";
import { approvalRevision,consentCapabilityHash,consentContext,consentDecision,consentNow,consentShow,consentTransaction,originalConsentReceipt,producerReceiptScope,requestById,requestByToken,requestSelect,requestView,requireApprovalRevision,requireConsentProducer,requireReviewAccess,retainedReview,reviewerConsentFingerprint,reviewerReceiptScope,saveConsentReceipt,signConsent,type ConsentAuthority,type ConsentRequestRow } from "./store";

export async function consentWorkspace(authority:ConsentAuthority):Promise<ProducerConsentWorkspace>{
  return consentTransaction(async db=>{
    const scope=await requireConsentProducer(db,authority),show=await consentShow(db,authority.actor.tenantId);
    const rows=(await db.query<ConsentRequestRow>(`SELECT ${requestSelect} FROM on_plan_consent_requests r WHERE r.tenant_id=$1 ORDER BY r.created_at DESC,r.id`,[show.tenantId])).rows;
    const requests:ConsentRequestView[]=[];for(const row of rows)requests.push(await requestView(db,show,row,authority));
    const candidates=(show.runs.at(-1)?.candidates??[]).filter(candidate=>candidate.approvals.some(item=>item.role==="artist_representative")).map(candidate=>{
      let current=true,blocker:string|null=null;
      try{currentConsentCandidate(show,candidate.id,candidate.digest);}catch(error){current=false;blocker=error instanceof Error?error.message:"This proposal needs a new review.";}
      const offer=show.offers.find(item=>item.id===candidate.patch.offerId);
      return {candidate,current,blocker,supplierName:offer?.supplier??"Original supplier unavailable",depositMinor:offer?.depositMinor??0,commercialCapMinor:(offer?.feeMinor??0)+(offer?.depositMinor??0),changes:artistChanges(show,candidate),requests:requests.filter(item=>item.review.candidate.id===candidate.id&&item.review.candidate.digest===candidate.digest).map(item=>({requirementId:item.review.requirement.id,requestId:item.review.requestId,state:item.state,ownOriginalAccess:item.ownOriginalAccess}))};
    });
    return {scope,revision:show.revision,approvalRevision:await approvalRevision(db,show.tenantId),serverAt:await consentNow(db),production:{title:show.title,venue:show.venue,showDate:show.showDate,zone:show.zone},actorRoles:[...authority.actor.roles],sources:show.sources,candidates,requests};
  });
}
export async function readProducerConsentCommand(authority:ConsentAuthority,commandId:string){
  return consentTransaction(async db=>{
    await consentShow(db,authority.actor.tenantId,true);
    const scope=await requireConsentProducer(db,authority),result=await originalConsentReceipt(db,producerReceiptScope(authority,scope),commandId);
    if(!result)consentFail("PLAN_CONSENT_COMMAND_NOT_FOUND","No saved result exists for this exact instruction and original access.",404);return result;
  });
}
export async function reviewConsent(token:string):Promise<ReviewerConsentView>{
  return consentTransaction(async db=>{
    const row=await requestByToken(db,token);await requireReviewAccess(db,row);
    const view=await requestView(db,await consentShow(db,row.tenant_id),row),{ownOriginalAccess:_own,originalReviewPath:_path,...safe}=view;
    return {...safe,capabilityFingerprint:reviewerConsentFingerprint(row),serverAt:await consentNow(db)};
  });
}
export async function readReviewerConsentCommand(token:string,commandId:string){
  return consentTransaction(async db=>{
    const row=await requestByToken(db,token);await consentShow(db,row.tenant_id,true);await requireReviewAccess(db,row);
    const result=await originalConsentReceipt(db,reviewerReceiptScope(row),commandId);
    if(!result)consentFail("PLAN_CONSENT_COMMAND_NOT_FOUND","No original decision receipt exists for this review access.",404);return result;
  });
}

async function invite(db:PoolClient,authority:ConsentAuthority,envelope:ProducerConsentEnvelope){
  if(envelope.command.type!=="invite")consentFail("PLAN_CONSENT_COMMAND","Choose an invitation instruction.",400);
  const command=envelope.command,show=await consentShow(db,authority.actor.tenantId),candidate=currentConsentCandidate(show,command.candidateId,command.candidateDigest,envelope.expectedRevision),requirement=artistRequirement(candidate,command.requirementId);
  await requireSupplierTermsForApproval(db,show,candidate.id);
  const source=show.sources.find(item=>item.id===command.sourceId),performance=candidate.patch.tasks.find(task=>task.id==="headliner");
  if(!source||!performance||performance.sourceId!==source.id)consentFail("PLAN_CONSENT_SOURCE_REQUIRED","Review the exact source attached to the proposed headliner performance.");
  if((await db.query("SELECT 1 FROM on_plan_consent_requests WHERE tenant_id=$1 AND candidate_id=$2 AND candidate_digest=$3 AND requirement_id=$4",[show.tenantId,candidate.id,candidate.digest,requirement.id])).rowCount)consentFail("PLAN_CONSENT_ALREADY_REQUESTED","This exact requirement already has an immutable review. Read its original result; a changed proposal needs a distinct review.");
  if((await db.query<{count:number}>("SELECT count(*)::integer AS count FROM on_plan_consent_requests WHERE tenant_id=$1",[show.tenantId])).rows[0]!.count>=200)consentFail("PLAN_CONSENT_LIMIT","This production has reached its 200 retained review bound. Its complete history remains readable.",422);
  const createdAt=await consentNow(db),offer=show.offers.find(item=>item.id===candidate.patch.offerId)!;
  const expiresAt=(await db.query<{expiry:string}>(`SELECT to_char(LEAST($1::timestamptz,$2::timestamptz+($3::integer*interval '1 minute'),COALESCE($4::timestamptz,$1::timestamptz)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry`,[envelope.scope.sessionExpiresAt,createdAt,command.validityMinutes,offer.serviceQuote?.validUntil??null])).rows[0]!.expiry;
  if(Date.parse(expiresAt)<=Date.parse(createdAt))consentFail("PLAN_CONSENT_REVIEW_ENDED","The current quote or producer access ended before an invitation could be saved.");
  const id=randomUUID(),token=randomBytes(32).toString("base64url"),capHash=consentCapabilityHash(token);
  const review:ConsentReview={version:1,requestId:id,production:{title:show.title,venue:show.venue,showDate:show.showDate,zone:show.zone},candidate:{id:candidate.id,name:candidate.name,digest:candidate.digest,sourceDigest:candidate.sourceDigest,baseRevision:show.revision},requirement,representative:{invitedName:command.representativeName,basis:command.representationBasis,source:structuredClone(source)},changes:artistChanges(show,candidate),proposedDoorsAt:candidate.patch.doorsAt,createdAt,expiresAt,provenance:env.controlledQa?"controlled_declaration":"invited_declaration",authorityNotice:"The producer designates this review access. Its holder explicitly declares their representative authority; the app does not independently verify a person's identity or physical participation. This consent does not approve payment, technical work, publication or GO."};
  const reviewDigest=digest(review);
  await db.query("INSERT INTO on_plan_consent_requests(id,tenant_id,issuer_actor_id,issuer_actor,issuer_session_hash,issuer_expires_at,issuer_fingerprint,candidate_id,candidate_digest,source_digest,base_revision,requirement_id,role,cap_hash,cap_cipher,review_cipher,review_digest,created_at,expires_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,'artist_representative',$13,$14,$15,$16,$17,$18)",[id,show.tenantId,authority.actor.id,JSON.stringify(authority.actor),authority.sessionHash,envelope.scope.sessionExpiresAt,envelope.scope.sessionFingerprint,candidate.id,candidate.digest,candidate.sourceDigest,show.revision,requirement.id,capHash,sealIntelligence(show.tenantId,consentContext(id,"capability"),token),sealIntelligence(show.tenantId,consentContext(id,"review"),review),reviewDigest,createdAt,expiresAt]);
  return {requestId:id,reviewDigest,reviewPath:`/approvals/review#${token}`,message:"One exact review invitation is saved. Share it with the designated representative; it grants no production or financial access."};
}
export async function executeProducerConsent(authority:ConsentAuthority,raw:ProducerConsentEnvelope):Promise<ConsentCommandResult>{
  const envelope=producerConsentEnvelopeSchema.parse(raw);
  if(envelope.command.type==="approve_plan")return approveConsentedPlan(authority,envelope);
  return consentTransaction(async db=>{
    const show=await consentShow(db,authority.actor.tenantId,true),scope=await requireConsentProducer(db,authority,envelope.scope),receiptScope=producerReceiptScope(authority,scope),requestDigest=digest(envelope);
    const original=await originalConsentReceipt(db,receiptScope,envelope.commandId,requestDigest);if(original)return original;
    if(show.revision!==envelope.expectedRevision)consentFail("STALE_REVISION","The production changed. Review its current source before a new instruction.");
    await requireApprovalRevision(db,show.tenantId,envelope.approvalRevision);
    if(envelope.command.type==="invite"){
      const result=await invite(db,authority,envelope);await requireConsentProducer(db,authority,scope);
      return saveConsentReceipt(db,receiptScope,envelope.commandId,requestDigest,"invite",result);
    }
    const command=envelope.command;
    if(command.type!=="revoke")consentFail("PLAN_CONSENT_COMMAND","Choose a supported consent instruction.",400);
    const row=await requestById(db,show.tenantId,command.requestId);
    if(row.issuer_session_hash!==authority.sessionHash||row.exact_issuer_expiry!==scope.sessionExpiresAt||row.issuer_fingerprint!==scope.sessionFingerprint)consentFail("PLAN_CONSENT_ORIGINAL_ISSUER","Only the original producer access stops this invitation.",403);
    if(row.review_digest!==command.reviewDigest)consentFail("PLAN_CONSENT_REVIEW_CHANGED","Review the original content before stopping its access.");
    if((await db.query("SELECT 1 FROM on_plan_consent_revocations WHERE request_id=$1",[row.id])).rowCount)consentFail("PLAN_CONSENT_ALREADY_REVOKED","This original access is already stopped. Read its retained receipt.");
    await db.query("INSERT INTO on_plan_consent_revocations(request_id,tenant_id,actor_id,issuer_session_hash,command_id,reason,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[row.id,show.tenantId,authority.actor.id,authority.sessionHash,envelope.commandId,command.reason,await consentNow(db)]);
    return saveConsentReceipt(db,receiptScope,envelope.commandId,requestDigest,"revoke",{requestId:row.id,reviewDigest:row.review_digest,message:"Unused review access is stopped. Original decisions and any already committed producer approval remain historical."});
  });
}
export async function executeReviewerConsent(token:string,raw:ReviewerConsentEnvelope):Promise<ConsentCommandResult>{
  const envelope=reviewerConsentEnvelopeSchema.parse(raw);
  return consentTransaction(async db=>{
    const first=await requestByToken(db,token),show=await consentShow(db,first.tenant_id,true),row=await requestById(db,first.tenant_id,first.id);
    await requireReviewAccess(db,row);
    if(row.id!==envelope.requestId||row.review_digest!==envelope.reviewDigest||row.exact_expiry!==envelope.expiresAt||reviewerConsentFingerprint(row)!==envelope.capabilityFingerprint)consentFail("PLAN_CONSENT_REVIEW_CHANGED","This instruction belongs to different original reviewed content or access.");
    const receiptScope=reviewerReceiptScope(row),requestDigest=digest(envelope),original=await originalConsentReceipt(db,receiptScope,envelope.commandId,requestDigest);if(original)return original;
    const review=retainedReview(row);
    if(envelope.declaredName.normalize("NFKC").toLocaleLowerCase("en-US")!==review.representative.invitedName.normalize("NFKC").toLocaleLowerCase("en-US"))consentFail("PLAN_CONSENT_NAME_CHANGED","This invitation names a different representative. Ask the producer for a new correct review.",403);
    currentConsentCandidate(show,row.candidate_id,row.candidate_digest,row.base_revision);await requireSupplierTermsForApproval(db,show,row.candidate_id);
    if(await consentDecision(db,row))consentFail("PLAN_CONSENT_ALREADY_DECIDED","This exact review already has a decision. Read its original receipt.");
    if((await db.query("SELECT 1 FROM on_plan_consent_consumptions WHERE request_id=$1",[row.id])).rowCount)consentFail("PLAN_CONSENT_ALREADY_COMMITTED","The producer already included the original decision in an approved plan.");
    const content={id:randomUUID(),requestId:row.id,decision:envelope.decision,declaredName:envelope.declaredName,statement:envelope.statement,reviewDigest:row.review_digest,recordedAt:await consentNow(db),reviewerId:`plan-review:${row.id}`};
    const decision:ConsentDecision={...content,receiptDigest:digest(content)};
    await requireReviewAccess(db,row);
    await db.query("INSERT INTO on_plan_consent_decisions(id,tenant_id,request_id,cap_hash,review_digest,decision,decision_cipher,decision_digest,signature,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[decision.id,row.tenant_id,row.id,row.cap_hash,row.review_digest,decision.decision,sealIntelligence(row.tenant_id,consentContext(row.id,"decision"),decision),decision.receiptDigest,signConsent(row.tenant_id,row.id,row.cap_hash,decision.receiptDigest),decision.recordedAt]);
    return saveConsentReceipt(db,receiptScope,envelope.commandId,requestDigest,envelope.decision,{requestId:row.id,reviewDigest:row.review_digest,decision,message:envelope.decision==="approve"?"Your separate consent is saved. The producer must still approve the current plan.":"Your refusal is saved. This exact proposal has not been approved."});
  });
}
