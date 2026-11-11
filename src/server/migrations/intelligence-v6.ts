export const intelligenceMigration = `
CREATE TABLE on_intelligence_conversations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
  actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE on_intelligence_runs (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, conversation_id uuid NOT NULL,
  actor_id text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0), revision integer NOT NULL, source_digest text NOT NULL,
  request_cipher text NOT NULL, prompt_cipher text, result_cipher text, provider_output_cipher text,
  provider_source text NOT NULL CHECK(provider_source IN ('live_model','controlled_fixture')),
  state text NOT NULL CHECK(state IN ('dispatching','running','completed','failed','indeterminate','unavailable')),
  provider_response_id text, provider_status text, failure_code text,
  poll_after timestamptz, poll_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES on_intelligence_conversations(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,request_id), UNIQUE(conversation_id,sequence), UNIQUE(tenant_id,id)
);
CREATE INDEX on_intelligence_runs_pending ON on_intelligence_runs(tenant_id,actor_id,state);
CREATE TABLE on_intelligence_tool_receipts (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL, call_id text NOT NULL,
  name text NOT NULL, args_hash text NOT NULL, state text NOT NULL CHECK(state IN ('reserved','completed','failed')),
  result_cipher text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  FOREIGN KEY(tenant_id,run_id) REFERENCES on_intelligence_runs(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(run_id,call_id)
);
CREATE TABLE on_intelligence_proposals (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
  actor_id text NOT NULL, run_id uuid NOT NULL, call_id text NOT NULL,
  base_revision integer NOT NULL, source_digest text NOT NULL, payload_digest text NOT NULL, candidate_cipher text NOT NULL,
  state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','reviewed')),
  review_command_id uuid, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,run_id) REFERENCES on_intelligence_runs(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(run_id,call_id)
);
CREATE FUNCTION on_intelligence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'on_intelligence_runs' THEN
   IF (NEW.id,NEW.tenant_id,NEW.conversation_id,NEW.actor_id,NEW.request_id,NEW.request_hash,NEW.sequence,NEW.revision,NEW.source_digest,NEW.request_cipher,NEW.prompt_cipher,NEW.provider_source,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.conversation_id,OLD.actor_id,OLD.request_id,OLD.request_hash,OLD.sequence,OLD.revision,OLD.source_digest,OLD.request_cipher,OLD.prompt_cipher,OLD.provider_source,OLD.created_at)
  THEN RAISE EXCEPTION 'Immutable planning request'; END IF;
   IF OLD.provider_response_id IS NOT NULL AND NEW.provider_response_id IS DISTINCT FROM OLD.provider_response_id
  THEN RAISE EXCEPTION 'Immutable provider identity'; END IF;
   IF OLD.state IN ('completed','failed','indeterminate','unavailable') AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'Terminal planning request'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'on_intelligence_tool_receipts' THEN
   IF ((NEW.id,NEW.tenant_id,NEW.run_id,NEW.call_id,NEW.name,NEW.args_hash,NEW.created_at) IS DISTINCT FROM
      (OLD.id,OLD.tenant_id,OLD.run_id,OLD.call_id,OLD.name,OLD.args_hash,OLD.created_at) OR OLD.state<>'reserved')
  THEN RAISE EXCEPTION 'Immutable planning tool receipt'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'on_intelligence_proposals' THEN
   IF ((NEW.id,NEW.tenant_id,NEW.actor_id,NEW.run_id,NEW.call_id,NEW.base_revision,NEW.source_digest,NEW.payload_digest,NEW.candidate_cipher,NEW.created_at) IS DISTINCT FROM
      (OLD.id,OLD.tenant_id,OLD.actor_id,OLD.run_id,OLD.call_id,OLD.base_revision,OLD.source_digest,OLD.payload_digest,OLD.candidate_cipher,OLD.created_at) OR OLD.state='reviewed' OR NEW.state<>'reviewed')
  THEN RAISE EXCEPTION 'Immutable planning proposal'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER on_intelligence_run_immutable BEFORE UPDATE ON on_intelligence_runs FOR EACH ROW EXECUTE FUNCTION on_intelligence_immutable();
CREATE TRIGGER on_intelligence_tool_immutable BEFORE UPDATE ON on_intelligence_tool_receipts FOR EACH ROW EXECUTE FUNCTION on_intelligence_immutable();
CREATE TRIGGER on_intelligence_proposal_immutable BEFORE UPDATE ON on_intelligence_proposals FOR EACH ROW EXECUTE FUNCTION on_intelligence_immutable();
`;
