import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { DomainError, type Actor, type ShowSnapshot } from "@/domain/contracts";
import { digest } from "@/domain/hash";
import { env } from "./env";
import { SESSION_ADMISSION_SCOPE } from "./session-admission";
import { insertProducerRehearsal, sessionTokenHash as tokenHash } from "./session-records";
import { projectExecutionMilestones } from "./crew/readiness";
import { supplierMigration } from "./migrations/suppliers-v3";
import { commerceMigration } from "./migrations/commerce-v4";
import { rehearsalsMigration } from "./migrations/rehearsals-v5";
import { intelligenceMigration } from "./migrations/intelligence-v6";
import { mediaMigration } from "./migrations/media-v7";
import { sourcesMigration } from "./migrations/sources-v8";
import { settlementMigration } from "./migrations/settlement-v9";
import { payoutsMigration } from "./migrations/payouts-v10";
import { wrapMigration } from "./migrations/wrap-v11";
import { tourMigration } from "./migrations/tour-v12";
import { disruptionsMigration } from "./migrations/disruptions-v13";
import { rentalCloseoutMigration } from "./migrations/rental-closeout-v14";
import { rentalCloseoutReadsMigration } from "./migrations/rental-closeout-reads-v15";
import { supplierRecoveryMigration } from "./migrations/supplier-recovery-v16";
import { audienceMigration } from "./migrations/audience-v17";
import { intelligenceContinuityMigration } from "./migrations/intelligence-continuity-v18";
import { planConsentsMigration } from "./migrations/plan-consents-v19";
import { currentRentalExecution, supplierIds, type SupplierId } from "@/domain/supplier-contracts";

