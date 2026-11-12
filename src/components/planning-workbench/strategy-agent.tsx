"use client";
import type { Candidate } from "@/domain/contracts";
import type { WorkbenchCommand, WorkbenchWorkspace } from "@/domain/planning-workbench/contracts";
import type { StrategyGeneration } from "@/domain/planning-workbench/model-strategies";
import { candidateOutcome, candidateProvenance, strategyFunnels, type CandidateOutcome } from "@/domain/planning-workbench/funnel";

const day = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(new Date(value)) + " UTC";
/** The one place the three provenance labels are worded. A recorded response is never shown as a live one. */
export function provenanceLabel(provenance: "deterministic" | "model" | "recorded_model", source?: { model: string | null; recordedAt: string | null }) {
  return provenance === "deterministic" ? "DETERMINISTIC" : provenance === "model" ? `MODEL${source?.model ? ` · ${source.model}` : ""}` : `RECORDED MODEL OUTPUT (recorded ${source?.recordedAt ? day(source.recordedAt) : "date unavailable"}, model ${source?.model ?? "unavailable"})`;
}
export function ProvenanceBadge({ provenance, source }: { provenance: "deterministic" | "model" | "recorded_model"; source?: { model: string | null; recordedAt: string | null } }) {
  return <span className={`planning-lab-provenance ${provenance}`}>{provenanceLabel(provenance, source)}</span>;
}
/** People are sent to the model as aliases (P1, P2…). Names are filled in here, in the browser, from the current roster. */
export const withRosterNames = (text: string, people: WorkbenchWorkspace["people"]) => text.replace(/\bP(\d{1,2})\b/g, (alias, index: string) => people[Number(index) - 1]?.name ?? alias);
const outcomes: Record<CandidateOutcome, string> = { schema_rejected: "Rejected · typed contract", temporal_rejected: "Rejected · schedule engine or timing rule", semantic_rejected: "Rejected · production rule", evidence_pending: "Unresolved · evidence or authority still unknown", approvable: "Could go forward · separate producer decision required" };

export function StrategyAgentPanel({ view, locked, waiting, send }: { view: WorkbenchWorkspace; locked: boolean; waiting: boolean; send: (command: WorkbenchCommand) => Promise<void> }) {
  const agent = view.modelAgent;
  if (!agent) return null;
  const { live, recorded } = agent;
  return <section className="planning-lab-agent" aria-labelledby="planning-agent-title">
    <div className="planning-lab-intro"><span className="planning-lab-number" aria-hidden="true">AI</span><div><h2 id="planning-agent-title">Ask the strategy agent.</h2><p>A model proposes parameters inside the same six typed families, each with one sentence of rationale and the priority it protects. It cannot approve, schedule, price or invent a supplier, person or skill. Every proposal is rebuilt and checked here by the same scheduling engine and production rules as the deterministic families, and rejected or unresolved proposals stay visible with their reasons.</p></div></div>
    <div className="planning-lab-agent-actions">
      <button type="button" className="planning-lab-primary" disabled={locked || !live.available} onClick={() => void send({ type: "strategies.propose", mode: "live", count: 6 })}>Propose with the model</button>
      <button type="button" disabled={locked || !recorded.available} onClick={() => void send({ type: "strategies.propose", mode: "recorded", count: 6 })}>Load recorded model output</button>
    </div>
    {waiting && <p role="status" className="planning-lab-agent-wait">Waiting for the model, then validating each proposal with the scheduling engine. This can take up to a minute; nothing is approved.</p>}
    <dl className="planning-lab-agent-facts">
      <dt>Live model</dt><dd>{live.available ? <>Connected{live.model ? ` · ${live.model}` : ""} · {live.used} of {live.limit} live runs used in this production.</> : <>{live.reason ?? "Unavailable."} {recorded.available ? "The recorded model output and the deterministic families remain available." : "The deterministic families remain available."}</>}</dd>
      <dt>Recorded output</dt><dd>{recorded.available ? <><ProvenanceBadge provenance="recorded_model" source={recorded} /> {recorded.candidates} proposals from one earlier real model response for the sample incident. Loading it calls no model; validation runs live against this production.</> : "No recorded model output is available in this build."}</dd>
      <dt>What is sent</dt><dd>Times, limits, offer amounts, task identifiers and skills. People are sent as aliases; names, incident reports, supplier terms, tickets and payments are not sent.</dd>
    </dl>
    {agent.demonstration && <p className="planning-lab-fine">Guided demonstration: either mode may be used. A recorded response keeps its recorded label.</p>}
  </section>;
}

