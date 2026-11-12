/** Additional declared services; the three original suppliers and all prior rows remain untouched. */
export const supplierAdminMigration = `
CREATE TABLE on_supplier_admin_records (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL,
  supplier_id text NOT NULL CHECK(supplier_id ~ '^enrolled-[a-f0-9-]{36}$'),
  kind text NOT NULL CHECK(kind IN ('enrollment','key','inventory','terms','supplier_mandate','rfq','round','acceptance','revocation')),
  revision integer NOT NULL CHECK(revision>0), digest text NOT NULL, document_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,supplier_id,kind,revision)
);
CREATE INDEX on_supplier_admin_scope ON on_supplier_admin_records(tenant_id,supplier_id,kind,revision DESC);
CREATE TABLE on_supplier_admin_keys (
  tenant_id uuid NOT NULL, id uuid NOT NULL, private_cipher text NOT NULL,
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,id) REFERENCES on_supplier_admin_records(tenant_id,id)
);
CREATE TABLE on_supplier_admin_commands (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), command_id uuid NOT NULL, actor_id text NOT NULL,
  session_hash text NOT NULL, session_expiry timestamptz NOT NULL, payload_hash text NOT NULL,
  receipt_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE on_supplier_admin_invites (
  tenant_id uuid NOT NULL, id uuid NOT NULL, producer_session_hash text NOT NULL, document_cipher text NOT NULL,
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,id) REFERENCES on_supplier_admin_records(tenant_id,id)
);
CREATE TABLE on_supplier_admin_requests (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), supplier_id text NOT NULL, request_id uuid NOT NULL,
  payload_hash text NOT NULL, response_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,supplier_id,request_id)
);
CREATE TRIGGER on_supplier_admin_records_immutable BEFORE UPDATE OR DELETE ON on_supplier_admin_records FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
CREATE TRIGGER on_supplier_admin_keys_immutable BEFORE UPDATE OR DELETE ON on_supplier_admin_keys FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
CREATE TRIGGER on_supplier_admin_commands_immutable BEFORE UPDATE OR DELETE ON on_supplier_admin_commands FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
CREATE TRIGGER on_supplier_admin_invites_immutable BEFORE UPDATE OR DELETE ON on_supplier_admin_invites FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
CREATE TRIGGER on_supplier_admin_requests_immutable BEFORE UPDATE OR DELETE ON on_supplier_admin_requests FOR EACH ROW EXECUTE FUNCTION on_supplier_history_immutable();
`;
