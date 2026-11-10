"use client";
export default function ErrorPage({ reset }: { reset: () => void }) { return <main className="fatal-error" id="main"><span className="eyebrow">OPENING NIGHT / SERVICE PAUSED</span><h1>Hold, please.</h1><p>The production service could not load. Confirmed actions are preserved.</p><button className="button primary" onClick={reset}>Try again</button></main>; }
