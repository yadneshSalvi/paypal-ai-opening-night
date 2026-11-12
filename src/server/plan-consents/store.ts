import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor, ShowSnapshot } from "@/domain/contracts";
import type { ConsentCommandResult, ConsentDecision, ConsentReceipt, ConsentRequestView, ConsentReview, ProducerConsentScope } from "@/domain/plan-consents";
import { digest } from "@/domain/hash";
import { env } from "../env";
import { migrate,pool } from "../store";
import { openIntelligence,sealIntelligence } from "../intelligence/private-payload";
import { consentFail,currentConsentCandidate } from "./policy";

export interface ConsentAuthority { actor: Actor; sessionHash: string }
export interface ConsentRequestRow {
  id:string;tenant_id:string;issuer_actor_id:string;issuer_actor:Actor;issuer_session_hash:string;issuer_fingerprint:string;
  candidate_id:string;candidate_digest:string;source_digest:string;base_revision:number;requirement_id:string;role:"artist_representative";
  cap_hash:string;cap_cipher:string;review_cipher:string;review_digest:string;
  exact_expiry:string;exact_issuer_expiry:string;exact_created:string;
}
interface DecisionRow { id:string;tenant_id:string;request_id:string;cap_hash:string;review_digest:string;decision:string;decision_cipher:string;decision_digest:string;signature:string }
interface CommandRow { scope_kind:"producer"|"reviewer";scope_hash:string;exact_expiry:string;request_hash:string;receipt_cipher:string;receipt_digest:string }
export const requestSelect=`r.*,to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_expiry,to_char(r.issuer_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_issuer_expiry,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_created`;
export const consentContext=(id:string,part:string)=>`plan-consent:${id}:${part}`;
export const consentCapabilityHash=(token:string)=>digest({purpose:"opening-night/plan-consent-capability/v1",secret:env.sessionSecret,token});
export const producerConsentFingerprint=(authority:ConsentAuthority,expiresAt:string)=>digest({purpose:"opening-night/plan-consent-producer/v1",actor:authority.actor,sessionHash:authority.sessionHash,expiresAt});
export const reviewerConsentFingerprint=(row:ConsentRequestRow)=>digest({purpose:"opening-night/plan-consent-reviewer/v1",requestId:row.id,capHash:row.cap_hash,reviewDigest:row.review_digest,expiresAt:row.exact_expiry});
export function signConsent(tenantId:string,requestId:string,capHash:string,decisionDigest:string){return createHmac("sha256",env.sessionSecret).update(`opening-night/plan-consent-decision/v1:${tenantId}:${requestId}:${capHash}:${decisionDigest}`).digest("hex");}
export async function consentNow(db:PoolClient){return (await db.query<{now:string}>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)).rows[0]!.now;}
export async function consentTransaction<T>(run:(db:PoolClient)=>Promise<T>){
  await migrate();const db=await pool.connect();
  try{await db.query("BEGIN");const value=await run(db);await db.query("COMMIT");return value;}
  catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
}
export async function consentShow(db:PoolClient,tenantId:string,lock=false){
  const row=(await db.query<{snapshot:ShowSnapshot}>(`SELECT snapshot FROM on_shows WHERE tenant_id=$1${lock?" FOR UPDATE":""}`,[tenantId])).rows[0];
  if(!row)consentFail("PLAN_CONSENT_NOT_FOUND","This production is no longer available.",404);return row.snapshot;
}
export async function requireConsentProducer(db:PoolClient,authority:ConsentAuthority,expected?:ProducerConsentScope):Promise<ProducerConsentScope>{
  const actor=authority.actor;
  if(actor.personId||actor.executionId||actor.supplierId||!actor.roles.includes("producer"))consentFail("PLAN_CONSENT_PRODUCER_REQUIRED","The original producer manages this consent review.",403);
  const row=(await db.query<{expiry:string}>(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry FROM on_sessions WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3::jsonb AND expires_at>clock_timestamp() FOR SHARE`,[authority.sessionHash,actor.tenantId,JSON.stringify(actor)])).rows[0];
  if(!row)consentFail("PLAN_CONSENT_ACCESS_ENDED","This exact producer access ended. Its original decisions are retained.",401);
  const scope={tenantId:actor.tenantId,actorId:actor.id,sessionExpiresAt:row.expiry,sessionFingerprint:producerConsentFingerprint(authority,row.expiry)};
  if(expected&&digest(expected)!==digest(scope))consentFail("PLAN_CONSENT_ACCESS_CHANGED","This instruction belongs to different original access or expiry. It cannot move to the current session.",401);
  return scope;
}
export async function requireRequestIssuer(db:PoolClient,row:ConsentRequestRow){
  return requireConsentProducer(db,{actor:row.issuer_actor,sessionHash:row.issuer_session_hash},{tenantId:row.tenant_id,actorId:row.issuer_actor_id,sessionExpiresAt:row.exact_issuer_expiry,sessionFingerprint:row.issuer_fingerprint});
}
export async function approvalRevision(db:PoolClient,tenantId:string){return (await db.query<{revision:number}>("SELECT count(*)::integer AS revision FROM on_plan_consent_commands WHERE tenant_id=$1",[tenantId])).rows[0]!.revision;}
export async function requireApprovalRevision(db:PoolClient,tenantId:string,expected:number){if(await approvalRevision(db,tenantId)!==expected)consentFail("PLAN_CONSENT_REVIEW_CHANGED","The consent record advanced. Read the current decisions before a new instruction.");}
export async function requestById(db:PoolClient,tenantId:string,id:string){
  const row=(await db.query<ConsentRequestRow>(`SELECT ${requestSelect} FROM on_plan_consent_requests r WHERE r.tenant_id=$1 AND r.id=$2`,[tenantId,id])).rows[0];
  if(!row)consentFail("PLAN_CONSENT_NOT_FOUND","This original review is not in the current production.",404);return row;
}
export async function requestByToken(db:PoolClient,token:string){
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))consentFail("PLAN_CONSENT_REVIEW_REQUIRED","Open this review with its dedicated original link.",401);
  const row=(await db.query<ConsentRequestRow>(`SELECT ${requestSelect} FROM on_plan_consent_requests r WHERE r.cap_hash=$1`,[consentCapabilityHash(token)])).rows[0];
  if(!row)consentFail("PLAN_CONSENT_NOT_FOUND","This original review link could not be found.",404);return row;
}
export function retainedReview(row:ConsentRequestRow):ConsentReview{
  const value=openIntelligence<ConsentReview>(row.tenant_id,consentContext(row.id,"review"),row.review_cipher);
  if(digest(value)!==row.review_digest||value.requestId!==row.id||value.candidate.digest!==row.candidate_digest||value.candidate.sourceDigest!==row.source_digest||value.candidate.baseRevision!==row.base_revision||value.requirement.id!==row.requirement_id||value.requirement.role!==row.role||value.expiresAt!==row.exact_expiry||value.createdAt!==row.exact_created)consentFail("PLAN_CONSENT_INTEGRITY","The original reviewed content cannot be verified.",503);
  return value;
}
export async function consentDecision(db:PoolClient,row:ConsentRequestRow):Promise<ConsentDecision|null>{
  const record=(await db.query<DecisionRow>("SELECT * FROM on_plan_consent_decisions WHERE tenant_id=$1 AND request_id=$2",[row.tenant_id,row.id])).rows[0];if(!record)return null;
  const value=openIntelligence<ConsentDecision>(row.tenant_id,consentContext(row.id,"decision"),record.decision_cipher),{receiptDigest,...content}=value;
  const expected=Buffer.from(signConsent(row.tenant_id,row.id,row.cap_hash,receiptDigest)),actual=Buffer.from(record.signature);
  if(digest(content)!==receiptDigest||receiptDigest!==record.decision_digest||value.id!==record.id||value.requestId!==row.id||value.reviewDigest!==row.review_digest||record.review_digest!==row.review_digest||record.cap_hash!==row.cap_hash||record.decision!==value.decision||expected.length!==actual.length||!timingSafeEqual(expected,actual))consentFail("PLAN_CONSENT_INTEGRITY","The original separate decision cannot be verified.",503);
  return value;
}
export async function requestView(db:PoolClient,show:ShowSnapshot,row:ConsentRequestRow,authority?:ConsentAuthority):Promise<ConsentRequestView>{
  const review=retainedReview(row),decision=await consentDecision(db,row);
  const revokedRow=(await db.query<{at:string;reason:string}>(`SELECT to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,reason FROM on_plan_consent_revocations WHERE tenant_id=$1 AND request_id=$2`,[row.tenant_id,row.id])).rows[0];
  const consumed=(await db.query<{commandId:string;planVersion:number;at:string}>(`SELECT command_id AS "commandId",plan_version AS "planVersion",to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM on_plan_consent_consumptions WHERE tenant_id=$1 AND request_id=$2`,[row.tenant_id,row.id])).rows[0];
  let state:ConsentRequestView["state"]="awaiting_representative",blocker:string|null=null;
  if(consumed)state="committed";
  else if(revokedRow){state="revoked";blocker="The producer stopped this unused review access. Its original decision remains historical.";}
  else if(decision?.decision==="decline"){state="declined";blocker="The representative declined this proposal. Review a different current alternative.";}
  else if(!(await db.query("SELECT 1 WHERE $1::timestamptz>clock_timestamp()",[row.exact_expiry])).rowCount){state="expired";blocker="This fixed review window ended. No expiry was extended.";}
  else try{await requireRequestIssuer(db,row);currentConsentCandidate(show,row.candidate_id,row.candidate_digest,row.base_revision);if(decision)state="consented";}
  catch(error){state="source_changed";blocker=error instanceof Error?error.message:"The original source or authority changed.";}
  let ownOriginalAccess=Boolean(authority&&row.issuer_session_hash===authority.sessionHash&&row.issuer_actor_id===authority.actor.id&&producerConsentFingerprint(authority,row.exact_issuer_expiry)===row.issuer_fingerprint);
  if(ownOriginalAccess&&authority)try{await requireConsentProducer(db,authority,{tenantId:row.tenant_id,actorId:row.issuer_actor_id,sessionExpiresAt:row.exact_issuer_expiry,sessionFingerprint:row.issuer_fingerprint});}catch{ownOriginalAccess=false;}
  let originalReviewPath:string|null=null;
  if(ownOriginalAccess&&["awaiting_representative","consented","declined"].includes(state)){
    const token=openIntelligence<string>(row.tenant_id,consentContext(row.id,"capability"),row.cap_cipher);
    if(!/^[A-Za-z0-9_-]{43}$/.test(token)||consentCapabilityHash(token)!==row.cap_hash)consentFail("PLAN_CONSENT_INTEGRITY","The original invitation cannot be verified.",503);
    originalReviewPath=`/approvals/review#${token}`;
  }
  return {review,reviewDigest:row.review_digest,state,blocker,decision,revoked:revokedRow??null,committed:consumed??null,ownOriginalAccess,originalReviewPath};
}
export async function requireReviewAccess(db:PoolClient,row:ConsentRequestRow){
  await requireRequestIssuer(db,row);
  if(!(await db.query("SELECT 1 WHERE $1::timestamptz>clock_timestamp()",[row.exact_expiry])).rowCount)consentFail("PLAN_CONSENT_REVIEW_ENDED","This original review window ended. It was not extended.",410);
  if((await db.query("SELECT 1 FROM on_plan_consent_revocations WHERE tenant_id=$1 AND request_id=$2",[row.tenant_id,row.id])).rowCount)consentFail("PLAN_CONSENT_REVOKED","This original review access was stopped.",410);
}
export interface ReceiptScope {tenantId:string;kind:"producer"|"reviewer";hash:string;fingerprint:string;expiresAt:string}
export const producerReceiptScope=(authority:ConsentAuthority,scope:ProducerConsentScope):ReceiptScope=>({tenantId:scope.tenantId,kind:"producer",hash:authority.sessionHash,fingerprint:scope.sessionFingerprint,expiresAt:scope.sessionExpiresAt});
export const reviewerReceiptScope=(row:ConsentRequestRow):ReceiptScope=>({tenantId:row.tenant_id,kind:"reviewer",hash:row.cap_hash,fingerprint:reviewerConsentFingerprint(row),expiresAt:row.exact_expiry});
export async function originalConsentReceipt(db:PoolClient,scope:ReceiptScope,id:string,requestDigest?:string):Promise<ConsentCommandResult|null>{
  const row=(await db.query<CommandRow>(`SELECT *,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_expiry FROM on_plan_consent_commands WHERE tenant_id=$1 AND command_id=$2`,[scope.tenantId,id])).rows[0];if(!row)return null;
  if(row.scope_kind!==scope.kind||row.scope_hash!==scope.hash||row.exact_expiry!==scope.expiresAt)consentFail("PLAN_CONSENT_COMMAND_OWNER","That instruction belongs to different original access.",404);
  if(requestDigest&&row.request_hash!==requestDigest)consentFail("PLAN_CONSENT_IDEMPOTENCY","This command identity already has different reviewed content.");
  const receipt=openIntelligence<ConsentReceipt>(scope.tenantId,consentContext(id,"command"),row.receipt_cipher),{receiptDigest,...content}=receipt;
  if(digest(content)!==receiptDigest||receiptDigest!==row.receipt_digest||receipt.commandId!==id||receipt.requestDigest!==row.request_hash||receipt.scopeId!==scope.fingerprint||receipt.expiresAt!==scope.expiresAt)consentFail("PLAN_CONSENT_INTEGRITY","The original command receipt cannot be verified.",503);
  return {receipt,replayed:true};
}
export async function saveConsentReceipt(db:PoolClient,scope:ReceiptScope,commandId:string,requestDigest:string,action:ConsentReceipt["action"],result:ConsentReceipt["result"]):Promise<ConsentCommandResult>{
  const content={version:1 as const,commandId,action,scopeId:scope.fingerprint,expiresAt:scope.expiresAt,requestDigest,acceptedAt:await consentNow(db),result};
  const receipt:ConsentReceipt={...content,receiptDigest:digest(content)};
  await db.query("INSERT INTO on_plan_consent_commands(tenant_id,command_id,scope_kind,scope_hash,expires_at,request_hash,action,receipt_cipher,receipt_digest,committed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[scope.tenantId,commandId,scope.kind,scope.hash,scope.expiresAt,requestDigest,action,sealIntelligence(scope.tenantId,consentContext(commandId,"command"),receipt),receipt.receiptDigest,receipt.acceptedAt]);
  return {receipt,replayed:false};
}
