import type { Candidate, ShowSnapshot } from '@/domain/contracts';

export function candidateTermsCurrent(show: ShowSnapshot, candidate: Candidate, now: number): boolean {
  const offer=show.offers.find(value=>value.id===candidate.patch.offerId);
  if(!offer || offer.revision!==candidate.patch.offerRevision || offer.serviceQuote?.reviewRequired || offer.status==='expired' || Date.parse(offer.expiresAt)<=Date.parse(show.clock)) return false;
  if(offer.serviceQuote && Date.parse(offer.serviceQuote.validUntil)<=now) return false;
  const source=show.supplierTermRevisions?.find(value=>value.supplierId===offer.supplierId);
  return !(source && offer.serviceQuote?.termsSource?.id!==source.id) && !(show.supplierDisruptions??[]).some(value=>Date.parse(value.recordedAt)>Date.parse(candidate.generatedAt));
}

/** Compare one real representative per family. A newly admitted supplier can lead every family. */
export function recoveryHeadlines(show: ShowSnapshot, candidates: Candidate[], now: number): Candidate[] {
  const rank=(value:Candidate)=>!candidateTermsCurrent(show,value,now)?4:value.report.engine?.status!=='passed'?3:['feasible','feasible_with_approval'].includes(value.report.status)?0:value.report.status==='unknown_pending_evidence'?1:2;
  const order=['doors','budget','artist','direct'];
  const groups=new Map<string,Candidate[]>();
  for(const candidate of candidates){const key=candidate.strategy?.kind??candidate.family;groups.set(key,[...(groups.get(key)??[]),candidate]);}
  const representatives=[...groups.entries()].map(([key,rows])=>({key,candidate:[...rows].sort((a,b)=>rank(a)-rank(b)||a.cost.totalMinor-b.cost.totalMinor||a.id.localeCompare(b.id))[0]!}));
  representatives.sort((a,b)=>rank(a.candidate)-rank(b.candidate)||((order.indexOf(a.key)+1||10)-(order.indexOf(b.key)+1||10))||a.candidate.cost.totalMinor-b.candidate.cost.totalMinor);
  const selected=representatives.slice(0,3).map(value=>value.candidate);
  // Keep an intelligible rejected family in the headline comparison when it exists.
  const diagnostic=representatives.find(value=>value.candidate.report.status==='infeasible'&&candidateTermsCurrent(show,value.candidate,now));
  if(selected.length===3 && diagnostic && !selected.some(value=>value.report.status==='infeasible')) selected[2]=diagnostic.candidate;
  return selected;
}
