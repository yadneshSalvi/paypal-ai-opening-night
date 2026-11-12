"use client";
import { useState } from "react";
import type { ArtifactLink,CaseGroup,EvaluationState } from "@/domain/evaluation/contracts";
import styles from "./evaluation.module.css";
export const stateLabels:Record<EvaluationState,string>={pass:"Pass",fail:"Fail",unknown:"Unknown",unsupported:"Unsupported"};
export const groupLabels:Record<CaseGroup,string>={single_show:"Single show",tour:"Tour",time:"Time",readiness:"Readiness"};
export const stateMeaning:Record<EvaluationState,string>={pass:"Matched its frozen expectation",fail:"Did not match its frozen expectation",unknown:"No complete observation was retained",unsupported:"A required runtime capability was unavailable"};
export function stamp(value:string){return `${new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"}).format(new Date(value))} UTC`;}
export function amount(value:number|null){return value===null?"Unmeasured":new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(value);}
export function metric(value:string|number|boolean|null){return value===null?"Unknown":typeof value==="boolean"?value?"Yes":"No":typeof value==="number"?amount(value):value;}
export function words(value:string){return value.replace(/([a-z])([A-Z])/g,"$1 $2").replaceAll("_"," ");}
export function Badge({state}:{state:EvaluationState}){return <span className={`${styles.badge} ${styles[state]}`}><i aria-hidden="true"/>{stateLabels[state]}</span>;}
export function Arrow(){return <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M4 10h11M10 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>;}
export function Artifact({artifact,children}:{artifact:ArtifactLink;children?:React.ReactNode}){return <a className={styles.artifact} href={artifact.path} download>{children??artifact.label}<Arrow/></a>;}
export function Hash({value,label}:{value:string;label:string}){
  const[notice,setNotice]=useState("");
  async function copy(){try{await navigator.clipboard.writeText(value);setNotice(`${label} copied.`);}catch{setNotice("Copy is unavailable. Select the displayed hash to copy it.");}}
  return <div className={styles.hashBlock}><div><span>{label}</span><button type="button" onClick={copy} aria-label={`Copy ${label}`}>Copy</button></div><code>{value}</code><span className={styles.srOnly} role="status">{notice}</span></div>;
}
