"use client";
import type {EvaluationCorpus,EvaluationReport} from "@/domain/evaluation/contracts";
import {analyseCases} from "@/domain/evaluation/analysis";
import styles from "./evaluation.module.css";
export function CaseAssessment({report,corpus}:{report:EvaluationReport;corpus:EvaluationCorpus}){
  const metrics=analyseCases(corpus,report.cases);
  return <div className={styles.assessment} aria-label="Declared adversarial boundary measurements"><div><span>False feasibility observed</span><strong>{metrics.falseFeasibilityCount}<small>/ {metrics.unsafeCasesTested} declared refusals</small></strong><p>Declared prohibition outcomes only; this is not an estimate for unseen productions.</p></div><div><span>Uncertainty retained</span><strong>{metrics.uncertaintyPreservedCount}<small>/ {metrics.uncertaintyCasesTested} expected unknown or review outcomes</small></strong><p>Unknown availability, evidence and assumptions remain visible.</p></div><div><span>Actual negative approval boundaries</span><strong>{metrics.actualNegativeApprovalBoundariesRejected}<small>/ 3 rejected</small></strong><p>Source freshness, current quote and role refusal. No positive approval was granted.</p></div></div>;
}
