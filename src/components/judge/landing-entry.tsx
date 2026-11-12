"use client";
import { useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "../ui";
import { announceRehearsal } from "../production-fetch";
import { TOUR_DESCRIPTION, errorText, postJudge } from "./judge-client";

const fullLoad = (url: string) => location.assign(url);

/** Landing calls to action: the guided tour first, the blank live-sandbox rehearsal second. */
export function JudgeLandingEntry({ onBlank, blankBusy, navigate = fullLoad }: { onBlank: () => void; blankBusy: boolean; navigate?: (url: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), lock = useRef(false);
  const start = async () => {
    if (lock.current || blankBusy) return; lock.current = true; setBusy(true); setError(null);
    try {
      const view = await postJudge(null, { action: "start" });
      if (view.tenantId) announceRehearsal(view.tenantId);
      // The session cookie is new: a full load lets the server render the guided console.
      navigate("/");
    } catch (reason) { setError(errorText(reason, "The guided tour could not start.")); setBusy(false); lock.current = false; }
  };
  return <div className="judge-landing">
    <Button variant="primary" busy={busy} disabled={blankBusy} onClick={() => void start()}>Start the guided tour <ArrowRight size={18} /></Button>
    <p className="judge-landing-note">{TOUR_DESCRIPTION}</p>
    {error && <p className="judge-landing-error" role="alert">{error} You can try again.</p>}
    <div className="judge-landing-blank">
      <Button busy={blankBusy} disabled={busy} onClick={onBlank}>Open the blank Alder Hall rehearsal <ArrowRight size={15} /></Button>
      <p>Live sandbox, no guide. It starts with nothing done, and its payment steps are actual PayPal sandbox requests that need your own sandbox buyer login.</p>
    </div>
  </div>;
}

const cues = [
  { cue: "STANDBY", line: "A delayed headliner and a failed lighting console cascade through the schedule, in venue and departure time." },
  { cue: "OPTIONS", line: "The engine generates rescue plans and rejects the impossible ones. You compare the named plans that remain." },
  { cue: "COMMIT", line: "Approval, supplier hold, delivery and refunds move the timeline. Payment outcomes in the tour are replayed and labeled." },
  { cue: "GO", line: "Readiness fills gate by gate, you acknowledge a run sheet from your own phone, and you press GO yourself." },
];
export function JudgeLandingStrip() {
  return <section className="judge-strip" aria-labelledby="judge-strip-title">
    <h2 id="judge-strip-title" className="eyebrow">What you will see</h2>
    <ol>{cues.map((item, index) => <li key={item.cue}><span className="judge-strip-number" aria-hidden="true">{`0${index + 1}`}</span><strong>{item.cue}</strong><p>{item.line}</p></li>)}</ol>
  </section>;
}
