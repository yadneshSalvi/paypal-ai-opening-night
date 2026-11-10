"use client";
import { useState } from "react";
import { ArrowUpRight, Radio, X } from "lucide-react";
import Link from "next/link";
export function StageMap({ disrupted = false, cleared = false, compact = false }: { disrupted?: boolean; cleared?: boolean; compact?: boolean }) {
  const [selected, setSelected] = useState(false);
  return <div className={`stage-map ${compact ? "compact" : ""}`}>
    <div className="stage-map-top"><span><span className="live-square" /> ALDER HALL <span className="faint">/ STAGE 01</span></span><span className="mono">ILLUSTRATIVE PLAN VIEW</span></div>
    <svg viewBox="0 0 900 430" role="img" aria-label={`Alder Hall stage schematic. ${disrupted ? "The lighting console is affected by a self-test failure." : "Controlled show baseline."}`}>
      <defs><pattern id="stage-grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M 36 0 L 0 0 0 36" fill="none" stroke="#aaaaaa" strokeWidth=".4" opacity=".1" /></pattern><linearGradient id="stage-floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#292620" /><stop offset="100%" stopColor="#141516" /></linearGradient><linearGradient id="stage-beam"><stop offset="0" stopColor={cleared ? "#ffb000" : "#c9c0a3"} stopOpacity=".03" /><stop offset=".5" stopColor={cleared ? "#ffb000" : "#c9c0a3"} stopOpacity={cleared ? ".17" : ".045"} /><stop offset="1" stopColor="#b5a386" stopOpacity=".01" /></linearGradient><radialGradient id="console-glow"><stop offset="0" stopColor="#ffb000" stopOpacity=".18" /><stop offset="1" stopColor="#ffb000" stopOpacity="0" /></radialGradient></defs>
      <rect width="900" height="430" fill="url(#stage-grid)" />
      <path d="M155 58H745V301H155Z" fill="none" stroke="#353638" strokeWidth="2" /><rect x="168" y="70" width="564" height="211" fill="url(#stage-floor)" stroke="#4c493f" />
      <path d="M168 281H732L764 310H136Z" fill="#1e1f1f" stroke="#4c493f" /><path d="M136 310H764V322H136Z" fill="#101112" stroke="#3c3d3d" />
      <path d="M168 70L245 281H388L206 70Z M420 70L334 281H569L472 70Z M700 70L524 281H666L735 70Z" fill="url(#stage-beam)" />
      <g stroke="#65615a" strokeWidth="1" fill="#1c1d1d"><path d="M179 57H721M179 45H721" />{[200,270,340,410,480,550,620,690].map(x => <g key={x}><path d={`M${x-15} 45L${x+15} 57M${x-15} 57L${x+15} 45`} /><rect x={x-7} y="58" width="14" height="11" rx="2" /><path d={`M${x-5} 69L${x-8} 78H${x+8}L${x+5} 69`} /></g>)}</g>
      <text x="450" y="148" textAnchor="middle" className="stage-title">THE NIGHT</text><text x="450" y="202" textAnchor="middle" className="stage-title">FERRIES</text><text x="450" y="226" textAnchor="middle" className="stage-subtitle">SATURDAY / NOVEMBER 14</text>
      <g fill="#292c2d" stroke="#656764" strokeWidth="1"><rect x="195" y="202" width="39" height="64" rx="2" /><rect x="667" y="202" width="39" height="64" rx="2" /><rect x="375" y="250" width="150" height="19" /><circle cx="447" cy="250" r="21" /><circle cx="420" cy="241" r="13" /><circle cx="476" cy="239" r="13" /><path d="M315 226V275M303 275H327M585 226V275M573 275H597" /><circle cx="315" cy="226" r="4" /><circle cx="585" cy="226" r="4" /></g>
      <path d="M244 350Q450 389 656 350M226 368Q450 410 674 368M208 386Q450 430 692 386" fill="none" stroke="#393b3b" strokeWidth="1" strokeDasharray="3 13" />
      <g fill="#9a9991" className="stage-annotations"><text x="116" y="183" transform="rotate(-90 116 183)">STAGE RIGHT</text><text x="792" y="183" transform="rotate(90 792 183)">STAGE LEFT</text><text x="46" y="355">FOH</text><text x="745" y="353">BACKSTAGE</text></g>
      <path d="M101 345H163V386H101Z" fill="#252628" stroke={disrupted ? "#ffb000" : "#666760"} /><path d="M108 353H156M109 359V378M119 359V378M129 359V378M139 359V378M149 359V378" stroke="#77776c" strokeWidth="2" />
      <path d="M733 126H800V260H733" fill="none" stroke="#444641" strokeDasharray="4 4" /><text x="767" y="182" textAnchor="middle" className="stage-small">QUIET</text><text x="767" y="199" textAnchor="middle" className="stage-small">PREP</text>
      {disrupted && <circle cx="133" cy="365" r="76" fill="url(#console-glow)" />}
      <path d="M814 34V68M808 42L814 34L820 42" stroke="#66685e" fill="none" /><text x="814" y="25" textAnchor="middle" className="stage-small">N</text>
    </svg>
    <button className={`stage-pin ${disrupted ? "affected" : ""}`} aria-label="Inspect lighting console" onClick={() => setSelected(!selected)}><Radio size={15} /><span>LX CONSOLE</span>{disrupted && <i />}</button>
    <div className="stage-map-bottom"><span><span className={`tiny-dot ${cleared ? "green" : "amber"}`} />{cleared ? "Department sign-off recorded" : disrupted ? "1 affected equipment node" : "Controlled production schematic"}</span><span className="faint">Tap a node to inspect</span></div>
    {selected && <div className="stage-inspector"><button className="icon-button" aria-label="Close console inspector" onClick={() => setSelected(false)}><X size={15} /></button><span className="eyebrow">LIGHTING / LX-01</span><h3>Lighting console</h3><p>{disrupted ? "Failed self-test. Focus and cue programming need a verified compatible replacement." : "The desk anchors focus, programming, and the technical readiness chain."}</p><Link href="/recovery">Review dependencies <ArrowUpRight size={14} /></Link></div>}
  </div>;
}
