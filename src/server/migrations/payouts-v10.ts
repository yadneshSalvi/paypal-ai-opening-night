export const payoutsMigration = `
CREATE TABLE on_payout_state (
 tenant_id uuid PRIMARY KEY REFERENCES on_shows(tenant_id), revision integer NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE on_payout_records (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_payout_state(tenant_id), command_id uuid NOT NULL,
 kind text NOT NULL, semantic_key text NOT NULL, revision integer NOT NULL CHECK(revision>0), production_revision integer NOT NULL CHECK(production_revision>0),
 actor_id text, session_hash text, request_hash text NOT NULL, request_cipher text NOT NULL,
 record_cipher text NOT NULL, record_digest text NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,command_id), UNIQUE(tenant_id,revision), UNIQUE(tenant_id,kind,semantic_key),
 CHECK((actor_id IS NULL)=(session_hash IS NULL))
);
CREATE INDEX on_payout_records_tenant ON on_payout_records(tenant_id,revision);
CREATE TABLE on_payout_bindings (
 merchant_fingerprint text NOT NULL, kind text NOT NULL CHECK(kind IN ('batch','item')), provider_id text NOT NULL,
 tenant_id uuid NOT NULL REFERENCES on_payout_state(tenant_id), grant_id uuid NOT NULL, sender_item_id uuid,
 PRIMARY KEY(merchant_fingerprint,kind,provider_id), FOREIGN KEY(tenant_id,grant_id) REFERENCES on_payout_records(tenant_id,id)
);
CREATE FUNCTION on_payout_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME IN ('on_payout_records','on_payout_bindings') THEN RAISE EXCEPTION 'Immutable payout history'; END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Payout revision must advance once'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER on_payout_record_immutable BEFORE UPDATE OR DELETE ON on_payout_records FOR EACH ROW EXECUTE FUNCTION on_payout_immutable();
CREATE TRIGGER on_payout_binding_immutable BEFORE UPDATE OR DELETE ON on_payout_bindings FOR EACH ROW EXECUTE FUNCTION on_payout_immutable();
CREATE TRIGGER on_payout_revision BEFORE UPDATE ON on_payout_state FOR EACH ROW EXECUTE FUNCTION on_payout_immutable();
`;
