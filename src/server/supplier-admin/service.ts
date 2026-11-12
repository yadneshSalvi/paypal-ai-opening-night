import { randomBytes, randomUUID } from "node:crypto";
import { DomainError, type Actor, type SupplierOffer } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { planningDigest } from "@/domain/scheduling";
import { supplierRecoveryBasis } from "@/domain/supplier-recovery";
import { supplierIds, type SupplierQuote } from "@/domain/supplier-contracts";
import { supplierAdminEnvelopeSchema, type SupplierAdminCommand, type SupplierAdminEnvelope } from "@/domain/supplier-admin/commands";
import type { AdminAuthority, AdminQuoteSource, AdminRecord, AdminResult, AdminWorkspace, Enrollment, InventoryEdition, ManagedSupplierId, NegotiationRound, QuoteAcceptance, ReviewedRfq, Revocation, SupplierAdminCard, SupplierKey, SupplierMandate, TermEdition } from "@/domain/supplier-admin/contracts";
import { negotiateBounds } from "@/domain/supplier-admin/negotiation";
import { sealIntelligence, openIntelligence } from "../intelligence/private-payload";
import { sessionTokenHash } from "../session-records";
import { saveSupplierSnapshot } from "../supplier-storage";
import { supplierUnitCommitted } from "../supplier-recovery/store";
import { accessCurrent, admitted, adminFingerprint, adminTransaction, appendAdminRecord, currentInventory, currentKey, currentTerms, latestRecord, ownSupplier, readAdminReceipt, readAdminRecords, recordById, requireAdminAuthority, revoked, saveAdminReceipt, type AdminContext } from "./store";
import { generateSupplierKey, signManagedDecline, signManagedQuote, verifyManagedDecline, verifyManagedQuoteSignature } from "./signatures";

