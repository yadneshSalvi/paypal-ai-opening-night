export const wrapMigration = `
CREATE TABLE on_wrap_state (tenant_id uuid PRIMARY KEY REFERENCES on_shows(tenant_id),revision integer NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE on_wrap_records (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES on_wrap_state(tenant_id),command_id uuid NOT NULL,kind text NOT NULL,semantic_key text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),production_revision integer NOT NULL CHECK(production_revision>0),actor_id text,session_hash text,
 request_hash text NOT NULL,request_cipher text NOT NULL,record_cipher text NOT NULL,record_digest text NOT NULL,recorded_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,command_id),UNIQUE(tenant_id,revision),UNIQUE(tenant_id,kind,semantic_key),CHECK((actor_id IS NULL)=(session_hash IS NULL))
);
CREATE INDEX on_wrap_records_tenant ON on_wrap_records(tenant_id,revision);
CREATE TABLE on_wrap_bindings (
 merchant_fingerprint text NOT NULL,kind text NOT NULL CHECK(kind IN ('invoice','invoice_payment','invoice_refund')),provider_id text NOT NULL,
 tenant_id uuid NOT NULL REFERENCES on_wrap_state(tenant_id),invoice_id uuid NOT NULL,
 PRIMARY KEY(merchant_fingerprint,kind,provider_id),FOREIGN KEY(tenant_id,invoice_id) REFERENCES on_wrap_records(tenant_id,id)
);
CREATE TABLE on_wrap_reports (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES on_wrap_state(tenant_id),edition integer NOT NULL CHECK(edition>0),command_id uuid NOT NULL,
 request_hash text NOT NULL,report_cipher text NOT NULL,report_digest text NOT NULL,pdf_cipher text NOT NULL,pdf_hash text NOT NULL,json_cipher text NOT NULL,json_hash text NOT NULL,
 pages integer NOT NULL CHECK(pages>0),title text NOT NULL,as_of timestamptz NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,edition),UNIQUE(tenant_id,command_id)
);
CREATE TABLE on_wrap_assistant_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id),actor_id text NOT NULL,session_hash text NOT NULL,command_id uuid NOT NULL,
 command_hash text NOT NULL,request_cipher text NOT NULL,request_digest text NOT NULL,provenance text NOT NULL CHECK(provenance IN ('live_model','controlled_fixture')),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,UNIQUE(tenant_id,command_id),UNIQUE(tenant_id,id)
);
CREATE TABLE on_wrap_assistant_events (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,run_id uuid NOT NULL,sequence integer NOT NULL CHECK(sequence>0),semantic_key text NOT NULL,
 payload_cipher text NOT NULL,payload_digest text NOT NULL,recorded_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,run_id) REFERENCES on_wrap_assistant_runs(tenant_id,id),UNIQUE(run_id,sequence),UNIQUE(run_id,semantic_key)
);
CREATE FUNCTION on_wrap_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME<>'on_wrap_state' THEN RAISE EXCEPTION 'Immutable wrap history'; END IF;
 IF TG_OP='DELETE' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Wrap revision must advance once'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER on_wrap_records_immutable BEFORE UPDATE OR DELETE ON on_wrap_records FOR EACH ROW EXECUTE FUNCTION on_wrap_immutable();
CREATE TRIGGER on_wrap_bindings_immutable BEFORE UPDATE OR DELETE ON on_wrap_bindings FOR EACH ROW EXECUTE FUNCTION on_wrap_immutable();
CREATE TRIGGER on_wrap_reports_immutable BEFORE UPDATE OR DELETE ON on_wrap_reports FOR EACH ROW EXECUTE FUNCTION on_wrap_immutable();
CREATE TRIGGER on_wrap_assistant_runs_immutable BEFORE UPDATE OR DELETE ON on_wrap_assistant_runs FOR EACH ROW EXECUTE FUNCTION on_wrap_immutable();
CREATE TRIGGER on_wrap_assistant_events_immutable BEFORE UPDATE OR DELETE ON on_wrap_assistant_events FOR EACH ROW EXECUTE FUNCTION on_wrap_immutable();
CREATE TRIGGER on_wrap_revision BEFORE UPDATE OR DELETE ON on_wrap_state FOR EACH ROW EXECUTE FUNCTION on_wrap_immutable();
`;