export function GenerationSummary({ generation, candidates }: { generation: StrategyGeneration; candidates: Candidate[] }) {
  const funnel = strategyFunnels([{ candidates, generation }])[generation.provenance], source = { model: generation.model, recordedAt: generation.recordedAt };
  const steps: [string, number][] = [["proposed by the model", funnel.generated], ["passed the typed contract", funnel.schemaValid], ["passed engine and timing", funnel.temporallyValid], ["passed production rules", funnel.semanticEvidenceValid], ["could go forward", funnel.approvable]];
  return <div className="planning-lab-generation">
    <p><ProvenanceBadge provenance={generation.provenance} source={source} /> {generation.mode === "recorded" ? "Generation was recorded earlier; every check below ran live in this production." : "Generated by a live model request from this production; every check below ran here."}</p>
    {generation.failure && <p role="status" className="planning-lab-notice"><b>{generation.failure.code.replaceAll("_", " ")}</b> · {generation.failure.message} The deterministic families remain available; nothing was substituted for the model&rsquo;s answer.</p>}
    <ol className="planning-lab-funnel" aria-label="Validation funnel computed from the retained attempts">{steps.map(([label, value]) => <li key={label}><b>{value}</b><span>{label}</span></li>)}</ol>
    {funnel.evidencePending > 0 && <p className="planning-lab-fine">{funnel.evidencePending} unresolved: evidence or authority is still unknown, so it cannot be approved.</p>}
    {funnel.rejections.length > 0 && <details><summary>Rejections by rule · {funnel.rejections.reduce((sum, row) => sum + row.count, 0)}</summary><ul>{funnel.rejections.map(row => <li key={row.stage + row.code}><b>{row.code}</b> · {row.stage} · {row.count}</li>)}</ul></details>}
    {generation.schemaRejected.length > 0 && <details open><summary>Proposals rejected before a plan could be built · {generation.schemaRejected.length}</summary><ul>{generation.schemaRejected.map(row => <li key={row.index}><b>{row.code}</b> · proposal {row.index + 1}{row.claimed.kind ? ` · claimed family “${row.claimed.kind}”` : ""}{row.claimed.offerId ? ` · claimed offer “${row.claimed.offerId}”` : ""}<br />{row.message}</li>)}</ul></details>}
    <details className="planning-lab-proof"><summary>Model run identity</summary><dl><dt>Model</dt><dd>{generation.model ?? "not recorded"}</dd><dt>{generation.mode === "recorded" ? "Recorded" : "Generated"}</dt><dd>{generation.recordedAt ?? generation.generatedAt}</dd><dt>Validated here</dt><dd>{generation.generatedAt}</dd><dt>Response</dt><dd>{generation.responseId ?? "no response identity"}</dd><dt>Output digest</dt><dd>{generation.outputDigest ?? "no output"}</dd><dt>Input digest</dt><dd>{generation.inputDigest}</dd><dt>Prompt</dt><dd>{generation.promptVersion}</dd></dl></details>
  </div>;
}

export function CandidateOrigin({ candidate, people }: { candidate: Candidate; people: WorkbenchWorkspace["people"] }) {
  const generator = candidate.strategy?.generator, outcome = candidateOutcome(candidate);
  return <>
    <p><ProvenanceBadge provenance={candidateProvenance(candidate)} {...(generator ? { source: { model: generator.model, recordedAt: generator.recordedAt } } : {})} /> <span className={`planning-lab-outcome ${outcome}`}>{outcomes[outcome]}</span></p>
    {generator && <div className="planning-lab-rationale"><p><b>Protects {generator.protects}.</b> <q>{withRosterNames(generator.rationale, people)}</q></p><p className="planning-lab-fine">The model&rsquo;s own wording, shown as commentary. It decided nothing.</p>{generator.assumptions.length > 0 ? <><p><b>Assumptions the model stated · not verified</b></p><ul>{generator.assumptions.map((item, index) => <li key={index}>{withRosterNames(item, people)}</li>)}</ul></> : <p className="planning-lab-fine">The model stated no assumptions.</p>}</div>}
  </>;
}
