import type { CaseObservation,EvaluationCorpus } from "./contracts";
/** Counts in the declared adversarial corpus,not accuracy estimates for unseen productions. */
export function analyseCases(corpus:EvaluationCorpus,observations:CaseObservation[]){
  const observed=new Map(observations.map(item=>[item.id,item]));
  const operational=corpus.cases.filter(item=>["single_show","tour"].includes(item.group)&&observed.has(item.id));
  const unsafe=operational.filter(item=>["infeasible","rejected","no_approvable"].includes(item.expectation.status));
  const uncertain=operational.filter(item=>["unknown","unknown_pending_evidence","needs_review"].includes(item.expectation.status));
  const eligible=new Set(["feasible","feasible_with_approval","approvable","ready","accepted","unexpected_acceptance"]);
  const falselyEligible=unsafe.filter(item=>eligible.has(observed.get(item.id)!.observedStatus)).map(item=>item.id);
  const uncertaintyPreserved=uncertain.filter(item=>item.expectation.status===observed.get(item.id)!.observedStatus).map(item=>item.id);
  const approvalBoundaries=["S31","S32","S33"].filter(id=>observed.get(id)?.observedStatus==="rejected");
  return {operationalCasesObserved:operational.length,unsafeCasesTested:unsafe.length,falseFeasibilityCount:falselyEligible.length,falseFeasibilityCaseIds:falselyEligible,uncertaintyCasesTested:uncertain.length,uncertaintyPreservedCount:uncertaintyPreserved.length,uncertaintyPreservedCaseIds:uncertaintyPreserved,actualNegativeApprovalBoundariesRejected:approvalBoundaries.length,manualBaselineMs:null,humanInterventions:null,providerCompletionRate:null,reconciliationAgeMs:null};
}