const shared = globalThis as typeof globalThis & { openingNightPool?: Pool; openingNightMigration?: Promise<void> };
export const pool = shared.openingNightPool ??= new Pool({ connectionString: env.databaseUrl, max: 6, connectionTimeoutMillis: 6000, idleTimeoutMillis: 30000 });
export async function migrate() {
  if (!shared.openingNightMigration) shared.openingNightMigration = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(4105001)");
      await client.query("CREATE TABLE IF NOT EXISTS on_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const applied = await client.query("SELECT version FROM on_schema_migrations WHERE version=1");
      if (!applied.rowCount) { await client.query(`
        CREATE TABLE IF NOT EXISTS on_shows (tenant_id uuid PRIMARY KEY, snapshot jsonb NOT NULL, revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS on_sessions (token_hash text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE, actor jsonb NOT NULL, expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS on_commands (tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE, command_id uuid NOT NULL, payload_hash text NOT NULL, result_revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, command_id));
        CREATE TABLE IF NOT EXISTS on_events (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE, revision integer NOT NULL, event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
        CREATE INDEX IF NOT EXISTS on_events_tenant_revision ON on_events(tenant_id, revision);
        CREATE INDEX IF NOT EXISTS on_sessions_expiry ON on_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS on_session_admissions (id uuid PRIMARY KEY, scope text NOT NULL, created_at timestamptz NOT NULL);
        CREATE INDEX IF NOT EXISTS on_session_admissions_scope_created ON on_session_admissions(scope, created_at);
      `);
      await client.query("INSERT INTO on_schema_migrations(version) VALUES(1)"); }
      const durable = await client.query("SELECT version FROM on_schema_migrations WHERE version=2");
      if (!durable.rowCount) {
        await client.query(`
          CREATE TABLE on_jobs (
            id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
            kind text NOT NULL, semantic_key text NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL,
            status text NOT NULL CHECK(status IN ('queued','running','waiting','complete','needs_attention')),
            run_after timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
            max_attempts integer NOT NULL DEFAULT 12 CHECK(max_attempts BETWEEN 1 AND 30),
            lease_id uuid, lease_until timestamptz, last_code text, created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,kind,semantic_key)
          );
          CREATE INDEX on_jobs_ready ON on_jobs(run_after,created_at) WHERE status IN ('queued','waiting','running');
          CREATE INDEX on_jobs_tenant ON on_jobs(tenant_id,created_at);
          CREATE TABLE on_webhook_inbox (
            seller text NOT NULL CHECK(seller IN ('venue','brightline')), event_id text NOT NULL, body_hash text NOT NULL,
            event_type text NOT NULL, resource_kind text, resource_id text NOT NULL, hints jsonb NOT NULL,
            tenant_id uuid REFERENCES on_shows(tenant_id) ON DELETE CASCADE, root_intent_id uuid,
            status text NOT NULL CHECK(status IN ('queued','unmatched','conflict','processed','needs_attention')),
            transport text NOT NULL CHECK(transport IN ('paypal_https','local_fixture')),
            received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, last_code text,
            PRIMARY KEY(seller,event_id)
          );
          CREATE INDEX on_webhook_inbox_tenant ON on_webhook_inbox(tenant_id,received_at);
          CREATE TABLE on_resource_observations (
            id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
            seller text NOT NULL, root_intent_id uuid NOT NULL, kind text NOT NULL, provider_id text NOT NULL,
            status text NOT NULL, amount_minor bigint, currency text, parent_id text, refunded_minor bigint, observed_at timestamptz NOT NULL,
            transport text NOT NULL CHECK(transport IN ('paypal_https','local_fixture')),
            UNIQUE(tenant_id,seller,kind,provider_id,observed_at)
          );
          CREATE INDEX on_resource_observations_latest ON on_resource_observations(tenant_id,seller,kind,provider_id,observed_at DESC);
          INSERT INTO on_events(id,tenant_id,revision,event)
            SELECT CASE WHEN value->>'id' ~ '^[a-fA-F0-9-]{36}$' THEN (value->>'id')::uuid ELSE md5(value->>'id')::uuid END,
              tenant_id,(value->>'revision')::integer,value
            FROM on_shows CROSS JOIN LATERAL jsonb_array_elements(snapshot->'events')
            WHERE value->>'type'='show.created' ON CONFLICT DO NOTHING;
        `);
        await client.query("INSERT INTO on_schema_migrations(version) VALUES(2)");
      }
      const suppliers = await client.query("SELECT version FROM on_schema_migrations WHERE version=3");
      if (!suppliers.rowCount) { await client.query(supplierMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(3)"); }
      const commerce = await client.query("SELECT version FROM on_schema_migrations WHERE version=4");
      if (!commerce.rowCount) { await client.query(commerceMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(4)"); }
      const rehearsals = await client.query("SELECT version FROM on_schema_migrations WHERE version=5");
      if (!rehearsals.rowCount) { await client.query(rehearsalsMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(5)"); }
      const intelligence = await client.query("SELECT version FROM on_schema_migrations WHERE version=6");
      if (!intelligence.rowCount) { await client.query(intelligenceMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(6)"); }
      const media = await client.query("SELECT version FROM on_schema_migrations WHERE version=7");
      if (!media.rowCount) { await client.query(mediaMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(7)"); }
      const sources = await client.query("SELECT version FROM on_schema_migrations WHERE version=8");
      if (!sources.rowCount) { await client.query(sourcesMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(8)"); }
      const settlement = await client.query("SELECT version FROM on_schema_migrations WHERE version=9");
      if (!settlement.rowCount) { await client.query(settlementMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(9)"); }
      const payouts = await client.query("SELECT version FROM on_schema_migrations WHERE version=10");
      if (!payouts.rowCount) { await client.query(payoutsMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(10)"); }
      const wrap = await client.query("SELECT version FROM on_schema_migrations WHERE version=11");
      if (!wrap.rowCount) { await client.query(wrapMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(11)"); }
      const tour = await client.query("SELECT version FROM on_schema_migrations WHERE version=12");
      if (!tour.rowCount) { await client.query(tourMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(12)"); }
      const disruptions = await client.query("SELECT version FROM on_schema_migrations WHERE version=13");
      if (!disruptions.rowCount) { await client.query(disruptionsMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(13)"); }
      const closeout = await client.query("SELECT version FROM on_schema_migrations WHERE version=14");
      if (!closeout.rowCount) { await client.query(rentalCloseoutMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(14)"); }
      const closeoutReads = await client.query("SELECT version FROM on_schema_migrations WHERE version=15");
      if (!closeoutReads.rowCount) { await client.query(rentalCloseoutReadsMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(15)"); }
      const supplierRecovery = await client.query("SELECT version FROM on_schema_migrations WHERE version=16");
      if (!supplierRecovery.rowCount) { await client.query(supplierRecoveryMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(16)"); }
      const audience = await client.query("SELECT version FROM on_schema_migrations WHERE version=17");
      if (!audience.rowCount) { await client.query(audienceMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(17)"); }
      const intelligenceContinuity = await client.query("SELECT version FROM on_schema_migrations WHERE version=18");
      if (!intelligenceContinuity.rowCount) { await client.query(intelligenceContinuityMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(18)"); }
      const planConsents = await client.query("SELECT version FROM on_schema_migrations WHERE version=19");
      if (!planConsents.rowCount) { await client.query(planConsentsMigration); await client.query("INSERT INTO on_schema_migrations(version) VALUES(19)"); }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); delete shared.openingNightMigration; throw error; }
    finally { client.release(); }
  })();
  return shared.openingNightMigration;
}
// HTTP always uses the fixed deployment scope. A server-only scope isolates database tests.
export async function createSession(existingToken?: string, admissionScope = SESSION_ADMISSION_SCOPE) {
  const existingActor = await getActor(existingToken);
  if (existingActor?.roles.includes("producer") && !existingActor.personId && !existingActor.executionId && existingToken) return { token: existingToken, show: await getShow(existingActor.tenantId), actor: existingActor, reused: true };
  await migrate(); const token = randomBytes(32).toString("base64url");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await insertProducerRehearsal(client, token, admissionScope);
    await client.query("COMMIT");
    return { token, show: created.show, actor: created.actor, reused: false };
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
export async function getActor(token: string | undefined): Promise<Actor | null> {
  if (!token || token.length > 150) return null; await migrate();
  const result = await pool.query<{ actor: Actor }>("SELECT actor FROM on_sessions WHERE token_hash=$1 AND expires_at>now()", [tokenHash(token)]);
  return result.rows[0]?.actor ?? null;
}
export async function getShow(tenantId: string): Promise<ShowSnapshot> {
  await migrate(); const result = await pool.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1", [tenantId]);
  if (!result.rows[0]) throw new DomainError("SHOW_NOT_FOUND", "This rehearsal has expired. Start a new session.", 404);
  return projectExecutionMilestones(result.rows[0].snapshot);
}
export async function createCrewCapability(actor: Actor, personId: string) {
  if (!actor.roles.includes("producer") || actor.personId || actor.executionId || actor.supplierId) throw new DomainError("ROLE_REQUIRED", "Only the producer can invite a controlled crew client.", 403);
  const show = await getShow(actor.tenantId);
  if (!show.resources.some(r => r.id === personId && r.kind === "person")) throw new DomainError("PERSON_NOT_FOUND", "This person is not on the roster.", 404);
  const token = randomBytes(32).toString("base64url");
  const crewActor: Actor = { id: `crew:${personId}:${randomUUID()}`, tenantId: actor.tenantId, roles: ["crew"], personId };
  await pool.query("INSERT INTO on_sessions(token_hash, tenant_id, actor, expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [tokenHash(token), actor.tenantId, crewActor]);
  return token;
}
export async function transactCommand(actor: Actor, id: string, expectedRevision: number, payload: unknown, transform: (show: ShowSnapshot) => ShowSnapshot, authorize?: (client: PoolClient) => Promise<void>, effects?: (client: PoolClient) => Promise<void>): Promise<{ show: ShowSnapshot; replayed: boolean }> {
  await migrate(); const payloadHash = digest({ actorId: actor.id, expectedRevision, payload }); const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ snapshot: ShowSnapshot }>("SELECT snapshot FROM on_shows WHERE tenant_id=$1 FOR UPDATE", [actor.tenantId]);
    const show = locked.rows[0]?.snapshot;
    if (!show) throw new DomainError("SHOW_NOT_FOUND", "This rehearsal no longer exists.", 404);
    if (authorize) await authorize(client);
    const previous = await client.query<{ payload_hash: string }>("SELECT payload_hash FROM on_commands WHERE tenant_id=$1 AND command_id=$2", [actor.tenantId, id]);
    if (previous.rows[0]) {
      if (previous.rows[0].payload_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "This command key was already used for different instructions.");
      await client.query("COMMIT"); return { show, replayed: true };
    }
    if (show.revision !== expectedRevision) throw new DomainError("STALE_REVISION", "Another action changed the production. Refresh and review the latest state.");
    if (payload && typeof payload === "object" && "type" in payload && payload.type === "approve" && "candidateId" in payload && typeof payload.candidateId === "string") await (await import("./supplier-recovery/approval")).requireSupplierTermsForApproval(client, show, payload.candidateId);
    const next = projectExecutionMilestones(transform(projectExecutionMilestones(show)));
    if (next.tenantId !== actor.tenantId || next.revision !== show.revision + 1) throw new Error("Invalid transactional snapshot transition");
    // Transactional effects run only for a new, current command. Replays and
    // rejected revisions can never revoke access or repeat another side effect.
    if (effects) await effects(client);
    await client.query("UPDATE on_shows SET snapshot=$2, revision=$3, updated_at=now() WHERE tenant_id=$1", [actor.tenantId, next, next.revision]);
    await client.query("INSERT INTO on_commands(tenant_id,command_id,payload_hash,result_revision) VALUES($1,$2,$3,$4)", [actor.tenantId, id, payloadHash, next.revision]);
    const oldEvents = new Set(show.events.map(e => e.id));
    for (const event of next.events.filter(e => !oldEvents.has(e.id))) await persistEvent(client, actor.tenantId, event);
    await client.query("COMMIT"); return { show: next, replayed: false };
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
async function persistEvent(client: PoolClient, tenantId: string, event: ShowSnapshot["events"][number]) {
  await client.query("INSERT INTO on_events(id,tenant_id,revision,event) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING", [event.id, tenantId, event.revision, event]);
}

export async function createSupplierCapability(actor: Actor) {
  if (!actor.roles.includes("producer")) throw new DomainError("ROLE_REQUIRED", "Only the producer can open a controlled supplier client.", 403);
  const show = await getShow(actor.tenantId);
  const candidate = show.runs.flatMap(run => run.candidates).find(item => item.id === show.approvedPlan?.candidateId);
  const offer = show.offers.find(item => item.id === candidate?.patch.offerId);
  if (!show.approvedPlan || !offer || !supplierIds.includes(offer.supplierId as SupplierId) || show.commercialProtocol !== 2 && offer.supplierId !== "brightline") throw new DomainError("SUPPLIER_NOT_SELECTED", "Approve the selected enrolled supplier before opening its controlled portal.");
  const token = randomBytes(32).toString("base64url");
  const supplier: Actor = { id: "supplier:" + offer.supplierId + ":" + randomUUID(), tenantId: actor.tenantId, roles: ["supplier"], personId: null, supplierId: offer.supplierId as SupplierId };
  await pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [tokenHash(token), actor.tenantId, supplier]);
  return token;
}

export async function createDeliveryCapability(actor: Actor, role: "driver" | "inspector") {
  if (!actor.roles.includes("producer")) throw new DomainError("PRODUCER_REQUIRED", "The producer opens these controlled role-specific clients.", 403);
  const show = await getShow(actor.tenantId); const execution = currentRentalExecution(show);
  if (!execution || !["confirmed", "delivered", "accepted", "needs_attention", "returned"].includes(execution.state)) throw new DomainError("RESERVATION_CONFIRMATION_REQUIRED", "Confirm the rental reservation before opening its handoff clients.");
  const inspector = show.resources.find(person => person.id === "priya" && person.skills.includes("lx_programming"));
  if (role === "inspector" && (!inspector || !show.tasks.find(task => task.id === "lx-program")?.resources.includes(inspector.id))) throw new DomainError("QUALIFIED_INSPECTOR_REQUIRED", "The current plan needs its assigned qualified lighting lead.");
  const token = randomBytes(32).toString("base64url");
  const scoped: Actor = { id: role + ":" + randomUUID(), tenantId: actor.tenantId, roles: role === "driver" ? ["driver"] : ["department_lead"], personId: role === "inspector" ? inspector!.id : null, supplierId: execution.supplierId, executionId: execution.id };
  await pool.query("INSERT INTO on_sessions(token_hash,tenant_id,actor,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [tokenHash(token), actor.tenantId, scoped]);
  return { token, executionId: execution.id };
}