const deny = (code: string, message: string, status = 409): never => { throw new DomainError(code, message, status); };
const expiry = (context: AdminContext, minutes: number, ...ceilings: string[]) => new Date(Math.min(Date.parse(context.now) + minutes * 60_000, Date.parse(context.expiresAt), ...ceilings.map(Date.parse))).toISOString();
function currentTime(context: AdminContext, deadline: string) { if (Date.parse(deadline) <= Date.parse(context.now)) deny("SUPPLIER_MANDATE_EXPIRED", "This fixed supplier instruction expired. Its original history cannot renew authority."); }
function invalidateFutureOffers(context: AdminContext, supplierId: ManagedSupplierId) {
  context.show.offers = context.show.offers.map(offer => offer.supplierId === supplierId && offer.serviceQuote?.adminSource ? { ...offer, serviceQuote: { ...offer.serviceQuote, reviewRequired: { code: "MANAGED_RFQ_SOURCE_CHANGED" as const, detail: "The supplier's current admission, key, inventory, terms or mandate changed. Review a distinct bounded RFQ. The earlier signed quote and original expiry remain retained." } } } : offer);
  if (context.show.offers.some(offer => offer.supplierId === supplierId)) { context.show.state = "standby"; context.show.goReportId = null; }
}
function reviewDigest(context: AdminContext) { return digest({ source: supplierRecoveryBasis(context.show), records: context.records.map(record => ({ id: record.id, digest: digest(record) })), sessionFingerprint: adminFingerprint(context.authority.sessionHash), expiresAt: context.expiresAt }); }
function producer(context: AdminContext) { if (context.authority.actor.supplierId || !context.authority.actor.roles.includes("producer")) deny("SUPPLIER_ADMIN_ROLE", "Only the producer may review this production's supplier request.", 403); }
function requireOriginalOwner(context: AdminContext, supplierId: ManagedSupplierId, enrollment: AdminRecord<Enrollment>) {
  ownSupplier(context, supplierId);
  if (enrollment.data.ownerActorId !== context.authority.actor.id) deny("SUPPLIER_ADMIN_SCOPE", "This supplier belongs to its separately admitted owner.", 403);
  if (enrollment.data.ownerFingerprint !== adminFingerprint(context.authority.sessionHash) || enrollment.data.ownerExpiresAt !== context.expiresAt) deny("SUPPLIER_ADMIN_ACCESS_ENDED", "Use this supplier's original exact invitation capability and full fixed expiry. Different access cannot adopt it.", 403);
}
function requireOwner(context: AdminContext, supplierId: ManagedSupplierId) {
  ownSupplier(context, supplierId); const enrollment = admitted(context.records, supplierId); requireOriginalOwner(context, supplierId, enrollment);
  if (enrollment.access.sessionHash !== context.authority.sessionHash || enrollment.access.expiresAt !== context.expiresAt) deny("SUPPLIER_ADMIN_ACCESS_ENDED", "This enrollment belongs to its original exact supplier capability and fixed expiry. Different access cannot adopt it.", 403);
  return enrollment;
}
async function chain(context: AdminContext, supplierId: ManagedSupplierId, mandateId: string) {
  context.now = (await context.db.query<{ now: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS now")).rows[0]!.now;
  const enrollment = admitted(context.records, supplierId), mandate = recordById<SupplierMandate>(context.records, mandateId, "supplier_mandate", supplierId);
  const key = currentKey(context.records, supplierId), inventory = recordById<InventoryEdition>(context.records, mandate.data.inventoryId, "inventory", supplierId), terms = recordById<TermEdition>(context.records, mandate.data.termsId, "terms", supplierId);
  if (mandate.data.enrollmentId !== enrollment.id || mandate.data.keyId !== key.id || currentInventory(context.records, supplierId, inventory.data.unitId)?.id !== inventory.id || currentTerms(context.records, supplierId, inventory.data.unitId)?.id !== terms.id || terms.data.inventoryId !== inventory.id || revoked(context.records, mandate.id)) deny("SUPPLIER_ADMIN_SOURCE_CHANGED", "The supplier's admission, key, inventory, terms or mandate changed. Review a new exact source.");
  if (mandate.access.actor.id !== enrollment.data.ownerActorId) deny("SUPPLIER_ADMIN_SCOPE", "The supplier mandate is not owned by this admitted supplier.", 403);
  currentTime(context, mandate.data.expiresAt); currentTime(context, terms.data.validUntil);
  if (Date.parse(terms.data.scenarioDeadline) <= Date.parse(context.show.clock) || Date.parse(terms.data.earliestDelivery) < Date.parse(context.show.clock)) deny("SUPPLIER_TERMS_EXPIRED", "The supplier's scenario deadline or delivery window passed. Publish a distinct current edition.");
  await accessCurrent(context.db, enrollment.access); await accessCurrent(context.db, key.access); await accessCurrent(context.db, mandate.access); await accessCurrent(context.db, terms.access);
  return { enrollment, mandate, key, inventory, terms };
}
async function requireRfq(context: AdminContext, supplierId: ManagedSupplierId, rfqId: string, requireSource = true) {
  const rfq = recordById<ReviewedRfq>(context.records, rfqId, "rfq", supplierId);
  if (revoked(context.records, rfqId)) deny("SUPPLIER_RFQ_REVOKED", "This reviewed request was revoked. Its replies remain historical.");
  const result = await chain(context, supplierId, rfq.data.supplierMandateId);
  currentTime(context, rfq.data.expiresAt); await accessCurrent(context.db, rfq.access);
  if (rfq.data.enrollmentId !== result.enrollment.id || rfq.data.keyId !== result.key.id || rfq.data.inventoryId !== result.inventory.id || rfq.data.termsId !== result.terms.id) deny("SUPPLIER_RFQ_SOURCE_CHANGED", "This reviewed request no longer matches the supplier's current sources.");
  if (requireSource && (rfq.data.reviewedRevision !== context.show.revision || rfq.data.sourceDigest !== supplierRecoveryBasis(context.show))) deny("SUPPLIER_RFQ_SOURCE_CHANGED", "The production changed after this exact request. Review current sources before another negotiation.");
  return { ...result, rfq };
}
async function privateKey(context: AdminContext, id: string) {
  const row = (await context.db.query<{ private_cipher: string }>("SELECT private_cipher FROM on_supplier_admin_keys WHERE tenant_id=$1 AND id=$2", [context.show.tenantId, id])).rows[0];
  if (!row) deny("SUPPLIER_KEY_UNAVAILABLE", "The exact supplier signer is unavailable.", 503);
  return openIntelligence<{ privateKey: string }>(context.show.tenantId, `supplier-admin-private:${id}`, row!.private_cipher).privateKey;
}
async function invitation(context: AdminContext, receipt: import("@/domain/supplier-admin/contracts").AdminReceipt) {
  if (receipt.action !== "invite" || receipt.status !== "completed") return undefined;
  const row = (await context.db.query<{ document_cipher: string }>("SELECT document_cipher FROM on_supplier_admin_invites WHERE tenant_id=$1 AND id=$2 AND producer_session_hash=$3", [context.show.tenantId, receipt.recordId, context.authority.sessionHash])).rows[0];
  if (!row) deny("SUPPLIER_INVITATION_INTEGRITY", "The original supplier invitation could not be recovered.", 503);
  return openIntelligence<NonNullable<AdminResult["invitation"]>>(context.show.tenantId, `supplier-admin-invite:${receipt.recordId}`, row!.document_cipher);
}
async function openEnrollment(context: AdminContext, command: Extract<SupplierAdminCommand, { type: "invite" }>) {
  producer(context); if (command.reviewDigest !== reviewDigest(context)) deny("SUPPLIER_ADMIN_REVIEW_CHANGED", "Review the current production and admitted supplier list before opening new access.");
  if (new Set(context.records.filter(record => record.kind === "enrollment").map(record => record.supplierId)).size >= 12) deny("SUPPLIER_ADMISSION_LIMIT", "This production supports twelve managed suppliers. Retained suppliers cannot be overwritten.");
  const supplierId: ManagedSupplierId = `enrolled-${randomUUID()}`, token = randomBytes(32).toString("base64url");
  const actor: Actor = { id: `supplier-owner:${randomUUID()}`, tenantId: context.show.tenantId, roles: ["supplier"], personId: null, supplierId };
  const ownerExpiry = (await context.db.query<{ expiry: string }>(`INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,least($4::timestamptz,clock_timestamp()+interval '24 hours'))
    RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry`, [sessionTokenHash(token), actor.tenantId, actor, context.expiresAt])).rows[0]!.expiry;
  const record = await appendAdminRecord<Enrollment>(context, supplierId, "enrollment", { name: command.name, reference: command.reference, detail: command.detail, ownerActorId: actor.id, ownerFingerprint: adminFingerprint(sessionTokenHash(token)), ownerExpiresAt: ownerExpiry, status: "invited", previousId: null, merchant: { state: "unconfigured", message: "Actual checkout unavailable: no matching verified merchant adapter is configured." } });
  const invite = { url: `/suppliers/manage/owner#${token}`, expiresAt: ownerExpiry, supplierId };
  await context.db.query("INSERT INTO on_supplier_admin_invites(tenant_id,id,producer_session_hash,document_cipher) VALUES($1,$2,$3,$4)", [actor.tenantId, record.id, context.authority.sessionHash, sealIntelligence(actor.tenantId, `supplier-admin-invite:${record.id}`, invite)]);
  await saveSupplierSnapshot(context.db, context.show, context.authority.actor.id, "supplier.enrollment_invited", `The producer opened separate controlled access for ${command.name}. The supplier must accept admission and publish its own sources. No outreach, verification or purchase is claimed.`);
  return { record, message: "Separate supplier access opened with a fixed expiry. The supplier must independently accept admission." };
}
async function publish(context: AdminContext, command: Exclude<SupplierAdminCommand, { type: "invite" | "request_quotes" | "negotiate" | "accept_quote" | "reserve" | "release" | "revoke" }>) {
  const supplierId = command.supplierId;
  if (command.type === "admit") {
    ownSupplier(context, supplierId); const prior = latestRecord<Enrollment>(context.records, supplierId, "enrollment");
    if (!prior || prior.id !== command.enrollmentId || prior.data.status !== "invited" || prior.data.ownerActorId !== context.authority.actor.id || revoked(context.records, prior.id)) deny("SUPPLIER_ADMISSION_CHANGED", "Use this supplier's exact unaccepted invitation.");
    requireOriginalOwner(context, supplierId, prior!);
    await requireAdminAuthority(context.db, { actor: prior!.access.actor, sessionHash: prior!.access.sessionHash }, prior!.access.expiresAt, "producer");
    const record = await appendAdminRecord<Enrollment>(context, supplierId, "enrollment", { ...prior!.data, status: "admitted", previousId: prior!.id, detail: command.detail });
    await saveSupplierSnapshot(context.db, context.show, context.authority.actor.id, "supplier.admission_accepted", `${prior!.data.name} separately accepted controlled supplier admission. Declared identity is not external identity verification, and actual merchant checkout remains unavailable.`);
    return { record, message: "Supplier admission accepted by its separate owner. Publish owned inventory, a signing key and terms next." };
  }
  const enrollment = requireOwner(context, supplierId);
  let record: AdminRecord;
  if (command.type === "rotate_key") {
    const prior = latestRecord<SupplierKey>(context.records, supplierId, "key");
    if ((prior?.id ?? null) !== command.previousKeyId) deny("SUPPLIER_KEY_CHANGED", "Review the current signing-key edition before rotating it.");
    const keys = generateSupplierKey(); record = await appendAdminRecord<SupplierKey>(context, supplierId, "key", { publicKey: keys.publicKey, fingerprint: keys.fingerprint, algorithm: "Ed25519", previousId: prior?.id ?? null });
    await context.db.query("INSERT INTO on_supplier_admin_keys(tenant_id,id,private_cipher) VALUES($1,$2,$3)", [context.show.tenantId, record.id, sealIntelligence(context.show.tenantId, `supplier-admin-private:${record.id}`, { privateKey: keys.privateKey })]);
  } else if (command.type === "inventory") {
    const prior = currentInventory(context.records, supplierId, command.unitId);
    if ((prior?.id ?? null) !== command.previousId) deny("SUPPLIER_INVENTORY_CHANGED", "Review this exact unit's current inventory edition before replacing it.");
    if (context.records.some(value => value.kind === "inventory" && value.supplierId !== supplierId && (value.data as InventoryEdition).unitId === command.unitId) || context.show.offers.some(value => value.supplierId !== supplierId && value.unitId === command.unitId)) deny("SUPPLIER_INVENTORY_OWNERSHIP", "This unit identity already belongs to another enrolled supplier in this production.", 403);
    const units = new Set(context.records.filter(value => value.supplierId === supplierId && value.kind === "inventory").map(value => (value.data as InventoryEdition).unitId));
    if (!prior && units.size >= 24) deny("SUPPLIER_INVENTORY_LIMIT", "This supplier supports twenty-four individually identified units.");
    if (Date.parse(command.availableUntil) <= Date.parse(command.availableFrom) || Date.parse(command.availableFrom) < Date.parse(context.show.clock) || Date.parse(command.availableUntil) > Date.parse(context.show.accessUntil) || command.qualifiedDriver === true && !command.driverEvidence || command.conditionVerified === true && !command.conditionEvidence) deny("SUPPLIER_INVENTORY_INVALID", "Review a future availability window and source evidence for each positive driver or condition claim.", 400);
    const { type: _type, confirmed: _confirmed, supplierId: _supplierId, ...data } = command; record = await appendAdminRecord<InventoryEdition>(context, supplierId, "inventory", data);
  } else if (command.type === "terms") {
    const inventory = recordById<InventoryEdition>(context.records, command.inventoryId, "inventory", supplierId), prior = currentTerms(context.records, supplierId, inventory.data.unitId);
    if (currentInventory(context.records, supplierId, inventory.data.unitId)?.id !== inventory.id || (prior?.id ?? null) !== command.previousId) deny("SUPPLIER_TERMS_CHANGED", "Publish terms from the exact current inventory and prior terms edition.");
    if (Date.parse(command.earliestDelivery) < Math.max(Date.parse(inventory.data.availableFrom), Date.parse(context.show.clock)) || Date.parse(command.latestDelivery) < Date.parse(command.earliestDelivery) || Date.parse(command.latestDelivery) >= Date.parse(inventory.data.availableUntil) || Date.parse(command.scenarioDeadline) <= Date.parse(context.show.clock) || Date.parse(command.scenarioDeadline) > Date.parse(command.earliestDelivery)) deny("SUPPLIER_TERMS_INVALID", "Terms need a current ordering deadline and delivery window inside this unit's owned availability.", 400);
    const { type: _type, confirmed: _confirmed, supplierId: _supplierId, validForMinutes, ...data } = command; record = await appendAdminRecord<TermEdition>(context, supplierId, "terms", { ...data, validUntil: expiry(context, validForMinutes) });
  } else {
    const inventory = recordById<InventoryEdition>(context.records, command.inventoryId, "inventory", supplierId), terms = recordById<TermEdition>(context.records, command.termsId, "terms", supplierId), key = currentKey(context.records, supplierId);
    if (currentInventory(context.records, supplierId, inventory.data.unitId)?.id !== inventory.id || currentTerms(context.records, supplierId, inventory.data.unitId)?.id !== terms.id || terms.data.inventoryId !== inventory.id || key.id !== command.keyId) deny("SUPPLIER_MANDATE_SOURCE_CHANGED", "Review the exact current inventory, terms and signing key before delegating bounded negotiation.");
    currentTime(context, terms.data.validUntil);
    if (command.bounds.feeMaxMinor > terms.data.feeMinor || command.bounds.depositMaxMinor > terms.data.depositMinor || Date.parse(command.bounds.earliestDelivery) < Date.parse(terms.data.earliestDelivery) || Date.parse(command.bounds.latestDelivery) > Date.parse(terms.data.latestDelivery)) deny("SUPPLIER_MANDATE_EXPANDED", "A supplier negotiation mandate can narrow only its published price, deposit and delivery terms.", 400);
    record = await appendAdminRecord<SupplierMandate>(context, supplierId, "supplier_mandate", { enrollmentId: enrollment.id, keyId: key.id, inventoryId: inventory.id, termsId: terms.id, bounds: command.bounds, expiresAt: expiry(context, command.validForMinutes, terms.data.validUntil), detail: command.detail });
    await chain(context, supplierId, record.id);
  }
  if (command.type !== "supplier_mandate") {
    invalidateFutureOffers(context, supplierId);
    await saveSupplierSnapshot(context.db, context.show, context.authority.actor.id, "supplier." + command.type + "_edition", `${enrollment.data.name} published its own immutable ${command.type.replaceAll("_", " ")} edition. Earlier signatures and commitments remain on their original sources.`);
  }
  return { record, message: command.type === "supplier_mandate" ? "Supplier-only negotiation mandate saved with exact bounds and fixed expiry. Producer review is separate." : "New immutable supplier edition saved. Earlier quotes and commitments remain retained." };
}
async function requestQuotes(context: AdminContext, command: Extract<SupplierAdminCommand, { type: "request_quotes" }>) {
  producer(context);
  if (command.reviewDigest !== reviewDigest(context)) deny("SUPPLIER_ADMIN_REVIEW_CHANGED", "Review current supplier sources, retained obligations and the production before this request.");
  if (context.show.commercialProtocol !== 2 || context.show.cancellationDecision?.mode === "cancel_show") deny("SUPPLIER_PROGRAM_UNAVAILABLE", "This production cannot admit a new supplier request under its current commercial program.");
  const source = await chain(context, command.supplierId, command.supplierMandateId);
  const pending = context.records.filter(record => record.supplierId === command.supplierId && record.kind === "rfq" && !revoked(context.records, record.id) && Date.parse((record.data as ReviewedRfq).expiresAt) > Date.parse(context.now) && !context.records.some(value => value.kind === "acceptance" && (value.data as QuoteAcceptance).rfqId === record.id));
  if (pending.some(record => (record.data as ReviewedRfq).sourceDigest === supplierRecoveryBasis(context.show))) deny("SUPPLIER_RFQ_PENDING", "Read or finish the original pending request before creating another for these same sources.");
  const record = await appendAdminRecord<ReviewedRfq>(context, command.supplierId, "rfq", { enrollmentId: source.enrollment.id,
    supplierMandateId: source.mandate.id, inventoryId: source.inventory.id, termsId: source.terms.id, keyId: source.key.id,
    bounds: command.bounds, sourceDigest: supplierRecoveryBasis(context.show), reviewedRevision: context.show.revision,
    expiresAt: expiry(context, command.validForMinutes, source.mandate.data.expiresAt, source.terms.data.validUntil, source.mandate.access.expiresAt), detail: command.detail });
  await requireRfq(context, command.supplierId, record.id);
  return { record, message: "Producer's separate bounded RFQ saved against exact current sources. A signed reply and a new plan approval remain separate." };
}
async function negotiate(context: AdminContext, command: Extract<SupplierAdminCommand, { type: "negotiate" }>) {
  producer(context); const source = await requireRfq(context, command.supplierId, command.rfqId);
  if (source.rfq.access.actor.id !== context.authority.actor.id || source.rfq.access.sessionHash !== context.authority.sessionHash || source.rfq.access.expiresAt !== context.expiresAt) deny("SUPPLIER_RFQ_OWNER", "Only the exact original reviewing producer access may request another bounded reply.", 403);
  if (context.records.some(value => value.kind === "acceptance" && (value.data as QuoteAcceptance).rfqId === command.rfqId)) deny("SUPPLIER_RFQ_CLOSED", "This request already supplied an admitted quote. It cannot authorize another commitment.");
  const rounds = context.records.filter(record => record.kind === "round" && (record.data as NegotiationRound).rfqId === command.rfqId);
  if ((rounds.at(-1)?.id ?? null) !== command.previousRoundId) deny("SUPPLIER_NEGOTIATION_CHANGED", "Review the original latest reply before another negotiation round.");
  if (rounds.length >= Math.min(source.rfq.data.bounds.maxRounds, source.mandate.data.bounds.maxRounds)) deny("SUPPLIER_NEGOTIATION_ROUNDS", "Both mandates' fixed round limit has been reached. Earlier replies remain retained.");
  const bounds = source.rfq.data.bounds;
  if (command.feeMinor < bounds.feeMinMinor || command.feeMinor > bounds.feeMaxMinor || command.depositMinor < bounds.depositMinMinor || command.depositMinor > bounds.depositMaxMinor || Date.parse(command.deliveryAt) < Date.parse(bounds.earliestDelivery) || Date.parse(command.deliveryAt) > Date.parse(bounds.latestDelivery)) deny("SUPPLIER_NEGOTIATION_OUTSIDE_MANDATE", "This counter request exceeds the producer's separately reviewed price, deposit or delivery bounds.", 400);
  const roundId = randomUUID(), signer = await privateKey(context, source.key.id), round = rounds.length + 1;
  const binding: AdminQuoteSource = { supplierId: command.supplierId, enrollmentId: source.enrollment.id, inventoryId: source.inventory.id, termsId: source.terms.id,
    keyId: source.key.id, supplierMandateId: source.mandate.id, rfqId: source.rfq.id, roundId, publicKey: source.key.data.publicKey,
    keyFingerprint: source.key.data.fingerprint, supplierMandateDigest: digest(source.mandate), rfqDigest: digest(source.rfq), inventoryDigest: digest(source.inventory), termsDigest: digest(source.terms), source: "declared_controlled_supplier" };
  const agreed = negotiateBounds(source.mandate.data.bounds, bounds, command, source.terms.data), inventory = source.inventory.data;
  const committed = await supplierUnitCommitted(context.db, context.show.tenantId, command.supplierId, inventory.unitId, agreed?.deliveryAt ?? source.terms.data.earliestDelivery, context.show.accessUntil);
  let outcome: NegotiationRound["outcome"];
  if (!agreed || !inventory.available || committed || !inventory.compatible || inventory.qualifiedDriver !== true || inventory.conditionVerified !== true || Date.parse(inventory.availableUntil) < Date.parse(context.show.accessUntil)) {
    const code = !inventory.available ? "UNIT_UNAVAILABLE" : committed ? "UNIT_ALREADY_COMMITTED" : !inventory.compatible || inventory.qualifiedDriver !== true || inventory.conditionVerified !== true || Date.parse(inventory.availableUntil) < Date.parse(context.show.accessUntil) ? "EVIDENCE_MISSING" : "BOUNDS_DO_NOT_OVERLAP";
    const message = code === "UNIT_UNAVAILABLE" ? "The supplier's own current inventory withdraws this unit." : code === "UNIT_ALREADY_COMMITTED" ? "An original rental still owns this exact unit's overlapping window. New terms do not release it." : code === "EVIDENCE_MISSING" ? "Current compatibility, qualified-driver or condition evidence is missing. No capacity was invented." : "The separate mandates' fee, deposit or delivery bounds do not overlap.";
    outcome = { kind: "declined", decline: signManagedDecline({ id: randomUUID(), tenantId: context.show.tenantId, supplierId: command.supplierId, rfqId: source.rfq.id, round, code, message, at: context.now, source: binding }, signer) };
  } else {
    const revision = Number((await context.db.query<{ revision: number }>("SELECT coalesce(max(revision),0)+1 AS revision FROM on_supplier_quotes WHERE tenant_id=$1 AND supplier_id=$2", [context.show.tenantId, command.supplierId])).rows[0]!.revision);
    const offer: Omit<SupplierOffer, "serviceQuote"> = { id: `${command.supplierId}-${inventory.unitId}`, supplierId: command.supplierId, supplier: source.enrollment.data.name,
      initials: source.enrollment.data.name.split(/\s+/).map(word => word[0]).join("").slice(0, 3).toUpperCase(), unitId: inventory.unitId, revision,
      feeMinor: agreed.feeMinor, depositMinor: agreed.depositMinor, deliveryAt: agreed.deliveryAt, expiresAt: source.terms.data.scenarioDeadline,
      compatible: inventory.compatible, qualifiedDriver: inventory.qualifiedDriver, conditionVerified: inventory.conditionVerified, status: "quoted",
      source: "sample", terms: `${source.terms.data.reference}. ${source.terms.data.detail} Declared controlled supplier; actual merchant checkout unavailable. ${source.terms.data.cancellation}` };
    const content = { schemaVersion: 1 as const, id: randomUUID(), tenantId: context.show.tenantId, supplierId: command.supplierId, revision, issuedAt: context.now,
      validUntil: expiry(context, 15, source.rfq.data.expiresAt, source.mandate.data.expiresAt, source.terms.data.validUntil), offer,
      equipment: { model: inventory.model, capabilityEvidence: inventory.capabilityEvidence, driverEvidence: inventory.driverEvidence, conditionEvidence: inventory.conditionEvidence },
      cancellation: source.terms.data.cancellation, source: "controlled_fixture" as const, adminSource: binding };
    const quote = signManagedQuote({ ...content, termsDigest: digest(content) }, signer);
    await context.db.query("INSERT INTO on_supplier_quotes(id,tenant_id,supplier_id,revision,valid_until,document) VALUES($1,$2,$3,$4,$5,$6)", [quote.id, quote.tenantId, quote.supplierId, revision, quote.validUntil, quote]);
    outcome = { kind: "quote", quote };
  }
  // Recheck both original mandates at the last database boundary. Signing never extends either session.
  await requireRfq(context, command.supplierId, command.rfqId);
  const record = await appendAdminRecord<NegotiationRound>(context, command.supplierId, "round", { rfqId: source.rfq.id, round, request: { feeMinor: command.feeMinor, depositMinor: command.depositMinor, deliveryAt: command.deliveryAt }, outcome }, roundId);
  return { record, message: outcome.kind === "quote" ? "Signed bounded quote saved. Review it before admitting it to the real recovery planner." : "Signed supplier refusal saved. It does not reserve capacity or replace an earlier reply." };
}
async function acceptQuote(context: AdminContext, command: Extract<SupplierAdminCommand, { type: "accept_quote" }>) {
  producer(context); await requireRfq(context, command.supplierId, command.rfqId);
  const rfq = recordById<ReviewedRfq>(context.records, command.rfqId, "rfq", command.supplierId);
  if (rfq.access.sessionHash !== context.authority.sessionHash || rfq.access.actor.id !== context.authority.actor.id || rfq.access.expiresAt !== context.expiresAt) deny("SUPPLIER_RFQ_OWNER", "Use the original exact producer access that reviewed this request.", 403);
  if (context.records.some(value => value.kind === "acceptance" && (value.data as QuoteAcceptance).rfqId === command.rfqId)) deny("SUPPLIER_RFQ_CLOSED", "This exact request already admitted one quote. Read its original receipt.");
  const record = recordById<NegotiationRound>(context.records, command.roundId, "round", command.supplierId), outcome = record.data.outcome;
  if (record.data.rfqId !== command.rfqId || outcome.kind !== "quote" || outcome.quote.termsDigest !== command.quoteDigest || !verifyManagedQuoteSignature(outcome.quote)) deny("SUPPLIER_QUOTE_NOT_AUTHENTICATED", "Review this request's exact signed quote before admitting it.");
  if (outcome.kind !== "quote") deny("SUPPLIER_QUOTE_REQUIRED", "A signed decline is not an available quotation.");
  const quote = (outcome as Extract<NegotiationRound["outcome"], { kind: "quote" }>).quote; currentTime(context, quote.validUntil);
  if (await supplierUnitCommitted(context.db, context.show.tenantId, command.supplierId, quote.offer.unitId, quote.offer.deliveryAt, context.show.accessUntil)) deny("UNIT_ALREADY_COMMITTED", "The original unit is now committed elsewhere. Its old obligation cannot be overwritten.");
  const offer: SupplierOffer = { ...quote.offer, serviceQuote: { id: quote.id, termsDigest: quote.termsDigest, issuedAt: quote.issuedAt, validUntil: quote.validUntil, serviceId: `managed-local:${command.supplierId}`, source: "authenticated_fixture_service", adminSource: quote.adminSource! } };
  context.show.offers = [...context.show.offers.filter(value => value.id !== offer.id), offer]; context.show.state = "standby"; context.show.goReportId = null;
  const accepted = await appendAdminRecord<QuoteAcceptance>(context, command.supplierId, "acceptance", { quoteId: quote.id, rfqId: command.rfqId, roundId: command.roundId, sourceDigest: planningDigest(context.show) });
  context.show.sources.push({ id: quote.id, title: `${quote.offer.supplier} signed controlled quote · edition ${quote.revision}`, source: "sample", recordedAt: quote.issuedAt,
    detail: `Owned unit ${quote.offer.unitId}; RFQ ${command.rfqId}; inventory ${quote.adminSource!.inventoryId}; terms ${quote.adminSource!.termsId}; signing key ${quote.adminSource!.keyFingerprint}. Declared controlled identity and evidence. No merchant purchase or physical fulfillment is claimed.` });
  await saveSupplierSnapshot(context.db, context.show, context.authority.actor.id, "supplier.managed_quote_admitted", "A separately reviewed signed quote entered the actual production offers. Generate real engine candidates and approve a distinct plan before reserving it; actual merchant checkout remains unavailable.");
  await requireRfq(context, command.supplierId, command.rfqId, false); currentTime(context, quote.validUntil);
  return { record: accepted, message: "Signed quote admitted to the actual engine and reservation flow. A separate valid plan approval is still required; actual checkout is unavailable." };
}
async function revoke(context: AdminContext, command: Extract<SupplierAdminCommand, { type: "revoke" }>) {
  const target = recordById(context.records, command.targetId, command.targetKind, command.supplierId);
  if (command.targetKind === "key" || command.targetKind === "supplier_mandate") requireOwner(context, command.supplierId);
  else if (command.targetKind === "rfq") { producer(context); if (target.access.sessionHash !== context.authority.sessionHash || target.access.expiresAt !== context.expiresAt) deny("SUPPLIER_RFQ_OWNER", "Only the original exact producer access may revoke this request.", 403); }
  else if (context.authority.actor.supplierId) {
    requireOriginalOwner(context, command.supplierId, target as AdminRecord<Enrollment>);
  } else producer(context);
  if (revoked(context.records, target.id)) deny("SUPPLIER_SOURCE_ALREADY_REVOKED", "This original source is already revoked. Read its retained history.");
  const record = await appendAdminRecord<Revocation>(context, command.supplierId, "revocation", { targetId: target.id, targetKind: command.targetKind, reason: command.reason });
  invalidateFutureOffers(context, command.supplierId);
  await saveSupplierSnapshot(context.db, context.show, context.authority.actor.id, "supplier.source_revoked", "Current supplier authority was revoked for future instructions. Every original quote, signature, financial result, unknown outcome and rental obligation remains retained.");
  return { record, message: "Future authority revoked. Historical signatures still verify and original commitments remain separate." };
}
async function workspace(context: AdminContext): Promise<AdminWorkspace> {
  const supplier = Boolean(context.authority.actor.supplierId), ids = [...new Set(context.records.filter(record => record.kind === "enrollment").map(record => record.supplierId))].filter(id => !supplier || id === context.authority.actor.supplierId);
  const cards: SupplierAdminCard[] = [];
  for (const id of ids) {
    const enrollment = latestRecord<Enrollment>(context.records, id, "enrollment")!, key = latestRecord<SupplierKey>(context.records, id, "key"), inventory = latestRecord<InventoryEdition>(context.records, id, "inventory"), terms = inventory ? currentTerms(context.records, id, inventory.data.unitId) : null;
    const blockers: string[] = [enrollment.data.merchant.message];
    let status: SupplierAdminCard["status"] = enrollment.data.status;
    try {
      if (enrollment.data.status === "invited") {
        if (context.records.some(value => value.supplierId === id && value.kind === "revocation" && (value.data as Revocation).targetKind === "enrollment")) deny("SUPPLIER_NOT_ADMITTED", "This original invitation was revoked. It cannot admit new supplier authority.", 403);
        currentTime(context, enrollment.data.ownerExpiresAt);
      } else admitted(context.records, id);
      await accessCurrent(context.db, enrollment.access);
    } catch (error) { if (!(error instanceof DomainError)) throw error; status = error.code === "SUPPLIER_NOT_ADMITTED" ? "revoked" : "expired"; blockers.push(error.message); }
    if (!key || revoked(context.records, key.id)) blockers.push("A current supplier signing key is required.");
    if (!inventory || !inventory.data.available) blockers.push("No current available owned inventory edition.");
    if (!terms || terms.data.inventoryId !== inventory?.id || Date.parse(terms.data.validUntil) <= Date.parse(context.now) || Date.parse(terms.data.scenarioDeadline) <= Date.parse(context.show.clock)) blockers.push("Current unexpired terms are required for this inventory edition.");
    const mandates: SupplierAdminCard["mandates"] = [];
    for (const mandate of context.records.filter(record => record.kind === "supplier_mandate" && record.supplierId === id).slice(-24) as AdminRecord<SupplierMandate>[]) {
      let state = "active"; try { await chain(context, id, mandate.id); } catch (error) { if (!(error instanceof DomainError)) throw error; state = revoked(context.records, mandate.id) ? "revoked" : Date.parse(mandate.data.expiresAt) <= Date.parse(context.now) ? "expired" : "source_changed"; }
      mandates.push({ id: mandate.id, data: mandate.data, active: state === "active", status: state });
    }
    const rfqs: SupplierAdminCard["rfqs"] = [];
    for (const rfq of context.records.filter(record => record.kind === "rfq" && record.supplierId === id).slice(-24) as AdminRecord<ReviewedRfq>[]) {
      let state = "pending"; const accepted = context.records.find(value => value.kind === "acceptance" && (value.data as QuoteAcceptance).rfqId === rfq.id);
      try { await requireRfq(context, id, rfq.id); } catch (error) { if (!(error instanceof DomainError)) throw error; state = revoked(context.records, rfq.id) ? "revoked" : Date.parse(rfq.data.expiresAt) <= Date.parse(context.now) ? "expired" : "source_changed"; }
      if (accepted) {
        const quoteId = (accepted.data as QuoteAcceptance).quoteId, projected = context.show.offers.find(offer => offer.serviceQuote?.id === quoteId);
        state = revoked(context.records, rfq.id) ? "admitted_revoked" : Date.parse(rfq.data.expiresAt) <= Date.parse(context.now) ? "admitted_expired" : projected?.serviceQuote?.reviewRequired ? "admitted_source_changed" : "admitted";
      }
      const rounds = (context.records.filter(value => value.kind === "round" && (value.data as NegotiationRound).rfqId === rfq.id) as AdminRecord<NegotiationRound>[]).map(value => ({ id: value.id, data: value.data, verified: value.data.outcome.kind === "quote" ? verifyManagedQuoteSignature(value.data.outcome.quote) : verifyManagedDecline(value.data.outcome.decline), accepted: Boolean(accepted && (accepted.data as QuoteAcceptance).roundId === value.id) }));
      rfqs.push({ id: rfq.id, data: rfq.data, status: state, roundLimit: Math.min(rfq.data.bounds.maxRounds, recordById<SupplierMandate>(context.records, rfq.data.supplierMandateId, "supplier_mandate", id).data.bounds.maxRounds), rounds });
    }
    cards.push({ id, name: enrollment.data.name, status, enrollmentId: enrollment.id, enrollment: enrollment.data,
      key: key ? { ...key.data, id: key.id, revision: key.revision, active: !revoked(context.records, key.id) } : null,
      keyHistory: (context.records.filter(record => record.kind === "key" && record.supplierId === id) as AdminRecord<SupplierKey>[]).map(record => ({ id: record.id, fingerprint: record.data.fingerprint, revision: record.revision, status: revoked(context.records, record.id) ? "revoked" : key?.id === record.id ? "active" : "retired" })),
      inventory: inventory ? { ...inventory.data, id: inventory.id, revision: inventory.revision } : null,
      terms: terms ? { ...terms.data, id: terms.id, revision: terms.revision } : null,
      units: [...new Set(context.records.filter(record => record.kind === "inventory" && record.supplierId === id).map(record => (record.data as InventoryEdition).unitId))].map(unitId => {
        const unit = currentInventory(context.records, id, unitId)!, current = currentTerms(context.records, id, unitId);
        return { inventory: { ...unit.data, id: unit.id, revision: unit.revision }, terms: current ? { ...current.data, id: current.id, revision: current.revision } : null };
      }), mandates, rfqs, blockers,
      retained: (context.show.rentalExecutions ?? []).filter(value => value.supplierId === id).map(value => ({ id: value.id, unitId: value.unitId, planVersion: value.planVersion, state: value.state, feeMinor: value.feeMinor, depositMinor: value.depositMinor })) });
  }
  const historyIds = (await context.db.query<{ command_id: string }>("SELECT command_id FROM on_supplier_admin_commands WHERE tenant_id=$1 AND actor_id=$2 AND session_hash=$3 AND session_expiry=$4::timestamptz ORDER BY created_at DESC,command_id LIMIT 24", [context.show.tenantId, context.authority.actor.id, context.authority.sessionHash, context.expiresAt])).rows;
  const history = (await Promise.all(historyIds.map(row => readAdminReceipt(context, row.command_id)))).filter((value): value is NonNullable<typeof value> => Boolean(value));
  return { tenantId: context.show.tenantId, actorId: context.authority.actor.id, sessionFingerprint: adminFingerprint(context.authority.sessionHash), expiresAt: context.expiresAt, serverAt: context.now, revision: context.show.revision, clock: context.show.clock, accessUntil: context.show.accessUntil,
    role: supplier ? "supplier" : "producer", supplierId: context.authority.actor.supplierId ?? null, reviewDigest: reviewDigest(context), cards, history,
    originalServices: supplier ? [] : context.show.offers.filter(value => (supplierIds as readonly string[]).includes(value.supplierId)).map(({ supplierId, supplier, unitId, feeMinor, depositMinor }) => ({ supplierId, supplier, unitId, feeMinor, depositMinor })),
    currentPlan: supplier || !context.show.approvedPlan ? null : (() => { const plan = context.show.approvedPlan!, candidate = context.show.runs.flatMap(run => run.candidates).find(value => value.digest === plan.digest), offer = context.show.offers.find(value => value.id === candidate?.patch.offerId); return { digest: plan.digest, offerId: offer?.id ?? "", planVersion: context.show.planVersion, quoteId: offer?.serviceQuote?.id ?? null }; })() };
}
export async function readSupplierAdminWorkspace(authority: AdminAuthority) { return adminTransaction(authority, false, workspace); }
export async function recoverSupplierAdminCommand(authority: AdminAuthority, commandId: string): Promise<AdminResult> {
  return adminTransaction(authority, false, async context => {
    const receipt = await readAdminReceipt(context, commandId); if (!receipt) deny("SUPPLIER_ADMIN_COMMAND_NOT_FOUND", "This exact access has no original command receipt with that identity.", 404);
    const invite = await invitation(context, receipt!); return { workspace: await workspace(context), receipt: receipt!, replayed: true, ...(invite ? { invitation: invite } : {}) };
  });
}
export async function executeSupplierAdminCommand(authority: AdminAuthority, instruction: SupplierAdminEnvelope): Promise<AdminResult> {
  const parsed = supplierAdminEnvelopeSchema.safeParse(instruction);
  if (!parsed.success || digest(parsed.data) !== digest(instruction)) deny("SUPPLIER_ADMIN_COMMAND_INVALID", "The instruction does not match the exact reviewed supplier administration contract.", 400);
  const envelope = parsed.data!, requestDigest = digest(envelope);
  return adminTransaction(authority, true, async context => {
    if (envelope.sessionFingerprint !== adminFingerprint(authority.sessionHash) || envelope.expiresAt !== context.expiresAt) deny("SUPPLIER_ADMIN_REVIEW_ACCESS", "Read this exact access and its full fixed expiry before submitting an instruction.");
    const prior = await readAdminReceipt(context, envelope.commandId, requestDigest);
    if (prior) { const invite = await invitation(context, prior); return { workspace: await workspace(context), receipt: prior, replayed: true, ...(invite ? { invitation: invite } : {}) }; }
    await context.db.query("SAVEPOINT supplier_admin_action");
    let result: { record: { id: string }; message: string } | null = null, refusal: DomainError | null = null;
    try {
      if (context.show.revision !== envelope.expectedRevision) deny("STALE_REVISION", "The production changed. Review its current sources before issuing a new instruction.");
      const command = envelope.command;
      if (command.type === "release") {
        producer(context);
        const execution = await (await import("../supplier-service")).changeReservation(context.db, context.show, context.authority.actor, command.supplierId, { type: "release", executionId: command.executionId, expectedRevision: context.show.revision });
        result = { record: execution, message: "The original reservation service released this exact unpaid provisional hold. All original rental and financial history remains retained." };
      } else if (command.type === "reserve") {
        producer(context);
        const execution = await (await import("../supplier-service")).hold(context.db, context.show, context.authority.actor, command.supplierId, { type: "hold", quoteId: command.quoteId, planDigest: command.planDigest, expectedRevision: context.show.revision, acceptCaptureTerms: true, producerAccess: { sessionHash: context.authority.sessionHash, expiresAt: context.expiresAt } });
        result = { record: execution, message: "The actual reservation service saved this exact provisional unit hold. No payment, merchant receipt or delivery was created; actual checkout remains unavailable." };
      } else result = command.type === "invite" ? await openEnrollment(context, command) : command.type === "request_quotes" ? await requestQuotes(context, command) : command.type === "negotiate" ? await negotiate(context, command) : command.type === "accept_quote" ? await acceptQuote(context, command) : command.type === "revoke" ? await revoke(context, command) : await publish(context, command);
      await requireAdminAuthority(context.db, authority, context.expiresAt);
      await context.db.query("RELEASE SAVEPOINT supplier_admin_action");
    } catch (error) {
      if (!(error instanceof DomainError) || error.status >= 500 || error.status === 401) throw error;
      await context.db.query("ROLLBACK TO SAVEPOINT supplier_admin_action");
      context.show = (await context.db.query<{ snapshot: import("@/domain/contracts").ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1", [authority.actor.tenantId])).rows[0]!.snapshot;
      context.records = await readAdminRecords(context.db, authority.actor.tenantId); refusal = error;
    }
    const receipt = { commandId: envelope.commandId, action: envelope.command.type, requestDigest, recordId: result?.record.id ?? envelope.commandId, revision: context.show.revision, at: context.now,
      status: refusal ? "refused" as const : "completed" as const, code: refusal?.code ?? null, message: refusal?.message ?? result!.message };
    await saveAdminReceipt(context, receipt); const invite = await invitation(context, receipt);
    return { workspace: await workspace(context), receipt, replayed: false, ...(invite ? { invitation: invite } : {}) };
  });
}
