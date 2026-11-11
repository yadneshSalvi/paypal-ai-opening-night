export const settlementMigration = `
CREATE TABLE on_settlement_state (
 tenant_id uuid PRIMARY KEY REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE on_settlement_records (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_settlement_state(tenant_id),
 command_id uuid NOT NULL, request_hash text NOT NULL, request_cipher text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), production_revision integer NOT NULL CHECK(production_revision>0),
 actor_id text NOT NULL, session_hash text NOT NULL, person_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('rate','time_report','payable','changes_requested')),
 record_cipher text NOT NULL, record_digest text NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,command_id), UNIQUE(tenant_id,revision)
);
CREATE INDEX on_settlement_person ON on_settlement_records(tenant_id,person_id,revision);
CREATE FUNCTION on_settlement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='on_settlement_records' THEN RAISE EXCEPTION 'Immutable settlement record'; END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Settlement revision must advance once'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER on_settlement_record_immutable BEFORE UPDATE OR DELETE ON on_settlement_records FOR EACH ROW EXECUTE FUNCTION on_settlement_immutable();
CREATE TRIGGER on_settlement_revision BEFORE UPDATE ON on_settlement_state FOR EACH ROW EXECUTE FUNCTION on_settlement_immutable();
`;
