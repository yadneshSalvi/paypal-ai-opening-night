/** Additive scopes and private transport receipts; historical planning rows stay exact. */
export const intelligenceContinuityMigration = `
CREATE TABLE on_intelligence_scopes (
  conversation_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, actor_id text NOT NULL,
  session_hash text NOT NULL, expires_at timestamptz NOT NULL,
  contract text NOT NULL CHECK(contract='opening-night-planning-stateless-v1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES on_intelligence_conversations(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX on_intelligence_scopes_authority ON on_intelligence_scopes(tenant_id,actor_id,session_hash);
CREATE TABLE on_intelligence_observations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0),
  method text NOT NULL CHECK(method IN ('POST','GET')),
  client_request_id uuid NOT NULL, provider_request_id text,
  status integer CHECK(status BETWEEN 100 AND 599),
  outcome text NOT NULL CHECK(outcome IN ('response','body_unreadable','transport_unknown')),
  payload_cipher text NOT NULL, payload_digest text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,run_id) REFERENCES on_intelligence_runs(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(run_id,sequence)
);
CREATE TABLE on_source_compilation_scopes (
  compilation_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  session_hash text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,compilation_id) REFERENCES on_source_compilations(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE on_source_compilation_observations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, compilation_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0),
  method text NOT NULL CHECK(method IN ('POST','GET')),
  client_request_id uuid NOT NULL, provider_request_id text,
  status integer CHECK(status BETWEEN 100 AND 599),
  outcome text NOT NULL CHECK(outcome IN ('response','body_unreadable','transport_unknown')),
  payload_cipher text, payload_digest text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(), purged_at timestamptz,
  FOREIGN KEY(tenant_id,compilation_id) REFERENCES on_source_compilations(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(compilation_id,sequence),
  CHECK((payload_cipher IS NOT NULL AND purged_at IS NULL) OR (payload_cipher IS NULL AND purged_at IS NOT NULL))
);
CREATE FUNCTION on_intelligence_continuity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='on_source_compilation_observations' THEN
  IF OLD.payload_cipher IS NOT NULL AND NEW.payload_cipher IS NULL AND OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL
     AND (to_jsonb(NEW)-'payload_cipher'-'purged_at')=(to_jsonb(OLD)-'payload_cipher'-'purged_at')
  THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Immutable planning continuity evidence';
END $$;
CREATE TRIGGER on_intelligence_scope_immutable BEFORE UPDATE ON on_intelligence_scopes
  FOR EACH ROW EXECUTE FUNCTION on_intelligence_continuity_immutable();
CREATE TRIGGER on_intelligence_observation_immutable BEFORE UPDATE ON on_intelligence_observations
  FOR EACH ROW EXECUTE FUNCTION on_intelligence_continuity_immutable();
CREATE TRIGGER on_source_compilation_scope_immutable BEFORE UPDATE ON on_source_compilation_scopes
  FOR EACH ROW EXECUTE FUNCTION on_intelligence_continuity_immutable();
CREATE TRIGGER on_source_compilation_observation_immutable BEFORE UPDATE ON on_source_compilation_observations
  FOR EACH ROW EXECUTE FUNCTION on_intelligence_continuity_immutable();
`;
