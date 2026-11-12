/** Additive planning library. No original show, session, receipt or authority is rewritten. */
export const tourMigration = `
CREATE TABLE on_tour_records (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('template','production','tour','comparison','swap')),
  revision integer NOT NULL CHECK(revision>0), digest text NOT NULL, archived boolean NOT NULL DEFAULT false,
  snapshot_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id)
);
CREATE INDEX on_tour_records_kind ON on_tour_records(tenant_id,kind,updated_at DESC);
CREATE TABLE on_tour_editions (
  tenant_id uuid NOT NULL, record_id uuid NOT NULL, revision integer NOT NULL, digest text NOT NULL, snapshot_cipher text NOT NULL,
  actor_id text NOT NULL, command_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,record_id,revision), FOREIGN KEY(tenant_id,record_id) REFERENCES on_tour_records(tenant_id,id)
);
CREATE TABLE on_tour_commands (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), command_id uuid NOT NULL, actor_id text NOT NULL, session_hash text NOT NULL,
  payload_hash text NOT NULL, action text NOT NULL, receipt_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,command_id)
);
CREATE INDEX on_tour_commands_history ON on_tour_commands(tenant_id,created_at DESC);
CREATE TABLE on_tour_acknowledgments (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL, person_id text NOT NULL, production_id uuid NOT NULL,
  call_id text NOT NULL, obligation_digest text NOT NULL, actor_id text NOT NULL, command_id uuid NOT NULL, at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,command_id), FOREIGN KEY(tenant_id,production_id) REFERENCES on_tour_records(tenant_id,id)
);
CREATE TABLE on_tour_source_bindings (
  tenant_id uuid NOT NULL, record_id uuid NOT NULL, source_id uuid NOT NULL, source_version integer NOT NULL,
  source_hash text NOT NULL, compilation_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,record_id,source_id), FOREIGN KEY(tenant_id,record_id) REFERENCES on_tour_records(tenant_id,id)
);
CREATE FUNCTION on_tour_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Tour planning history is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER on_tour_editions_immutable BEFORE UPDATE OR DELETE ON on_tour_editions FOR EACH ROW EXECUTE FUNCTION on_tour_immutable();
CREATE TRIGGER on_tour_commands_immutable BEFORE UPDATE OR DELETE ON on_tour_commands FOR EACH ROW EXECUTE FUNCTION on_tour_immutable();
CREATE TRIGGER on_tour_acknowledgments_immutable BEFORE UPDATE OR DELETE ON on_tour_acknowledgments FOR EACH ROW EXECUTE FUNCTION on_tour_immutable();
`;
