/** Controlled SDK and explicit historical-snapshot setup. No actual provider or physical proof. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Actor, ShowSnapshot } from "../src/domain/contracts";
import { applyCommand, recordRescueRun, type Command } from "../src/domain/commands";
import { enumerateCandidates } from "../src/domain/scheduling";
import { digest } from "../src/domain/hash";
import { testEngine } from "./helpers";
import { DisruptionWire } from "./disruption-wire";
import { isolatedDatabase } from "./isolated-database";
export class RetainedRentalWire extends DisruptionWire {
  readonly runId = randomUUID().slice(0, 8).toUpperCase();
  override id(prefix: string) { return prefix + "-" + this.runId + "-" + String(++this.sequence).padStart(5, "0"); }
  voidFault: "refused" | "lost" | "unknown" | null = null;
  afterVoid: (() => void) | null = null;
  constructor(pool: Pool) {
    super(pool); const original = this.fetch;
    this.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init), path = new URL(request.url).pathname;
      if (request.method !== "POST" || !path.endsWith("/void")) return original(input, init);
      if (this.voidFault === "refused" || this.voidFault === "unknown") {
        const fault = this.voidFault; this.voidFault = null; const requestId = request.headers.get("PayPal-Request-Id");
        const op = (await pool.query("SELECT status FROM paycore_operations WHERE provider_request_id=$1", [requestId])).rows[0];
        const call = { method: request.method, path, body: null, requestId, sdkIdempotencyKey: request.headers.get("Idempotency-Key"), durable: op?.status === "dispatching" };
        this.calls.push(call); await this.before?.(call);
        if (fault === "unknown") throw new TypeError("Controlled unknown void outcome before any response");
        return this.json({ name: "NOT_AUTHORIZED", message: "Controlled original void refusal" }, 403);
      }
      const response = await original(input, init); this.afterVoid?.();
      if (this.voidFault === "lost") { this.voidFault = null; throw new TypeError("Controlled lost response after original void"); }
      return response;
    };
  }
  voids() { return this.calls.filter(call => call.method === "POST" && call.path.endsWith("/void")); }
}
export async function rentalHarness(options: { database?: Awaited<ReturnType<typeof isolatedDatabase>>; realEngine?: boolean; appOrigin?: string; onStep?: (step: string, value: unknown) => Promise<void>; prepareProduction?: (session: Awaited<ReturnType<typeof import('../src/server/store').createSession>>) => Promise<void>; preparePlan?: (session: Awaited<ReturnType<typeof import('../src/server/store').createSession>>, show: ShowSnapshot) => Promise<ShowSnapshot> } = {}) {
  const database = options.database ?? await isolatedDatabase(), wire = new RetainedRentalWire(database.pool);
  const appOrigin = options.appOrigin ?? process.env.APP_BASE_URL ?? "http://127.0.0.1:4580";
  (globalThis as typeof globalThis & { openingNightPool?: Pool }).openingNightPool = database.pool;
  (globalThis as typeof globalThis & { openingNightProviders?: unknown }).openingNightProviders = { venue: wire.provider(), brightline: wire.provider() };
  const store = await import("../src/server/store"), payments = await import("../src/server/payment-store"), paymentService = await import("../src/server/payment-service");
  const service = await import("../src/server/rental-closeout/service"), ledger = await import("../src/server/rental-closeout/store"), worker = await import("../src/server/rental-closeout/worker");
  const protocol = await import("../src/server/supplier-protocol"), rfq = await import("../src/server/supplier-rfq"), rpc = await import("../src/app/api/enrolled-suppliers/[supplier]/rpc/route"), delivery = await import("../src/server/delivery-service");
  const { sessionTokenHash } = await import("../src/server/session-records"), { closeCommerceLocks } = await import("../src/server/commerce-locks");
  await payments.paymentStore();
  const signal = () => AbortSignal.timeout(10000);
  const transport: import("../src/server/supplier-protocol").SupplierTransport = request => rpc.POST(request, { params: Promise.resolve({ supplier: new URL(request.url).pathname.split("/").at(-2)! }) });
  async function command(actor: Actor, value: Command) { const show = await store.getShow(actor.tenantId); return (await store.transactCommand(actor, randomUUID(), show.revision, value, current => applyCommand(current, actor, value))).show; }
  async function accepted({ replacePlan = true, captureFee = true } = {}) {
    const session = await store.createSession(undefined, "retained-rental-controlled:" + randomUUID()), actor = session.actor;
    await options.onStep?.("session", session);
    await options.prepareProduction?.(session);
    let show = await command(actor, { type: "load_incidents" }); const rfqId = randomUUID(); await options.onStep?.("rfq-intent", { rfqId, tenantId: actor.tenantId, revision: show.revision }); await rfq.beginSupplierRfq(actor, rfqId, show.revision);
    assert.equal((await rfq.collectSupplierRfq(actor.tenantId, rfqId, signal(), transport)).status, "complete");
    show = await store.getShow(actor.tenantId);
    if (options.preparePlan) show = await options.preparePlan(session, show);
    else {
    const candidates = options.realEngine ? await (await import("../src/server/engine")).generateCandidates(show) : enumerateCandidates(show);
    if (!options.realEngine) candidates.forEach(candidate => { candidate.report.engine = testEngine(candidate); });
    await options.onStep?.("original-plan-candidates", candidates);
    show = (await store.transactCommand(actor, randomUUID(), show.revision, { type: options.realEngine ? "native-real-engine" : "controlled-engine" }, current => recordRescueRun(current, actor, candidates))).show;
    const candidate = candidates.find(item => item.id.startsWith("doors-brightline"))!;
    show = await command(actor, { type: "approve", candidateId: candidate.id, candidateDigest: candidate.digest, approvals: candidate.approvals.map(item => item.id) });
    }
    const offer = show.offers.find(item => item.supplierId === "brightline")!;
    const held = await protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: actor.tenantId, actorId: actor.id, action: { type: "hold", quoteId: offer.serviceQuote!.id, planDigest: show.approvedPlan!.digest, expectedRevision: show.revision, acceptCaptureTerms: true } }, signal(), transport);
    if (held.kind !== "execution") throw new Error("Controlled hold missing"); const executionId = held.execution.id;
    await options.onStep?.("original-rental", held.execution);
    show = await store.getShow(actor.tenantId); const checkout = await paymentService.handlePayment(actor, { type: "rental_checkout", expectedRevision: show.revision }, appOrigin);
    const root = await payments.readIntent(actor.tenantId, checkout.command.intentId), resources = await payments.ownedResources(actor.tenantId, "brightline", root.id), orderId = resources.find(item => item.kind === "order")!.id;
    await options.onStep?.("original-order", { executionId, root, orderId });
    wire.orders.get(orderId)!.status = "APPROVED";
    assert.equal((await paymentService.handlePayment(actor, { type: "complete_checkout", intentId: root.id, state: paymentService.callbackState(root) }, appOrigin)).status, "succeeded");
    await protocol.callSupplierService("brightline", { version: 1, requestId: randomUUID(), tenantId: actor.tenantId, actorId: actor.id, action: { type: "confirm", executionId } }, signal(), transport);
    const token = await store.createSupplierCapability(actor), supplierActor = (await store.getActor(token))!;
    const driverLink = await store.createDeliveryCapability(actor, "driver"), inspectorLink = await store.createDeliveryCapability(actor, "inspector");
    const driver = (await store.getActor(driverLink.token))!, inspector = (await store.getActor(inspectorLink.token))!;
    await options.onStep?.("original-capabilities", { supplier: { token, actor: supplierActor }, driver: { ...driverLink, actor: driver }, inspector: { ...inspectorLink, actor: inspector } });
    show = await command(actor, { type: "advance", time: "17:15" });
    const issued = await delivery.issueDelivery(actor, executionId, randomUUID(), show.revision), scanned = await delivery.scanDelivery(driver, issued.token!, randomUUID()); show = await store.getShow(actor.tenantId);
    await delivery.inspectDelivery(inspector, { executionId, deliveryId: scanned.id, version: scanned.version, commandId: randomUUID(), expectedRevision: show.revision, decision: "accept", condition: { report: "Controlled test inspection only: desk, power and accessories. No real physical sign-off is claimed.", powerOn: true, accessories: true, safeCondition: true } });
    show = await store.getShow(actor.tenantId); const feeIntentId = show.rentalExecutions!.find(item => item.id === executionId)!.captureIntentId!;
    if (captureFee) assert.equal((await paymentService.reconcilePaymentIntent(actor.tenantId, feeIntentId, signal(), true)).status, "complete");
    const original = await store.getShow(actor.tenantId);
    await options.onStep?.("controlled-original-acceptance", original);
    if (replacePlan) {
      // This supplied replacement snapshot tests historical closeout, not late-day re-quoting or planning.
      const replacement = structuredClone(original); replacement.planVersion++; replacement.revision++;
      replacement.approvedPlan = { ...original.approvedPlan!, candidateId: "controlled-replacement-plan", digest: digest({ original: original.approvedPlan!.digest, replacement: replacement.planVersion }), approvedAt: new Date().toISOString() };
      replacement.state = "standby"; replacement.goReportId = null;
      await database.pool.query("UPDATE on_shows SET snapshot=$2 WHERE tenant_id=$1", [actor.tenantId, replacement]);
      await options.onStep?.("earlier-plan-snapshot-attribution", { originalPlanVersion: original.planVersion, originalPlanDigest: original.approvedPlan!.digest, suppliedReplacementPlanVersion: replacement.planVersion, suppliedReplacementDigest: replacement.approvedPlan!.digest, purpose: "Controlled historical-closeout setup only; does not qualify fresh late-day RFQ, replacement scheduling, or replacement producer approval." });
    }
    return { ...session, actor, original, executionId, root, orderId, feeIntentId, supplierToken: token, authority: { actor, sessionHash: sessionTokenHash(session.token) }, supplierAuthority: { actor: supplierActor, sessionHash: sessionTokenHash(token) } };
  }
  async function act(authority: import("../src/server/rental-closeout/contracts").CloseoutAuthority, command: import("../src/domain/rental-closeout").CloseoutCommand, envelope?: import("../src/domain/rental-closeout").CloseoutEnvelope) {
    const show = await store.getShow(authority.actor.tenantId);
    return service.executeCloseoutCommand(authority, envelope ?? { commandId: randomUUID(), expectedRevision: show.revision, command });
  }
  async function returned(value: Awaited<ReturnType<typeof accepted>>, condition: "undamaged" | "damage_reported" = "undamaged") {
    const desk = await service.readCloseoutWorkspace(value.supplierAuthority), rental = desk.rentals.find(item => item.id === value.executionId)!;
    return act(value.supplierAuthority, { type: "record_return", executionId: rental.id, executionDigest: rental.executionDigest, previousInspectionId: rental.latestReturnId, observedAt: new Date().toISOString(), condition, detail: "Controlled original-unit return inspection; no actual physical handoff is claimed by this test.", confirmed: true });
  }
  async function approve(value: Awaited<ReturnType<typeof accepted>>) {
    const show = await store.getShow(value.actor.tenantId), preview = await service.previewRentalCloseout(value.authority, value.executionId, show.revision);
    assert.equal(preview.ready, true, preview.blockers.join("; "));
    const result = await act(value.authority, { type: "approve_closeout", executionId: value.executionId, previewDigest: preview.digest, detail: "Producer reviewed the exact original accepted fee and undamaged return before closing only its residual authorization.", confirmed: true });
    const grant = await ledger.readCloseoutGrant(value.actor.tenantId, result.receipt.recordId);
    return { ...grant, intent: await payments.readIntent(value.actor.tenantId, grant.progress.intentId!), preview, result };
  }
  return { database, wire, store, payments, paymentService, service, ledger, worker, sessionTokenHash, signal, accepted, command, act, returned, approve, close: async () => { await closeCommerceLocks(); await database.close(); } };
}
