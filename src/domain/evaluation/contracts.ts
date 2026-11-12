/** Public evaluation data contains controlled inputs and computed observations only. */
export type CaseGroup = "single_show" | "tour" | "time" | "readiness";
export type EvaluationState = "pass" | "fail" | "unknown" | "unsupported";
export interface CaseExpectation {
  status: string;
  requiredCodes: string[];
  measurements?: Record<string, string | number | boolean | null>;
  engine?: "passed" | "rejected";
}
export interface CaseContract {
  id: string;
  group: CaseGroup;
  title: string;
  scenario: string;
  expectation: CaseExpectation;
  tags: string[];
}
export interface EvaluationCorpus {
  schemaVersion: 1;
  id: string;
  frozenAt: string;
  sourceCommit: string;
  fixture: string;
  policy: string[];
  cases: CaseContract[];
  stress: { id: string; title: string; repetitions: number; sizes: number[]; resources: number | null; expectation: string }[];
  pending: { id: string; title: string; reason: string }[];
}
export interface EvaluationFinding {
  code: string;
  severity: "hard" | "unknown" | "approval";
  message: string;
  subjects: string[];
}
export interface EngineObservation {
  status: "passed" | "rejected" | "unavailable" | "not_run";
  scope: "product_temporal" | "native_resources";
  version: "8.0.0";
  durationMs: number;
  inputDigest: string | null;
  resultDigest: string | null;
  taskCount: number;
  resourceCount: number;
  assignmentCount: number;
  reason: string | null;
}
export interface CaseObservation {
  id: string;
  state: EvaluationState;
  observedStatus: string;
  findings: EvaluationFinding[];
  measurements: Record<string, string | number | boolean | null>;
  mismatches: string[];
  engine: EngineObservation | null;
  durationMs: number;
  heapDeltaBytes: number;
  inputDigest: string;
  outputDigest: string;
  inputUnchanged: boolean;
  artifact: string;
}
export interface BenchmarkSample {
  repetition: number;
  durationMs: number;
  heapBeforeBytes: number;
  heapAfterBytes: number;
  rssAfterBytes: number;
  inputUnchanged: boolean;
  inputDigest: string;
  resultDigest: string;
  status: string;
  measurements: Record<string, number | string | boolean | null>;
  engine: EngineObservation | null;
}
export interface BenchmarkObservation {
  id: string;
  title: string;
  size: number;
  state: EvaluationState;
  samples: BenchmarkSample[];
  medianMs: number | null;
  p95Ms: number | null;
  peakObservedHeapBytes: number | null;
  reason: string;
  artifact: string;
}
export interface ArtifactLink { path: string; sha256: string; bytes: number; label: string }
export interface PublishedRun {
  runId: string;
  report: ArtifactLink;
  corpus: ArtifactLink;
  sourceManifest: ArtifactLink;
  completedAt: string;
  corpusId: string;
  counts: Record<EvaluationState,number>;
  benchmarkPass: number;
  benchmarkTotal: number;
  note: string;
}
export interface EvidenceIndex {
  schemaVersion: 1;
  title: string;
  currentRunId: string | null;
  runs: PublishedRun[];
}
export interface EvaluationReport {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  completedAt: string;
  sourceCommit: string;
  checkoutCommit?: string;
  checkoutDirty?: boolean;
  applicationBaseMatched?: boolean;
  corpusSha256: string;
  corpusId: string;
  runnerSha256: string;
  sourceManifestSha256: string;
  runtime: { node: string; platform: string; architecture: string; engine: string; repetitions: number; licensed: boolean; networkAttemptsBlocked: number; toolingIpcSuppressed?: number; fixtureClock: string };
  scope: { label: string; operationalCaseCount: number; supportingCaseCount: number; productionWrites: 0; providerCalls: 0; modelCalls: 0; databaseConnections: 0; approvalsGranted: 0 };
  counts: Record<EvaluationState, number>;
  analysis?: ReturnType<typeof import("./analysis").analyseCases>;
  cases: CaseObservation[];
  benchmarks: BenchmarkObservation[];
  pending: EvaluationCorpus["pending"];
  limitations: string[];
  artifacts: ArtifactLink[];
}
