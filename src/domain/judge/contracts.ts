/**
 * Guided judge demonstration contract shared by the server director
 * (`src/server/judge`) and the guide overlay (`src/components/judge`).
 *
 * A guided demonstration is an ordinary, privately scoped rehearsal whose
 * payment-provider outcomes are REPLAYED controlled outcomes. Nothing in a
 * guided demonstration is an actual PayPal transaction, and every surface
 * that shows one must say so. Readiness and GO rules are unchanged.
 */
export const JUDGE_BEAT_IDS = ["standby", "options", "assistant", "commit", "delivery", "crew", "go", "headliner", "wrap"] as const;
export type JudgeBeatId = typeof JUDGE_BEAT_IDS[number];

/** Where a step's evidence came from. Shown verbatim as a compact badge. */
export type JudgeProvenance =
  | "live"        // computed or executed now by the application/engine/model
  | "replay"      // controlled payment outcome; no PayPal request was made
  | "controlled"  // controlled fixture client or declaration, not a real person or physical act
  | "judge";      // performed by the person viewing the demonstration

export interface JudgeStep { id: string; label: string; done: boolean; provenance: JudgeProvenance; detail?: string }

export interface JudgeBeat {
  id: JudgeBeatId;
  /** Film cue name, e.g. "STANDBY". */
  cue: string;
  title: string;
  /** One or two plain sentences: what the judge is about to see and why it matters. */
  summary: string;
  /** Scenario (fixture) clock label for this beat, e.g. "15:10 CST". */
  scenarioTime: string;
  /** The production view that best shows this beat's result. */
  href: string;
  status: "done" | "current" | "upcoming";
  steps: JudgeStep[];
  /** True when POST advance for this beat would do work now. */
  canAdvance: boolean;
  /** Label for the advance button, e.g. "Run the cascade". */
  advanceLabel: string;
  /** Set when the beat waits for the judge (phone acknowledgment, GO, HOUSE OPEN). */
  waitingOn?: string;
}

/** A crew capability the judge can open to perform a genuine acknowledgment in their own session. */
export interface JudgeCrewLink {
  personId: string; personName: string; role: string;
  /** Absolute URL of the scoped crew client. Single person, single rehearsal. */
  url: string;
  /** SVG markup of the QR code for `url`. */
  qrSvg: string;
  expiresAt: string;
  acknowledged: boolean;
  kind: "judge_phone" | "controlled_device";
}

export interface JudgeView {
  version: 1;
  /** False for ordinary rehearsals; the overlay then offers to start a demonstration. */
  active: boolean;
  tenantId: string | null;
  revision: number | null;
  /** Fixed sentence shown wherever replayed money appears. */
  paymentNotice: string;
  beats: JudgeBeat[];
  currentBeatId: JudgeBeatId | null;
  /** Present from the crew beat onward. */
  crewLinks: JudgeCrewLink[];
  acknowledged: { current: number; required: number } | null;
  /** When this demonstration's own producer access ends. A new one can always be started. */
  accessExpiresAt: string | null;
  /** Additive: true while a server step of this demonstration is still running (another advance would be refused with DEMONSTRATION_BUSY). */
  busy?: boolean;
  serverAt: string;
}

export type JudgeRequest =
  | { action: "start" }
  | { action: "advance"; beatId: JudgeBeatId; idempotencyKey: string }
  | { action: "reset" };

/** Stored on the show snapshot of a guided demonstration. Written once, when the rehearsal is created. */
export interface DemonstrationMarker { mode: "replay"; startedAt: string }
export const JUDGE_PAYMENT_NOTICE = "GUIDED DEMONSTRATION - payment outcomes are replayed; no PayPal request is made.";
export const isDemonstration = (show: { demonstration?: DemonstrationMarker } | null | undefined): boolean => show?.demonstration?.mode === "replay";

/**
 * POST /api/judge/verify. A read-only observation of a small fixed sample of
 * this deployment's RETAINED original sandbox captures and refunds. It is not
 * part of any demonstration, and identifiers are always redacted.
 */
export const JUDGE_LIVE_READ_LABEL = "Live read of retained sandbox evidence - not part of this demonstration";
export interface JudgeLiveReadItem {
  kind: "capture" | "refund";
  /** Redacted provider identifier, e.g. "••••7K2P9A". */
  reference: string;
  /** Status PayPal returned for this resource in this read, or null when the read failed. */
  status: string | null;
  amountMinor: number | null; currency: string | null;
  /** When this deployment originally recorded the receipt. */
  recordedAt: string;
  /** True when PayPal returned the same resource and amount as the retained record. */
  matchesRetainedRecord: boolean;
}
export interface JudgeLiveRead {
  version: 1; label: typeof JUDGE_LIVE_READ_LABEL;
  /** "verified": PayPal answered for every sampled resource. "partial": some reads failed. "unavailable": nothing could be read; see `reason`. */
  status: "verified" | "partial" | "unavailable";
  reason?: string;
  /** When the provider was read. The result is shared by all visitors until `nextReadAfter`. */
  readAt: string | null; nextReadAfter: string | null; cached: boolean;
  items: JudgeLiveReadItem[];
}
