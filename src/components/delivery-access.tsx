"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, ClipboardCheck, PackageCheck, QrCode, RefreshCw, ShieldCheck, Truck, TriangleAlert } from "lucide-react";
import type { DeliveryAccessData } from "@/domain/supplier-contracts";
import { formatMoney, localTime } from "@/domain/time";
import { Badge, Button } from "./ui";
import { QrReader } from "./qr-reader";

function handoffToken(value: string) {
  const text = value.trim(); if (!text) return "";
  if (!text.startsWith("http://") && !text.startsWith("https://")) return text;
  try { const url = new URL(text); return new URLSearchParams(url.hash.slice(1)).get("handoff") ?? ""; } catch { return ""; }
}
export function DeliveryAccess() {
  const [token, setToken] = useState(""); const [executionId, setExecutionId] = useState(""); const [data, setData] = useState<DeliveryAccessData | null>(null);
  const [handoff, setHandoff] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState("");
  const [condition, setCondition] = useState({ report: "", powerOn: false, accessories: false, safeCondition: false }); const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams(location.search); const fragment = new URLSearchParams(location.hash.slice(1)); const id = query.get("execution") ?? "";
    const access = fragment.get("access") || sessionStorage.getItem("opening-night-delivery:" + id) || "";
    if (fragment.get("access")) sessionStorage.setItem("opening-night-delivery:" + id, access);
    if (fragment.get("handoff")) setHandoff(fragment.get("handoff")!);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    setToken(access); setExecutionId(id);
    if (!access) setError("Open the producer's private driver or lighting-lead link on this device first. A handoff code does not grant a role.");
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!token || !executionId) return;
    const response = await fetch(`/api/deliveries/${executionId}`, { headers: { Authorization: "Bearer " + token }, cache: "no-store", ...(signal ? { signal } : {}) }); const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "This handoff could not be loaded."); setData(body); setError(null);
  }, [token, executionId]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); }); return () => controller.abort(); }, [refresh]);
  useEffect(() => { if (!data || !["confirmed", "delivered", "accepted"].includes(data.execution.state)) return; const controller = new AbortController(); const timer = setInterval(() => { void refresh(controller.signal).catch(() => undefined); }, 12000); return () => { clearInterval(timer); controller.abort(); }; }, [refresh, data?.execution.state]);
  const post = async (path: string, body: unknown, message: string) => {
    if (busy) return; setBusy(true); setError(null); setNotice("");
    try { const response = await fetch(path, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "This handoff step could not be recorded."); setData(payload); setHandoff(""); setConfirmed(false); setNotice(message); }
    catch (error) { setError(error instanceof Error ? error.message : "This handoff step could not be recorded."); void refresh().catch(() => undefined); }
    finally { setBusy(false); }
  };
  const accept = (decision: "accept" | "reject") => {
    if (!data?.delivery) return;
    void post(`/api/deliveries/${executionId}/accept`, { idempotencyKey: crypto.randomUUID(), expectedRevision: data.revision, deliveryId: data.delivery.id, version: data.delivery.version, decision, confirmInspection: true, condition }, decision === "accept" ? "Condition accepted. The producer-approved fee is queued; provider confirmation remains separate." : "Condition rejected. The production has a recorded blocker; no fee instruction was created.");
  };
  return <div className="crew-mobile delivery-mobile"><header><span className="crew-wordmark">OPENING NIGHT<span>.</span></span><Badge tone="blue">CONTROLLED HANDOFF</Badge></header><main id="main">
    <div className="crew-person-heading"><span className="eyebrow">THE LAST METERS MATTER</span><h1>{data?.actor.canInspect ? "Check the desk. Own the sign-off." : "Bring the right console home."}</h1><p>{data?.actor.label ?? "Opening your assigned delivery client…"}</p></div>
    {error && <div className="notification error" role="alert">{error}</div>}{notice && <div className="notification" role="status">{notice}</div>}
    {data && <><div className="crew-show"><div><span>{data.venue.toUpperCase()} · PLAN v{data.execution.planVersion}</span><h2>{data.execution.unitId}</h2></div><Badge tone={data.feeCaptured ? "green" : "amber"}>{data.feeCaptured ? "FEE VERIFIED" : data.execution.state.replaceAll("_", " ").toUpperCase()}</Badge></div>
      <div className="delivery-context"><span><Truck size={15} />Delivery {localTime(data.execution.deliveryAt)} CST</span><span>Scenario {localTime(data.clock)} CST</span><span>{data.authorizationVerified ? "Original authorization verified" : "Authorization needs review"}</span></div>
      <ol className="handoff-steps"><li className={data.delivery ? "done" : ""}><QrCode size={18} /><div><b>Supplier issues a signed code</b><span>{data.delivery ? `Handoff v${data.delivery.version} · ${data.delivery.state}` : "Awaiting the exact current code"}</span></div></li><li className={data.delivery?.scannedAt ? "done" : ""}><Truck size={18} /><div><b>Assigned driver records the handoff</b><span>{data.delivery?.scannedAt ? "Controlled driver record saved" : "Scan proves neither condition nor payment"}</span></div></li><li className={data.delivery?.state === "accepted" ? "done" : ""}><ClipboardCheck size={18} /><div><b>Priya inspects and accepts</b><span>{data.delivery?.state === "accepted" ? "Attributed condition acceptance saved" : data.delivery?.state === "rejected" ? "Condition rejected · production review required" : "The qualified lighting lead owns this decision"}</span></div></li><li className={data.feeCaptured ? "done" : ""}><PackageCheck size={18} /><div><b>{formatMoney(data.execution.feeMinor)} fee is verified separately</b><span>{data.feeCaptured ? "PayPal confirms the fee capture" : `${formatMoney(data.execution.depositMinor)} remains an authorization hold`}</span></div></li></ol>
      {data.actor.canScan && data.delivery?.state === "issued" && <section className="handoff-action"><span className="eyebrow">DRIVER / YOUR PART OF THE CHAIN</span><h2>Read the supplier's current code.</h2><QrReader onRead={value => { const parsed = handoffToken(value); setHandoff(parsed); setError(parsed ? null : "This QR image is not an Opening Night handoff link."); }} /><label className="field-label">Or paste the private handoff link<input type="password" value={handoff} onChange={event => setHandoff(handoffToken(event.target.value))} autoComplete="off" placeholder="Paste the signed handoff code" /></label><p>Confirm delivery of <b>{data.execution.unitId}</b> to {data.venue}. Priya will inspect its condition next.</p><Button variant="primary" className="full-width" disabled={!handoffToken(handoff) || busy} busy={busy} onClick={() => void post("/api/deliveries/scan", { idempotencyKey: crypto.randomUUID(), token: handoffToken(handoff) }, "Driver handoff recorded. Condition acceptance and payment remain separate.")}>Record controlled handoff <ArrowRight size={16} /></Button></section>}
      {data.actor.canInspect && data.delivery?.state === "scanned" && <section className="handoff-action"><span className="eyebrow">LIGHTING / YOUR TECHNICAL JUDGMENT</span><h2>Inspect before you accept.</h2><p>The producer approved a {formatMoney(data.execution.feeMinor)} fee after acceptance of this exact console. Reject a failed condition check.</p><div className="inspection-checks">{([{ key: "powerOn", label: "Power-on and control self-test passed" }, { key: "accessories", label: "Required accessories and data connections are present" }, { key: "safeCondition", label: "The console is in safe, acceptable condition" }] as const).map(item => <label key={item.key}><input type="checkbox" checked={condition[item.key]} onChange={event => setCondition(value => ({ ...value, [item.key]: event.target.checked }))} /><span>{item.label}</span></label>)}</div><label className="field-label">Condition report<textarea rows={4} value={condition.report} maxLength={1200} placeholder="Record what you inspected and any condition issues…" onChange={event => setCondition(value => ({ ...value, report: event.target.value }))} /></label><label className="payment-consent"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I personally completed these checks in the controlled rehearsal and confirm this report for handoff v{data.delivery.version}.</span></label><div className="inspection-actions"><Button disabled={busy || !confirmed || condition.report.trim().length < 12} onClick={() => accept("reject")}><TriangleAlert size={15} />Reject condition</Button><Button variant="primary" disabled={busy || !confirmed || condition.report.trim().length < 12 || !condition.powerOn || !condition.accessories || !condition.safeCondition} busy={busy} onClick={() => accept("accept")}><Check size={15} />Accept this console</Button></div></section>}
      {data.delivery?.condition && <section className="saved-condition"><span className="eyebrow">ATTRIBUTED CONDITION RECORD</span><p>{data.delivery.condition.report}</p><Badge tone={data.delivery.state === "accepted" ? "green" : "amber"}>{data.delivery.state.toUpperCase()} · HANDOFF v{data.delivery.version}</Badge></section>}
      <div className="delivery-trust"><ShieldCheck size={19} /><p>Supplier, driver and department lead are controlled fictional roles. Signed records prove this workflow's behavior; they do not claim a physical equipment delivery.</p></div><Button disabled={busy} onClick={() => { void refresh().catch(error => setError(error.message)); }}><RefreshCw size={14} />Refresh handoff</Button>
    </>}
    <footer>One current execution. One assigned role.<br />The fee and deposit remain separate.</footer></main></div>;
}
