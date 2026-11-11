/** Fresh, restricted local DB only. All economic/model observations are injected fiction. */
import "./wrap-fixture-provider.mjs";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { pool, createSession, getActor, getShow, createCrewCapability } from "../../src/server/store";
import { sessionTokenHash } from "../../src/server/session-records";
import { atVenue } from "../../src/domain/time";
import type { Actor, FinancialEvidence } from "../../src/domain/contracts";
import type { WrapCommand } from "../../src/domain/wrap/contracts";
import type { SettlementAuthority } from "../../src/server/settlement/service";
import { readWrap, executeWrap, readInvoiceReview } from "../../src/server/wrap/service";
import { runInvoiceJob } from "../../src/server/wrap/worker";
import { executeToolkit } from "../../src/server/wrap/toolkit";
import { sealWrapReport, readSealedReport } from "../../src/server/wrap/reports";
import { readSettlement, executeSettlement } from "../../src/server/settlement/service";
import { readPayouts, executePayout, readPayoutReview } from "../../src/server/payouts/service";
import { runPayoutJob } from "../../src/server/payouts/worker";
import { listJobs } from "../../src/server/jobs";
import { closeCommerceLocks } from "../../src/server/commerce-locks";
import { startWrapAssistant, advanceWrapAssistant } from "../../src/server/wrap/assistant";
import type { ProductionSettlementData, SettlementCommand } from "../../src/domain/settlement/contracts";
import type { PayoutCommand } from "../../src/domain/payouts/contracts";
import { createWrapWireFixture } from "./wrap-wire-fixture.mjs";
import { createPayoutWireFixture } from "./payout-wire-fixture.mjs";
const fixture = globalThis as typeof globalThis & { openingNightWrapFixture: ReturnType<typeof createWrapWireFixture>; openingNightPayoutFixture: ReturnType<typeof createPayoutWireFixture> };
const directory = resolve(".artifacts/wrap-4538-private"), credentialPath = resolve(directory, "native-fixture.json"), safePath = resolve(directory, "safe-summary.json");
try { await access(credentialPath); throw new Error("Retained native fixture exists; do not repeat preparation"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const database = (await pool.query("SELECT current_database() database, current_user role, rolsuper, rolcreatedb, rolcreaterole, rolinherit FROM pg_roles WHERE rolname=current_user")).rows[0];
assert.equal(database.database, "on_wrap_4538_100ba102"); assert.equal(database.role, database.database); for (const key of ["rolsuper","rolcreatedb","rolcreaterole","rolinherit"]) assert.equal(database[key], false);
const session = await createSession(undefined, "wrap-native:" + randomUUID()), other = await createSession(undefined, "wrap-http-denials:" + randomUUID()), authority: SettlementAuthority = { actor: session.actor, sessionHash: sessionTokenHash(session.token), scope: "production" }, wire = fixture.openingNightWrapFixture;
const privateData: Record<string, any> = { state: "preparing", database: database.database, origin: "http://127.0.0.1:4538", bootstrapKey: randomBytes(32).toString("base64url"), producer: { token: session.token, actor: session.actor, expiresAt: new Date(Date.now()+7*86400000).toISOString() }, other: { token: other.token, actor: other.actor }, crew: {}, invoiceIds: {}, source: "controlled fixture only; no actual provider qualification" };
const save = () => writeFile(credentialPath, JSON.stringify(privateData,null,2)+"\n", { mode: 0o600 }); await save();
const signal = () => AbortSignal.timeout(20_000);
try {
  let show = await getShow(session.actor.tenantId); show.title = "Alder Hall · The closing account"; show.crewProtocol = 1; show.tickets = Array.from({length:4},(_,index)=>({id:"QA-TICKET-"+randomUUID(),tier:index<2?"vip" as const:"standard" as const,admissionMinor:3500,perkMinor:index<2?1500:0,captureId:null,source:"sample" as const,refundedMinor:0,status:"reserved" as const})); show.financialEvidence = [];
  const money = (minor: number) => ({ currency_code: "USD", value: (minor/100).toFixed(2) });
  const evidence = (value: Partial<FinancialEvidence>): FinancialEvidence => ({ id: randomUUID(), operationId: randomUUID(), kind: "capture", purpose: "ticket", status: "completed", amountMinor: 5000, currency: "USD", source: "live_sandbox", verified: true, planVersion: show.planVersion, providerResourceId: "CONTROLLED-"+randomUUID(), parentId: null, ticketId: null, recordedAt: new Date().toISOString(), ...value });
  for (const [index,ticket] of show.tickets.entries()) {
    const amount = index < 2 ? 5000 : 3500, captureId = "QA-CAP-"+randomUUID(), orderId = "QA-ORDER-"+randomUUID(), fee = index < 2 ? 150 : 105;
    Object.assign(ticket,{ source:"live_sandbox", status: "captured", captureId, amountMinor: amount, admissionMinor: 3500, perkMinor:index<2?1500:0, tier:index<2?"vip":"standard", refundedMinor:0 });
    show.financialEvidence.push(evidence({providerResourceId:captureId,parentId:orderId,ticketId:ticket.id,amountMinor:amount}));
    wire.orders.set(orderId,{id:orderId,purchase_units:[{payments:{captures:[{id:captureId,status:"COMPLETED",amount:money(amount),seller_receivable_breakdown:{gross_amount:money(amount),paypal_fee:money(fee),net_amount:money(amount-fee)}}]}}]});
    if (index===0) { const refundId="QA-REF-"+randomUUID(); show.financialEvidence.push(evidence({kind:"refund",purpose:"vip_remedy",providerResourceId:refundId,parentId:captureId,ticketId:ticket.id,amountMinor:1500})); ticket.refundedMinor=1500; ticket.status="partially_refunded"; wire.refunds.set(refundId,{id:refundId,status:"COMPLETED",amount:money(1500),seller_payable_breakdown:{gross_amount:money(1500),paypal_fee:money(0),net_amount:money(1500)}}); }
  }
  const authId="QA-AUTH-"+randomUUID(); show.financialEvidence.push(evidence({kind:"authorization",purpose:"rental",providerResourceId:authId,amountMinor:78000}), evidence({purpose:"rental",providerResourceId:"QA-RENT-"+randomUUID(),parentId:authId,amountMinor:48000}), evidence({kind:"void",purpose:"deposit",providerResourceId:authId,parentId:authId,amountMinor:30000}));
  await pool.query("UPDATE on_shows SET snapshot=$2 WHERE tenant_id=$1",[show.tenantId,show]); wire.save();
  const command = async (command: WrapCommand) => { const data=await readWrap(authority); return executeWrap(authority,{idempotencyKey:randomUUID(),expectedRevision:data.revision,expectedShowRevision:data.productionRevision,command}); };
  const entry = async(kind:"baseline_cost"|"baseline_revenue"|"expense"|"revenue",category:"artist"|"venue"|"crew"|"rental"|"sponsorship",label:string,amountMinor:number) => command({type:"save_entry",entry:{entryId:randomUUID(),previousId:null,kind,category,label,amountMinor,currency:"USD",serviceDay:show.showDate,reference:"QA-SOURCE-"+randomUUID(),detail:"Fictional attributed source prepared in this restricted controlled fixture. No actual business agreement or provider transaction is asserted.",sourceIds:[],reviewedScope:true}});
  for (const [category,label,amount] of [["artist","Artist agreement budget",60000],["venue","Venue cost budget",40000],["crew","Crew work budget",10500],["rental","Equipment fee budget",48000]] as const) await entry("baseline_cost",category,label,amount);
  await entry("baseline_revenue","sponsorship","Sponsor revenue estimate",40000);
  for (const [category,label,amount,cash] of [["artist","Artist performance agreement",65000,30000],["venue","Venue staffing and premises",42000,42000]] as const) { const saved=await entry("expense",category,label,amount), original=saved.data.entries.find(e=>e.id===saved.receipt.id)!; await command({type:"report_cash",cashId:randomUUID(),previousId:null,entryId:original.entry.entryId,entryRecordId:original.id,amountMinor:cash,occurredOn:new Date().toISOString().slice(0,10),reference:"QA-EXTERNAL-"+randomUUID(),detail:"Producer-reported fictional external payment. No PayPal receipt is claimed.",reportedOnly:true}); }
  const ownedInvoice = async(label:string,amount:number) => { const saved=await entry("revenue","sponsorship",label,amount), original=saved.data.entries.find(e=>e.id===saved.receipt.id)!, admission=saved.data.admissions[0]!; const prepared=await command({type:"prepare_invoice",entryId:original.entry.entryId,entryRecordId:original.id,admissionId:admission.id,admissionDigest:admission.digest,detail:"Owned controlled sponsor invoice; only its separate exact reviewed operations may dispatch."}); return {id:prepared.receipt.id,entry:original}; };
  const invoiceAction=async(id:string,operation:"create"|"send"|"cancel")=>{ const review=await readInvoiceReview(authority,id,operation); assert.deepEqual(review.review.blockers,[]); const approved=await command({type:"approve_invoice",invoiceId:id,operation,reviewDigest:review.review.digest,detail:"Reviewed exact owned parties, amount, purpose, dates, terms and both notification flags disabled.",reviewedParties:true,reviewedAmount:true,reviewedTerms:true,reviewedDelivery:true}); await runInvoiceJob(show.tenantId,{invoiceId:id,grantId:approved.receipt.id,refreshId:null},signal()); return approved.receipt.id; };
  const collected=await ownedInvoice("Opening sponsor · collected agreement",12000); await invoiceAction(collected.id,"create"); await invoiceAction(collected.id,"send"); const collectedId=(await readWrap(authority)).invoices.find(i=>i.id===collected.id)!.providerId!; wire.collect(collectedId,12000); const read=await command({type:"refresh_invoice",invoiceId:collected.id}); await runInvoiceJob(show.tenantId,{invoiceId:collected.id,grantId:null,refreshId:read.receipt.id},signal());
  const ready=await ownedInvoice("Partner programme · ready for issue",15000); await invoiceAction(ready.id,"create");
  const unknown=await ownedInvoice("Late sponsor · original response unknown",8000); wire.behavior.lostCreate=true; wire.behavior.searchUnavailable=true; await invoiceAction(unknown.id,"create"); wire.behavior.lostCreate=false; wire.behavior.searchUnavailable=false;
  const prepared=await ownedInvoice("After-show programme · local draft",4500);
  privateData.invoiceIds={collected:collected.id,ready:ready.id,unknown:unknown.id,prepared:prepared.id};
  for (const personId of ["priya","tom"]) {
    const token=await createCrewCapability(session.actor,personId), actor=(await getActor(token))!; privateData.crew[personId]={token,actor}; const personal: SettlementAuthority={actor,sessionHash:sessionTokenHash(token),scope:"personal"};
    const settlementCommand=async(command:SettlementCommand)=>{const auth=command.type==="report_time"?personal:authority,data=await readSettlement(auth);return executeSettlement(auth,{idempotencyKey:randomUUID(),expectedRevision:data.revision,expectedShowRevision:data.productionRevision,command});};
    await settlementCommand({type:"approve_rate",personId,previousRateId:null,effectiveFrom:show.showDate,currency:"USD",hourlyMinor:3500,overtimeHourlyMinor:5250,regularMinutes:480,agreement:"Fictional controlled crew rate, individually reviewed for this production.",confirmed:true});
    await settlementCommand({type:"report_time",serviceDay:show.showDate,replacesId:null,sheetVersion:show.sheets.at(-1)!.version,sheetDigest:show.sheets.at(-1)!.digest,intervals:[{start:atVenue("11:30"),end:atVenue("12:30"),unpaidMinutes:0}],detail:"Personally reported fictional preparation work for controlled qualification only.",confirmed:true});
    const settlement=await readSettlement(authority) as ProductionSettlementData, preview=settlement.people.find(p=>p.person.id===personId)!.reports[0]!.preview!;
    await settlementCommand({type:"approve_payable",reportId:preview.reportId,rateId:preview.rateId,reviewDigest:preview.digest,detail:"Reviewed exact fictional hours, current rate and signed liability.",reviewedHours:true,reviewedRate:true,reviewedAdjustment:true});
    const payoutCommand=async(command:PayoutCommand)=>{const data=await readPayouts(authority);return executePayout(authority,{idempotencyKey:randomUUID(),expectedRevision:data.revision,expectedSettlementRevision:data.settlementRevision,expectedShowRevision:data.productionRevision,command});};
    const pd=await readPayouts(authority),admission=pd.admissions.find(a=>a.personId===personId&&a.receiver.startsWith("unclaimed.")===(personId==="tom"))!;
    await payoutCommand({type:"approve_recipient",personId,previousId:null,admissionId:admission.id,admissionDigest:admission.digest,detail:"Exact owned controlled recipient, no actual provider account or funds.",reviewedRecipient:true});
    const review=await readPayoutReview(authority,[personId]); assert.deepEqual(review.review.blockers,[]); const approved=await payoutCommand({type:"approve_payout",personIds:[personId],reviewDigest:review.review.digest,detail:"Exact fictional liability, recipient, credits and separate fees reviewed.",reviewedAmounts:true,reviewedRecipients:true,reviewedCredits:true,reviewedFees:true});
    await runPayoutJob(show.tenantId,"payout_batch",{grantId:approved.receipt.id},signal()); await runPayoutJob(show.tenantId,"payout_batch",{grantId:approved.receipt.id},signal()); const jobs=(await listJobs(show.tenantId)).filter(job=>job.kind==="payout_item"&&job.payload.grantId===approved.receipt.id); for(const job of jobs) await runPayoutJob(show.tenantId,"payout_item",job.payload as {grantId:string;senderItemId:string;batchReadId:string},signal());
  }
  for (const resource of (await readWrap(authority)).toolkit.filter(r=>r.tool!=="get_invoice")) {const data=await readWrap(authority); await executeToolkit(authority,{idempotencyKey:randomUUID(),expectedRevision:data.revision,expectedShowRevision:data.productionRevision,reportDigest:data.report.contentDigest,resourceKey:resource.key,tool:resource.tool});}
  const seal=async(title:string)=>{const data=await readWrap(authority);return sealWrapReport(authority,{idempotencyKey:randomUUID(),expectedRevision:data.revision,expectedShowRevision:data.productionRevision,reportDigest:data.report.contentDigest,title});};
  const first=await seal("Closing account · before sponsor credit"),original=await readSealedReport(authority,first.edition.id,"pdf");
  wire.collect(collectedId,12000,2000);const refundRead=await command({type:"refresh_invoice",invoiceId:collected.id});await runInvoiceJob(show.tenantId,{invoiceId:collected.id,grantId:null,refreshId:refundRead.receipt.id},signal());
  await command({type:"adjust_entry",entryId:collected.entry.entry.entryId,entryRecordId:collected.entry.id,previousAdjustmentId:null,deltaMinor:-2000,reference:"QA-SPONSOR-CREDIT",detail:"Reviewed original sponsor agreement credit; retain the original invoice face, collection and refund.",reviewedOriginal:true});
  const second=await seal("Closing account · sponsor credit reconciled");assert.deepEqual((await readSealedReport(authority,first.edition.id,"pdf")).bytes,original.bytes);
  const data=await readWrap(authority);let analysis=await startWrapAssistant(authority,{requestId:randomUUID(),prompt:"Read the current account and propose what still needs human reconciliation.",reportDigest:data.report.contentDigest,expectedRevision:data.revision,expectedShowRevision:data.productionRevision,lineIds:data.report.lines.filter(l=>l.origin==="entry").slice(0,5).map(l=>l.id)});for(let i=0;i<15&&analysis.canContinue;i++)analysis=await advanceWrapAssistant(authority,analysis.id);assert.equal(analysis.state,"completed");
  privateData.editions=[first.edition,second.edition];privateData.analysisId=analysis.id;privateData.state="ready";privateData.createdAt=new Date().toISOString();await save();
  const final=await readWrap(authority),summary={state:"ready",database:database.database,tenantId:show.tenantId,rows:final.report.lines.length,totals:final.report.totals,invoices:final.invoices.map(i=>({id:i.id,status:i.status,amountMinor:i.amountMinor})),editions:[first.edition,second.edition],controlledOnly:true,bootstrap:"http://127.0.0.1:4538/__wrap_fixture",credentialFile:credentialPath};await writeFile(safePath,JSON.stringify(summary,null,2)+"\n",{mode:0o600}); console.log(JSON.stringify(summary));
} catch(error) {privateData.state="failed";privateData.failure=error instanceof Error?error.message:String(error);await save();throw error;} finally {await closeCommerceLocks();await pool.end();}
