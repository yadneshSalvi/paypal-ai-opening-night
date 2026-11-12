/** Role-specific consent is separate from production actors and original session capabilities. */
export const planConsentsMigration = `
CREATE TABLE on_plan_consent_requests (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id),
 issuer_actor_id text NOT NULL, issuer_actor jsonb NOT NULL, issuer_session_hash text NOT NULL,
 issuer_expires_at timestamptz NOT NULL, issuer_fingerprint text NOT NULL,
 candidate_id text NOT NULL, candidate_digest text NOT NULL, source_digest text NOT NULL,
 base_revision integer NOT NULL CHECK(base_revision>0), requirement_id text NOT NULL,
 role text NOT NULL CHECK(role='artist_representative'), cap_hash text NOT NULL UNIQUE,
 cap_cipher text NOT NULL, review_cipher text NOT NULL, review_digest text NOT NULL,
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=issuer_expires_at),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,candidate_id,candidate_digest,requirement_id)
);
CREATE INDEX on_plan_consent_requests_tenant ON on_plan_consent_requests(tenant_id,created_at DESC);
CREATE TABLE on_plan_consent_commands (
 tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), command_id uuid NOT NULL,
 scope_kind text NOT NULL CHECK(scope_kind IN ('producer','reviewer')), scope_hash text NOT NULL,
 expires_at timestamptz NOT NULL, request_hash text NOT NULL, action text NOT NULL,
 receipt_cipher text NOT NULL, receipt_digest text NOT NULL, committed_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE on_plan_consent_decisions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, request_id uuid NOT NULL UNIQUE,
 cap_hash text NOT NULL, review_digest text NOT NULL, decision text NOT NULL CHECK(decision IN ('approve','decline')),
 decision_cipher text NOT NULL, decision_digest text NOT NULL, signature text NOT NULL,
 recorded_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,request_id) REFERENCES on_plan_consent_requests(tenant_id,id)
);
CREATE TABLE on_plan_consent_revocations (
 request_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, actor_id text NOT NULL,
 issuer_session_hash text NOT NULL, command_id uuid NOT NULL, reason text NOT NULL, recorded_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,request_id) REFERENCES on_plan_consent_requests(tenant_id,id)
);
CREATE TABLE on_plan_consent_consumptions (
 request_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, command_id uuid NOT NULL,
 candidate_digest text NOT NULL, producer_actor_id text NOT NULL, issuer_session_hash text NOT NULL,
 plan_version integer NOT NULL CHECK(plan_version>0), recorded_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,request_id) REFERENCES on_plan_consent_requests(tenant_id,id)
);
CREATE FUNCTION on_plan_consent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable plan consent evidence'; END $$;
CREATE TRIGGER on_plan_consent_request_immutable BEFORE UPDATE OR DELETE ON on_plan_consent_requests FOR EACH ROW EXECUTE FUNCTION on_plan_consent_immutable();
CREATE TRIGGER on_plan_consent_command_immutable BEFORE UPDATE OR DELETE ON on_plan_consent_commands FOR EACH ROW EXECUTE FUNCTION on_plan_consent_immutable();
CREATE TRIGGER on_plan_consent_decision_immutable BEFORE UPDATE OR DELETE ON on_plan_consent_decisions FOR EACH ROW EXECUTE FUNCTION on_plan_consent_immutable();
CREATE TRIGGER on_plan_consent_revocation_immutable BEFORE UPDATE OR DELETE ON on_plan_consent_revocations FOR EACH ROW EXECUTE FUNCTION on_plan_consent_immutable();
CREATE TRIGGER on_plan_consent_consumption_immutable BEFORE UPDATE OR DELETE ON on_plan_consent_consumptions FOR EACH ROW EXECUTE FUNCTION on_plan_consent_immutable();
`;
