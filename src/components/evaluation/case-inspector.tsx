"use client";
import { useEffect,useState } from "react";
import type { CaseContract,CaseObservation } from "@/domain/evaluation/contracts";
import { Arrow,Badge,Hash,amount,groupLabels,metric,stateMeaning,words } from "./evidence-shared";
import styles from "./evaluation.module.css";
export function CaseInspector({contract,observation,base,onPrevious,onNext,hasPrevious,hasNext,outsideFilter,headingRef}:{contract:CaseContract;observation:CaseObservation;base:string;onPrevious:()=>void;onNext:()=>void;hasPrevious:boolean;hasNext:boolean;outsideFilter:boolean;headingRef:React.RefObject<HTMLHeadingElement|null>}){
  const[expanded,setExpanded]=useState(false);
  useEffect(()=>setExpanded(false),[contract.id]);
  const findings=expanded?observation.findings:observation.findings.slice(0,5);
  return <aside className={styles.inspector} aria-labelledby="case-inspector-title">
    <div className={styles.inspectorTop}><span className={styles.eyebrow}>{contract.id} / {groupLabels[contract.group]}</span><Badge state={observation.state}/></div>
    <h3 id="case-inspector-title" ref={headingRef} tabIndex={-1}>{contract.title}</h3>
    {outsideFilter&&<p className={styles.filteredNotice}>This selected case is outside the current filters. Select another case or clear the filters.</p>}
    <p className={styles.meaning}>{stateMeaning[observation.state]}. {observation.state==="pass"&&["infeasible","rejected","blocked","no_approvable"].includes(observation.observedStatus)?"This pass records a refusal, not a feasible or approved plan.":observation.state==="pass"&&["unknown","unknown_pending_evidence","needs_review"].includes(observation.observedStatus)?"The expected uncertainty or review requirement remains unresolved.":"A computed proposal grants no operational approval."}</p>
    <dl className={styles.comparison}><div><dt>Declared outcome</dt><dd>{words(contract.expectation.status)}</dd></div><div><dt>Observed outcome</dt><dd>{words(observation.observedStatus)}</dd></div></dl>
    {observation.mismatches.length>0&&<div className={styles.failureBox}><strong>Retained mismatch</strong><ul>{observation.mismatches.map((message,index)=><li key={index}>{message}</li>)}</ul></div>}
    <div className={styles.inspectorSection}><h4>Constraint evidence <span>{observation.findings.length}</span></h4>{findings.length?<ul className={styles.findings}>{findings.map((finding,index)=><li key={`${finding.code}-${index}`}><div><code>{finding.code}</code><span>{finding.severity==="approval"?"Review required":finding.severity}</span></div><p>{finding.message}</p></li>)}</ul>:<p className={styles.smallNote}>No domain finding was emitted. Required engine proof and explicit approvals remain separate.</p>}{observation.findings.length>5&&<button type="button" className={styles.textButton} onClick={()=>setExpanded(value=>!value)}>{expanded?"Show first five findings":`Show all ${observation.findings.length} findings`}</button>}</div>
    {observation.engine&&<div className={styles.engineProof}><span className={styles.eyebrow}>Actual engine observation</span><strong>{observation.engine.status.toUpperCase()} <span>/ Bryntum 8.0.0</span></strong><p>{observation.engine.taskCount} tasks · {amount(observation.engine.durationMs)} ms</p><p className={styles.smallNote}>The product adapter commits task dates and dependencies. Resource capacity, skills, travel and rest are checked separately by domain policy.</p></div>}
    <details className={styles.details}><summary>Measurements and immutable hashes</summary><dl className={styles.measurements}>{Object.entries(observation.measurements).map(([name,value])=><div key={name}><dt>{words(name)}</dt><dd>{metric(value)}</dd></div>)}<div><dt>Retained input unchanged</dt><dd>{observation.inputUnchanged?"Yes":"No · failed"}</dd></div><div><dt>Case elapsed</dt><dd>{amount(observation.durationMs)} ms</dd></div></dl><Hash label="Input semantic SHA-256" value={observation.inputDigest}/><Hash label="Output semantic SHA-256" value={observation.outputDigest}/></details>
    <a className={styles.inspectorDownload} href={`${base}${observation.artifact}`} download>Exact input and recorded result <Arrow/></a>
    <div className={styles.inspectorNav}><button type="button" disabled={!hasPrevious} onClick={onPrevious}>← Previous case</button><button type="button" disabled={!hasNext} onClick={onNext}>Next case →</button></div>
  </aside>;
}
