/** Original accepted-rental return and residual-authority history. Existing rows are unchanged. */
export const rentalCloseoutMigration = `
CREATE TABLE on_rental_return_records (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL,
  execution_id uuid NOT NULL REFERENCES on_rental_executions(id), previous_id uuid,
  digest text NOT NULL, document_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,previous_id) REFERENCES on_rental_return_records(tenant_id,id)
);
CREATE INDEX on_rental_returns_execution ON on_rental_return_records(tenant_id,execution_id,created_at);
CREATE TABLE on_rental_closeout_grants (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL,
  execution_id uuid NOT NULL REFERENCES on_rental_executions(id), root_intent_id uuid NOT NULL,
  return_id uuid NOT NULL, digest text NOT NULL, document_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,execution_id), UNIQUE(tenant_id,root_intent_id),
  FOREIGN KEY(tenant_id,return_id) REFERENCES on_rental_return_records(tenant_id,id)
);
CREATE TABLE on_rental_closeout_progress (
  tenant_id uuid NOT NULL, grant_id uuid NOT NULL, intent_id uuid,
  last_code text, dispatch_authorized_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,grant_id), UNIQUE(tenant_id,intent_id),
  FOREIGN KEY(tenant_id,grant_id) REFERENCES on_rental_closeout_grants(tenant_id,id)
);
CREATE TABLE on_rental_closeout_stops (
  tenant_id uuid NOT NULL, grant_id uuid NOT NULL, actor_id text NOT NULL,
  stopped_at timestamptz NOT NULL DEFAULT clock_timestamp(), detail_cipher text NOT NULL,
  PRIMARY KEY(tenant_id,grant_id), FOREIGN KEY(tenant_id,grant_id) REFERENCES on_rental_closeout_grants(tenant_id,id)
);
CREATE TABLE on_rental_closeout_commands (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), command_id uuid NOT NULL,
  actor_id text NOT NULL, session_hash text NOT NULL, payload_hash text NOT NULL,
  receipt_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,command_id)
);
CREATE FUNCTION on_rental_closeout_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Original rental return and closeout history is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER on_rental_returns_immutable BEFORE UPDATE OR DELETE ON on_rental_return_records FOR EACH ROW EXECUTE FUNCTION on_rental_closeout_immutable();
CREATE TRIGGER on_rental_closeout_grants_immutable BEFORE UPDATE OR DELETE ON on_rental_closeout_grants FOR EACH ROW EXECUTE FUNCTION on_rental_closeout_immutable();
CREATE TRIGGER on_rental_closeout_stops_immutable BEFORE UPDATE OR DELETE ON on_rental_closeout_stops FOR EACH ROW EXECUTE FUNCTION on_rental_closeout_immutable();
CREATE TRIGGER on_rental_closeout_commands_immutable BEFORE UPDATE OR DELETE ON on_rental_closeout_commands FOR EACH ROW EXECUTE FUNCTION on_rental_closeout_immutable();
`;
