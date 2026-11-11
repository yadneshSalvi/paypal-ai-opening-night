export const mediaMigration = `
CREATE TABLE on_voice_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
 actor_id text NOT NULL, session_hash text NOT NULL, client_scope uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('transcribe','speak')), input_hash text NOT NULL,
 request_cipher text NOT NULL, requested_model text NOT NULL,
 state text NOT NULL CHECK(state IN ('connecting','dispatching','streaming','completed','failed','indeterminate')),
 provider_source text NOT NULL CHECK(provider_source IN ('live_model','controlled_fixture')),
 provider_session_id text, provider_response_id text, provider_request_id text, resolved_model text,
 receipt_cipher text, receipt_hash text, result_cipher text, output_hash text,
 output_bytes integer CHECK(output_bytes BETWEEN 1 AND 8388652), duration_seconds numeric,
 failure_code text, dispatched_at timestamptz, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,session_hash,client_scope,kind,input_hash), UNIQUE(tenant_id,id)
);
CREATE INDEX on_voice_runs_actor ON on_voice_runs(tenant_id,actor_id,created_at DESC);
CREATE TABLE on_voice_chunks (
 tenant_id uuid NOT NULL, run_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence>=0),
 event_id text NOT NULL, content_hash text NOT NULL, byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 524288), bytes_cipher text NOT NULL,
 PRIMARY KEY(run_id,sequence), UNIQUE(run_id,event_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES on_voice_runs(tenant_id,id) ON DELETE CASCADE
);
CREATE FUNCTION on_voice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='on_voice_chunks' THEN RAISE EXCEPTION 'Immutable voice chunk'; END IF;
 IF (NEW.id,NEW.tenant_id,NEW.actor_id,NEW.session_hash,NEW.client_scope,NEW.kind,NEW.input_hash,NEW.request_cipher,NEW.requested_model,NEW.provider_source,NEW.created_at)
 IS DISTINCT FROM
 (OLD.id,OLD.tenant_id,OLD.actor_id,OLD.session_hash,OLD.client_scope,OLD.kind,OLD.input_hash,OLD.request_cipher,OLD.requested_model,OLD.provider_source,OLD.created_at)
 THEN RAISE EXCEPTION 'Immutable voice request'; END IF;
 IF OLD.state IN ('completed','failed','indeterminate') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Terminal voice request'; END IF;
 IF (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id)
 OR (OLD.provider_response_id IS NOT NULL AND NEW.provider_response_id IS DISTINCT FROM OLD.provider_response_id)
 OR (OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id)
 OR (OLD.resolved_model IS NOT NULL AND NEW.resolved_model IS DISTINCT FROM OLD.resolved_model)
 OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
 THEN RAISE EXCEPTION 'Immutable voice provider identity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER on_voice_request_immutable BEFORE UPDATE ON on_voice_runs FOR EACH ROW EXECUTE FUNCTION on_voice_immutable();
CREATE TRIGGER on_voice_chunk_immutable BEFORE UPDATE ON on_voice_chunks FOR EACH ROW EXECUTE FUNCTION on_voice_immutable();
`;
