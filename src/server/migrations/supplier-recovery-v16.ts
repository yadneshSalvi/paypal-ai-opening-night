/** Additive, versioned supplier terms and exact-capability replacement requests. No original row is rewritten. */
export const supplierRecoveryMigration = `
CREATE TABLE on_supplier_terms (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL,
  supplier_id text NOT NULL CHECK(supplier_id IN ('brightline','northside','sister')),
  revision integer NOT NULL CHECK(revision>0), digest text NOT NULL, document_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,supplier_id,revision)
);
CREATE INDEX on_supplier_terms_scope ON on_supplier_terms(tenant_id,supplier_id,revision DESC);
CREATE TABLE on_supplier_recovery_rfqs (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL REFERENCES on_supplier_rfqs(id),
  digest text NOT NULL, document_cipher text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE on_supplier_recovery_commands (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), command_id uuid NOT NULL,
  actor_id text NOT NULL, session_hash text NOT NULL, payload_hash text NOT NULL, receipt_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE on_supplier_recovery_invites (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL,
  producer_session_hash text NOT NULL, document_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id)
);
ALTER TABLE on_supplier_rfqs ADD COLUMN outcomes jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE FUNCTION on_supplier_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Supplier source and request history is immutable' USING ERRCODE='23000'; END; $$;
CREATE TRIGGER on_supplier_terms_immutable BEFORE UPDATE OR DELETE ON on_supplier_terms FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
CREATE TRIGGER on_supplier_recovery_rfqs_immutable BEFORE UPDATE OR DELETE ON on_supplier_recovery_rfqs FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
CREATE TRIGGER on_supplier_recovery_commands_immutable BEFORE UPDATE OR DELETE ON on_supplier_recovery_commands FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
CREATE TRIGGER on_supplier_recovery_invites_immutable BEFORE UPDATE OR DELETE ON on_supplier_recovery_invites FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
CREATE TRIGGER on_supplier_quotes_immutable BEFORE UPDATE OR DELETE ON on_supplier_quotes FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
CREATE TRIGGER on_supplier_requests_immutable BEFORE UPDATE OR DELETE ON on_supplier_requests FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
`;
