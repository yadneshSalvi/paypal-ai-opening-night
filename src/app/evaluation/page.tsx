import type { Metadata } from "next";
import type { EvidenceIndex } from "@/domain/evaluation/contracts";
import { EvidenceViewer } from "@/components/evaluation/evidence-viewer";
import evidenceIndex from "../../../public/evaluation/index.json";
export const metadata:Metadata={title:"The Rehearsal Ledger · Opening Night",description:"Frozen controlled scenarios,actual planner and Bryntum measurements,retained failures and explicit qualification limits."};
export const dynamic="force-static";
/** A report-only page. It does not create or open a production/session/database. */
export default function EvaluationPage(){return <EvidenceViewer index={evidenceIndex as EvidenceIndex}/>;}
