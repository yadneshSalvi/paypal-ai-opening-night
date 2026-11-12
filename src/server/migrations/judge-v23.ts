/**
 * Additive only. A guided demonstration is an ordinary private rehearsal whose
 * payment-provider outcomes are replayed; no PayPal request is made for it.
 *
 * - on_judge_demonstrations: the immutable registry of demonstration tenants
 *   and the director's resumable progress.
 * - on_judge_wire: the replayed provider resources of a demonstration. These
 *   rows are application fixtures, never PayPal records.
 * - on_judge_live_reads: one cached read-only observation of this deployment's
 *   retained sandbox evidence (global rate limit for /api/judge/verify).
 * - Triggers: the snapshot's demonstration marker can be set only when the
 *   rehearsal is created and can never change afterwards. Every financial row
 *   and ticket stored in a demonstration snapshot carries provenance "replay",
 *   and its provider-sourced events are stored as replayed, whichever service
 *   wrote them.
 */
export const judgeMigration = `
  CREATE TABLE on_judge_demonstrations (
    tenant_id uuid PRIMARY KEY REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    mode text NOT NULL CHECK(mode='replay'),
    state jsonb NOT NULL,
    lease_id uuid, lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE on_judge_wire (
    order_id text PRIMARY KEY CHECK(order_id LIKE 'ONREPLAY-%'),
    tenant_id uuid NOT NULL REFERENCES on_judge_demonstrations(tenant_id) ON DELETE CASCADE,
    document jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX on_judge_wire_tenant ON on_judge_wire(tenant_id);
  CREATE TABLE on_judge_live_reads (
    id text PRIMARY KEY CHECK(id='retained-sandbox-evidence'),
    result jsonb NOT NULL, read_at timestamptz NOT NULL
  );

  CREATE FUNCTION on_judge_replay_message(message text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
    SELECT CASE WHEN message LIKE 'Replayed %' THEN message ELSE
      'Replayed outcome, no PayPal request was made. ' || replace(replace(replace(message,
        'Verified PayPal sandbox', 'Recorded replayed'), 'PayPal sandbox order created', 'Replayed order created'), 'PayPal sandbox', 'replayed') END
  $fn$;

  CREATE FUNCTION on_judge_guard_show() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF NOT (NEW.snapshot ? 'demonstration') AND NOT (OLD.snapshot ? 'demonstration') THEN RETURN NEW; END IF;
      IF (NEW.snapshot->'demonstration') IS DISTINCT FROM (OLD.snapshot->'demonstration') THEN
        RAISE EXCEPTION 'A rehearsal demonstration marker is set at creation and cannot change' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NOT (NEW.snapshot ? 'demonstration') THEN RETURN NEW;
    END IF;
    IF (NEW.snapshot->'demonstration'->>'mode') IS DISTINCT FROM 'replay' THEN
      RAISE EXCEPTION 'Unknown demonstration mode' USING ERRCODE = 'check_violation';
    END IF;
    NEW.snapshot := NEW.snapshot || jsonb_build_object(
      'financialEvidence', COALESCE((SELECT jsonb_agg(entry || '{"provenance":"replay"}'::jsonb ORDER BY ordinal)
        FROM jsonb_array_elements(NEW.snapshot->'financialEvidence') WITH ORDINALITY AS item(entry, ordinal)), '[]'::jsonb),
      'tickets', COALESCE((SELECT jsonb_agg(entry || '{"provenance":"replay"}'::jsonb ORDER BY ordinal)
        FROM jsonb_array_elements(NEW.snapshot->'tickets') WITH ORDINALITY AS item(entry, ordinal)), '[]'::jsonb),
      'events', COALESCE((SELECT jsonb_agg(CASE WHEN entry->>'source'='live_sandbox'
          THEN entry || jsonb_build_object('source', 'replay', 'message', on_judge_replay_message(entry->>'message')) ELSE entry END ORDER BY ordinal)
        FROM jsonb_array_elements(NEW.snapshot->'events') WITH ORDINALITY AS item(entry, ordinal)), '[]'::jsonb));
    RETURN NEW;
  END
  $fn$;
  CREATE TRIGGER on_judge_guard_show BEFORE INSERT OR UPDATE OF snapshot ON on_shows
    FOR EACH ROW EXECUTE FUNCTION on_judge_guard_show();

  CREATE FUNCTION on_judge_guard_event() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    IF NEW.event->>'source'='live_sandbox' AND EXISTS (SELECT 1 FROM on_judge_demonstrations WHERE tenant_id=NEW.tenant_id) THEN
      NEW.event := NEW.event || jsonb_build_object('source', 'replay', 'message', on_judge_replay_message(NEW.event->>'message'));
    END IF;
    RETURN NEW;
  END
  $fn$;
  CREATE TRIGGER on_judge_guard_event BEFORE INSERT ON on_events
    FOR EACH ROW EXECUTE FUNCTION on_judge_guard_event();

  CREATE FUNCTION on_judge_guard_registry() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NOT EXISTS (SELECT 1 FROM on_shows WHERE tenant_id=NEW.tenant_id AND snapshot->'demonstration'->>'mode'='replay' AND revision=1) THEN
        RAISE EXCEPTION 'A demonstration is registered only with its newly created rehearsal' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A demonstration registration is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $fn$;
  CREATE TRIGGER on_judge_guard_registry BEFORE INSERT OR UPDATE ON on_judge_demonstrations
    FOR EACH ROW EXECUTE FUNCTION on_judge_guard_registry();
`;
