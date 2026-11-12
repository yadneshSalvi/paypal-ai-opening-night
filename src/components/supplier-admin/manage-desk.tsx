"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, CircleDashed, Fingerprint, History, KeyRound, Package, Plus, RefreshCw, ShieldCheck, ShieldX, Truck } from "lucide-react";
import { PRODUCTION_SCOPE_HEADER } from "@/domain/rehearsal-contracts";
import { formatMoney, localTime } from "@/domain/time";
import type { SupplierAdminCommand } from "@/domain/supplier-admin/commands";
import type { AdminResult, AdminWorkspace } from "@/domain/supplier-admin/contracts";
import { Badge, Button, Modal } from "../ui";
import { PRODUCTION_CHANGED_EVENT } from "../production-fetch";
import { SupplierAdminReviewForm, type AdminReviewAction } from "./review-form";
import { adminRecoveryKey, clearAdminPending, isAdminWorkspace, matchesAdminReceipt, parseAdminPending, prepareAdminPending, resolveAdminPending, retainAdminPending, sameAdminIdentity, type PendingAdmin } from "./recovery";

const words = (value: string) => value.replaceAll("_", " ");
export function SupplierAdminDesk({ ownerMode = false }: { ownerMode?: boolean }) {
  const [workspace, setWorkspace] = useState<AdminWorkspace | null>(null), [selected, setSelected] = useState("");
  const [action, setAction] = useState<(AdminReviewAction & { key: string }) | null>(null), [pending, setPending] = useState<PendingAdmin | null>(null), [notReceived, setNotReceived] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [invitation, setInvitation] = useState<AdminResult["invitation"]>(undefined), [elapsed, setElapsed] = useState(0);
  const [accessChanged, setAccessChanged] = useState(false), changedRef = useRef(false), clockAnchor = useRef({ serverAt: "", clientAt: Date.now() });
  if (workspace && clockAnchor.current.serverAt !== workspace.serverAt) clockAnchor.current = { serverAt: workspace.serverAt, clientAt: Date.now() };
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace; const busyRef = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const identityKey = workspace ? adminRecoveryKey(workspace) : "";
  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set("x-opening-supplier-admin-role", ownerMode ? "supplier" : "producer");
    const current = workspaceRef.current; if (current) headers.set(PRODUCTION_SCOPE_HEADER, current.tenantId);
    return fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store", redirect: "error", signal: init.signal ?? AbortSignal.timeout(15000) });
  }, [ownerMode]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await request("/api/supplier-admin", { ...(signal ? { signal } : {}) }), body = await response.json();
    if (!response.ok || !isAdminWorkspace(body)) throw new Error(body.error ?? "The current supplier desk could not be verified.");
    setWorkspace(body); setElapsed(0); return body;
  }, [request]);
  const complete = useCallback((result: AdminResult, original: PendingAdmin) => {
    if (!matchesAdminReceipt(result, original)) throw new Error("This response does not match the saved instruction. Its original identity stays pending.");
    if (changedRef.current) throw new Error("Production access changed while this result was pending. Its original recovery file stays retained.");
    clearAdminPending(localStorage, original);
    if (workspaceRef.current && !sameAdminIdentity(workspaceRef.current, original)) return;
    setWorkspace(result.workspace); setPending(null); setNotReceived(false); setAction(null); setError(""); setElapsed(0); setNotice(result.receipt.message); setInvitation(result.invitation);
  }, []);
  const recover = useCallback(async (original: PendingAdmin, retry = false) => {
    const found = await resolveAdminPending(request, original, retry);
    if (found.kind === "receipt") complete(found.result, original);
    else { setNotReceived(true); setNotice("The original command has no server receipt. Review the saved instruction before retrying those exact bytes."); }
  }, [request, complete]);
  useEffect(() => {
    const controller = new AbortController(); let live = true;
    void (async () => {
      if (ownerMode && /^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1))) {
        const response = await fetch("/api/supplier-admin/session", { method: "POST", headers: { Authorization: `Bearer ${location.hash.slice(1)}` }, credentials: "same-origin", signal: controller.signal, redirect: "error" }), body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "The original supplier invitation could not be connected.");
        history.replaceState(null, "", location.pathname + location.search);
      }
      if (live) await load(controller.signal);
    })().catch(failure => { if (live && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "The current desk could not load."); });
    return () => { live = false; controller.abort(); };
  }, [ownerMode, load]);
  useEffect(() => {
    if (!identityKey || !workspaceRef.current) return; let live = true;
    const current = workspaceRef.current;
    void (async () => {
      const raw = localStorage.getItem(identityKey); if (!raw) return;
      const saved = await parseAdminPending(raw, current); if (!live) return;
      setPending(saved); await recover(saved);
    })().catch(failure => { if (live) setError(failure instanceof Error ? failure.message : "The saved instruction could not be read. It remains retained."); });
    return () => { live = false; };
  }, [identityKey, recover]);
  useEffect(() => { const timer = setInterval(() => setElapsed(value => value + 1000), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { const changed = () => { changedRef.current = true; setAccessChanged(true); setAction(null); setError("Production access changed. Reload this desk to read the current access. Original pending instructions stay retained."); }; window.addEventListener(PRODUCTION_CHANGED_EVENT, changed); return () => window.removeEventListener(PRODUCTION_CHANGED_EVENT, changed); }, []);
  async function submit(command: SupplierAdminCommand, reviewed: AdminWorkspace) {
    if (busyRef.current) return;
    if (changedRef.current || !workspaceRef.current || !sameAdminIdentity(workspaceRef.current, reviewed)) throw new Error("The access changed after this review. Keep the original source and reopen the current desk.");
    if (pending) throw new Error("Read the original pending result before creating another instruction.");
    busyRef.current = true; setBusy(true); setError(""); setNotice(""); let original: PendingAdmin | null = null, retained = false;
    try {
      original = await prepareAdminPending(reviewed, { commandId: crypto.randomUUID(), expectedRevision: reviewed.revision, sessionFingerprint: reviewed.sessionFingerprint, expiresAt: reviewed.expiresAt, command });
      retainAdminPending(localStorage, original); original = await parseAdminPending(localStorage.getItem(adminRecoveryKey(original))!, reviewed); retained = true; setPending(original); setNotReceived(false);
      const response = await request("/api/supplier-admin/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(original.envelope) }), body = await response.json();
      if (!response.ok || !matchesAdminReceipt(body, original)) throw new Error(body.error ?? "The original result is unverified. Checking its saved command identity.");
      complete(body, original);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "The instruction's result is unverified."; setError(message);
      if (!original || !retained) throw failure;
      setAction(null);
      try { await recover(original); } catch (recoveryError) { setError(recoveryError instanceof Error ? recoveryError.message : message); }
    } finally { busyRef.current = false; setBusy(false); }
  }
  async function checkOriginal(retry: boolean) {
    if (!pending || busyRef.current) return; busyRef.current = true; setBusy(true); setError("");
    try { await recover(pending, retry); } catch (failure) { setError(failure instanceof Error ? failure.message : "The original receipt could not be verified."); } finally { busyRef.current = false; setBusy(false); }
  }
  const serverNow = workspace ? Date.parse(workspace.serverAt) + Math.max(0, Date.now() - clockAnchor.current.clientAt) : Date.now(), ended = Boolean(workspace && serverNow >= Date.parse(workspace.expiresAt)), blocked = busy || Boolean(pending) || ended || accessChanged;
  const card = workspace?.cards.find(value => value.id === selected) ?? workspace?.cards[0];
  const open = (value: AdminReviewAction) => { if (!blocked) setAction({ ...value, key: crypto.randomUUID() }); };
  return <main className="supplier-admin" aria-labelledby="sa-title">
    <header className="sa-header"><Link href="/" prefetch={false} className="sa-back"><ArrowLeft size={16} />{ownerMode ? "Opening Night" : "Production"}</Link><Badge tone="amber">SUPPLIER NETWORK · CONTROLLED</Badge><Button busy={busy} disabled={busy} onClick={() => { void load().catch(failure => setError(failure.message)); }}><RefreshCw size={15} />Refresh sources</Button></header>
    <section className="sa-intro"><div><span className="eyebrow">{ownerMode ? "YOUR INVENTORY. YOUR AUTHORITY." : "SEPARATE OWNERS. EXPLICIT LIMITS."}</span><h1 id="sa-title" ref={heading} tabIndex={-1}>The supplier desk.</h1><p>{ownerMode ? "Publish what you own. Bound what your service may offer. Keep every earlier promise visible." : "Admit participating suppliers, review their sources and negotiate within separately approved limits."}</p></div>{workspace?.role === "producer" && <Button variant="primary" disabled={blocked} onClick={() => open({ type: "invite" })}><Plus size={17} />Admit a supplier</Button>}</section>
    {workspace && <div className="sa-access"><span>PRODUCTION r{workspace.revision} · SCENARIO {localTime(workspace.clock)} CHICAGO</span><span>{ended ? "ACCESS EXPIRED" : `ACCESS ENDS ${new Date(workspace.expiresAt).toLocaleString()}`}</span></div>}
    {error && <p className="sa-alert" role="alert">{error}</p>}{notice && <p className="sa-notice" role="status">{notice}</p>}
    {ended && <p className="sa-alert">This exact access has expired. Reading, retries and newer terms cannot extend its authority. Its saved history remains retained.</p>}
    {pending && <section className="sa-pending" aria-labelledby="sa-pending-title"><CircleDashed size={22} /><div><h2 id="sa-pending-title">Read the original result.</h2><p>{words(pending.envelope.command.type)} is saved with its original identity. A new instruction stays blocked until its result is verified.</p><code>{pending.envelope.commandId}</code><div className="sa-actions"><Button disabled={busy} onClick={() => void checkOriginal(false)}>Check original receipt</Button>{notReceived && <Button disabled={busy || ended} onClick={() => void checkOriginal(true)}>Retry exact saved instruction</Button>}</div></div></section>}
    {!workspace && <section className="sa-empty"><ShieldCheck size={32} /><h2>{error ? "Original access required" : "Reading current supplier sources…"}</h2><p>{ownerMode ? "Open the private invitation supplied by the producer. The connection keeps its original fixed expiry." : "Open a production rehearsal, then return to its supplier desk."}</p></section>}
    {workspace && <div className="sa-layout"><aside><nav className="sa-catalog" aria-label="Managed suppliers">{workspace.cards.map(value => <button type="button" key={value.id} aria-pressed={value.id === card?.id} onClick={() => setSelected(value.id)}><span className="sa-avatar">{value.name.slice(0, 2).toUpperCase()}</span><span><b>{value.name}</b><small>{words(value.status)} · {value.units.length} owned unit{value.units.length === 1 ? "" : "s"}</small></span><ArrowRight size={15} /></button>)}</nav>{workspace.role === "producer" && <details className="sa-originals"><summary>Three original services retained</summary><p>Original identities, signatures, quotes, fees and obligations remain on their original sources.</p>{workspace.originalServices.map(value => <div key={value.supplierId}><b>{value.supplier}</b><span>{value.unitId}</span></div>)}</details>}</aside>
      <div className="sa-main">{!card ? <section className="sa-empty"><Package size={34} /><h2>Start with a separate owner.</h2><p>Admission opens a private controlled access link. The supplier accepts it and publishes its own unit, evidence, key and terms before negotiation.</p></section> : <>
        <section className="sa-card-heading"><div><Badge tone={card.status === "admitted" ? "green" : "amber"}>{words(card.status).toUpperCase()}</Badge><h2>{card.name}</h2><p>{card.enrollment.reference}</p></div>{["admitted", "invited"].includes(card.status) && <Button disabled={blocked} onClick={() => open({ type: "revoke", supplierId: card.id, targetId: card.enrollmentId, targetKind: "enrollment" })}><ShieldX size={15} />{card.status === "admitted" ? "Revoke admission" : workspace.role === "supplier" ? "Decline invitation" : "Withdraw invitation"}</Button>}</section>
        <div className="sa-merchant"><ShieldCheck size={19} /><div><b>Actual checkout unavailable</b><p>No matching verified merchant adapter is configured. A signed quote or provisional hold does not create a payment or merchant receipt.</p></div></div>
        {workspace.role === "supplier" && card.status === "invited" && <section className="sa-feature"><h3>Accept your own admission.</h3><p>The producer's invitation gives you a separate identity with a fixed expiry. Acceptance is your own attributed action.</p><Button variant="primary" disabled={blocked} onClick={() => open({ type: "admit", supplierId: card.id })}>Review and accept admission</Button></section>}
        <section className="sa-section"><div className="sa-section-title"><div><KeyRound size={19} /><h3>Independent signing authority</h3></div>{workspace.role === "supplier" && <Button disabled={blocked || card.status !== "admitted"} onClick={() => open({ type: "rotate_key", supplierId: card.id })}>{card.key ? "Rotate key" : "Create signing key"}</Button>}</div>
          {card.key ? <div className="sa-key"><Badge tone={card.key.active ? "green" : "amber"}>{card.key.active ? `KEY EDITION ${card.key.revision}` : "KEY REVOKED"}</Badge><code>{card.key.fingerprint}</code>{workspace.role === "supplier" && card.key.active && <Button disabled={blocked} onClick={() => open({ type: "revoke", supplierId: card.id, targetKind: "key", targetId: card.key!.id })}>Revoke current key</Button>}</div> : <p className="sa-muted">The supplier has not published a signing key.</p>}
          <details><summary>Retained key history · {card.keyHistory.length}</summary><p>Historical replies retain verification after rotation or revocation. Current authority is checked separately before any new commitment.</p>{card.keyHistory.map(key => <div className="sa-history-row" key={key.id}><span>Edition {key.revision} · {key.status}</span><code>{key.fingerprint}</code></div>)}</details>
        </section>
        <section className="sa-section"><div className="sa-section-title"><div><Package size={19} /><h3>Owned inventory and term editions</h3></div>{workspace.role === "supplier" && <Button disabled={blocked || card.status !== "admitted"} onClick={() => open({ type: "inventory", supplierId: card.id })}><Plus size={15} />Add an owned unit</Button>}</div>
          {!card.units.length && <p className="sa-muted">No inventory has been declared. No capacity is inferred from enrollment.</p>}
          {card.units.map(unit => <article className="sa-unit" key={unit.inventory.id}><div><b>{unit.inventory.label}</b><code>{unit.inventory.unitId}</code><span>{unit.inventory.model}</span></div><Badge tone={unit.inventory.available ? "green" : "amber"}>{unit.inventory.available ? "DECLARED AVAILABLE" : "WITHDRAWN"}</Badge><p>{unit.inventory.compatible && unit.inventory.qualifiedDriver === true && unit.inventory.conditionVerified === true ? "Declared capability, driver and condition sources present." : "Compatibility, driver or condition evidence remains incomplete."}</p>
            {unit.terms ? <p><strong>{formatMoney(unit.terms.feeMinor, true)}</strong> fee · {formatMoney(unit.terms.depositMinor, true)} separate deposit<br />Delivery {localTime(unit.terms.earliestDelivery)}–{localTime(unit.terms.latestDelivery)} Chicago · terms edition {unit.terms.revision}</p> : <p>Current supplier terms have not been published.</p>}
            <details><summary>Source and immutable editions</summary><p>{unit.inventory.reference} · {unit.inventory.detail}</p><p>{unit.inventory.capabilityEvidence}</p><p>{unit.inventory.driverEvidence ?? "Driver evidence unknown."}</p><p>{unit.inventory.conditionEvidence ?? "Condition evidence unknown."}</p>{unit.terms && <><p>{unit.terms.reference} · {unit.terms.detail}</p><p>{unit.terms.cancellation}</p><p>Real expiry: {unit.terms.validUntil}<br />Scenario deadline: {unit.terms.scenarioDeadline}</p></>}<code>{unit.inventory.id}</code></details>
            {workspace.role === "supplier" && <div className="sa-actions"><Button disabled={blocked || card.status !== "admitted"} onClick={() => open({ type: "inventory", supplierId: card.id, unitId: unit.inventory.unitId })}>New inventory edition</Button><Button disabled={blocked || card.status !== "admitted"} onClick={() => open({ type: "terms", supplierId: card.id, unitId: unit.inventory.unitId })}>New terms edition</Button><Button disabled={blocked || !card.key?.active || !unit.terms || unit.terms.inventoryId !== unit.inventory.id} onClick={() => open({ type: "supplier_mandate", supplierId: card.id, unitId: unit.inventory.unitId })}>Bound negotiation</Button></div>}
            {workspace.role === "producer" && <Button disabled={blocked || !card.mandates.some(value => value.active && value.data.inventoryId === unit.inventory.id)} onClick={() => open({ type: "request_quotes", supplierId: card.id, unitId: unit.inventory.unitId })}>Review producer RFQ <ArrowRight size={15} /></Button>}
          </article>)}
        </section>
        <section className="sa-section"><div className="sa-section-title"><div><Fingerprint size={19} /><h3>Bounded negotiation</h3></div></div><p className="sa-muted">Separate reviewed mandates bound every fee, deposit, delivery window and round. Expiry never renews itself.</p>
          {card.mandates.map(mandate => <details key={mandate.id}><summary>Supplier mandate · {words(mandate.status)} · {mandate.data.bounds.maxRounds} rounds</summary><p>{formatMoney(mandate.data.bounds.feeMinMinor, true)}–{formatMoney(mandate.data.bounds.feeMaxMinor, true)} fee · up to {formatMoney(mandate.data.bounds.depositMaxMinor, true)} deposit<br />Delivery {localTime(mandate.data.bounds.earliestDelivery)}–{localTime(mandate.data.bounds.latestDelivery)} Chicago<br />Fixed real expiry {mandate.data.expiresAt}</p><p>{mandate.data.detail}</p>{workspace.role === "supplier" && mandate.active && <Button disabled={blocked} onClick={() => open({ type: "revoke", supplierId: card.id, targetKind: "supplier_mandate", targetId: mandate.id })}>Revoke this mandate</Button>}</details>)}
          {!card.rfqs.length && <p className="sa-muted">No producer request has been reviewed against these sources.</p>}
          {card.rfqs.map(rfq => <article className="sa-rfq" key={rfq.id}><div className="sa-section-title"><h4>Reviewed RFQ · r{rfq.data.reviewedRevision}</h4><Badge tone={rfq.status === "admitted" ? "green" : "amber"}>{words(rfq.status === "pending" && Date.parse(rfq.data.expiresAt) <= serverNow ? "expired" : rfq.status).toUpperCase()}</Badge></div><p>{formatMoney(rfq.data.bounds.feeMinMinor, true)}–{formatMoney(rfq.data.bounds.feeMaxMinor, true)} fee · up to {formatMoney(rfq.data.bounds.depositMaxMinor, true)} deposit<br />{rfq.rounds.length}/{rfq.roundLimit} bounded rounds · expiry {new Date(rfq.data.expiresAt).toLocaleString()}</p>
            {rfq.rounds.map(round => <div className="sa-round" key={round.id}><div><b>Round {round.data.round}</b><span className="sa-verified">{round.verified ? <Check size={14} /> : <ShieldX size={14} />}{round.verified ? "Signature verified" : "Unverified"}</span></div>{round.data.outcome.kind === "declined" ? <p><b>Signed refusal · {words(round.data.outcome.decline.code).toLowerCase()}</b><br />{round.data.outcome.decline.message}</p> : <><strong>{formatMoney(round.data.outcome.quote.offer.feeMinor, true)}</strong><p>{formatMoney(round.data.outcome.quote.offer.depositMinor, true)} separate deposit · {localTime(round.data.outcome.quote.offer.deliveryAt)} Chicago delivery</p><code>{round.data.outcome.quote.termsDigest}</code>{round.accepted && <Badge tone="green">ADMITTED TO REAL PLANNER</Badge>}{workspace.role === "producer" && !round.accepted && <Button disabled={blocked || (rfq.status !== "pending" || Date.parse(rfq.data.expiresAt) <= serverNow) || !round.verified} onClick={() => open({ type: "accept_quote", supplierId: card.id, rfqId: rfq.id, roundId: round.id })}>Review this signed quote</Button>}{workspace.role === "producer" && round.accepted && workspace.currentPlan?.quoteId === round.data.outcome.quote.id && <Button disabled={blocked || rfq.status !== "admitted" || Date.parse(round.data.outcome.kind === "quote" ? round.data.outcome.quote.validUntil : rfq.data.expiresAt) <= serverNow || card.retained.some(value => value.planVersion === workspace.currentPlan?.planVersion)} onClick={() => open({ type: "reserve", supplierId: card.id, rfqId: rfq.id, roundId: round.id })}>Review exact provisional hold</Button>}</>}
              <details><summary>Exact signed source</summary><p>Request {rfq.id}<br />Reply {round.id}</p><p>Key {round.data.outcome.kind === "quote" ? round.data.outcome.quote.adminSource?.keyFingerprint : round.data.outcome.decline.source.keyFingerprint}</p><p>Declared controlled supplier. A cryptographic signature does not establish physical condition or a merchant receipt.</p></details>
            </div>)}
            {workspace.role === "producer" && rfq.status === "pending" && <div className="sa-actions"><Button disabled={blocked || Date.parse(rfq.data.expiresAt) <= serverNow || rfq.rounds.length >= rfq.roundLimit} onClick={() => open({ type: "negotiate", supplierId: card.id, rfqId: rfq.id })}>Review next bounded round</Button><Button disabled={blocked} onClick={() => open({ type: "revoke", supplierId: card.id, targetKind: "rfq", targetId: rfq.id })}>Revoke request</Button></div>}
          </article>)}
          {workspace.role === "producer" && <Link href="/" prefetch={false} className="sa-flow-link">Continue in the production recovery studio <ArrowRight size={17} /><small>Generate real engine candidates and separately approve the selected plan.</small></Link>}
        </section>
        <section className="sa-section"><div className="sa-section-title"><div><Truck size={19} /><h3>Original commitments retained</h3></div></div>{card.retained.length ? card.retained.map(value => <div key={value.id} className="sa-retained"><b>{value.unitId} · plan v{value.planVersion}</b><span>{words(value.state)} · {formatMoney(value.feeMinor, true)} fee / {formatMoney(value.depositMinor, true)} deposit</span><code>{value.id}</code>{workspace.role === "producer" && ["held", "awaiting_payment", "expired"].includes(value.state) && <Button disabled={blocked} onClick={() => open({ type: "release", supplierId: card.id, executionId: value.id })}>Review original release</Button>}</div>) : <p className="sa-muted">No rental commitment exists for this supplier. Quotes and declarations reserve nothing.</p>}</section>
      </>}
      <section className="sa-section sa-receipts"><div className="sa-section-title"><div><History size={19} /><h3>This exact access's command history</h3></div></div>{workspace.history.length ? workspace.history.map(receipt => <details key={receipt.commandId}><summary>{receipt.status === "completed" ? "Saved" : "Refused"} · {words(receipt.action)} · r{receipt.revision}</summary><p>{receipt.message}</p>{receipt.code && <code>{receipt.code}</code>}<code>{receipt.commandId}</code><small>{receipt.at}</small></details>) : <p className="sa-muted">No administration instruction has been submitted by this exact access.</p>}</section>
    </div></div>}
    <footer className="sa-footer">Declared controlled identities and evidence · Fixed same-origin supplier services · No actual outreach, purchase or physical fulfillment claimed</footer>
    {workspace && action && <SupplierAdminReviewForm key={action.key} action={action} workspace={workspace} busy={busy} onClose={() => setAction(null)} onSubmit={submit} fallbackFocus={() => heading.current} />}
    {invitation && <Modal title="Separate supplier access is ready" onClose={() => setInvitation(undefined)} fallbackFocus={() => heading.current}><div className="sa-review"><Badge tone="amber">PRIVATE CONTROLLED INVITATION</Badge><p>The supplier accepts this original admission in its own owner desk. No message was sent. Access ends {new Date(invitation.expiresAt).toLocaleString()}.</p><a className="button primary" href={invitation.url} target="_blank" rel="noreferrer">Open the supplier's separate desk <ArrowRight size={16} /></a><p>Keep this link private. Reopening it retains the original fixed expiry.</p></div></Modal>}
  </main>;
}
