/** Additive immutable source → proposal → preview → separately approved input editions. */
export const productionInputsMigration = `
CREATE TABLE on_production_input_sources (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), family_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 source_cipher text NOT NULL, source_digest text NOT NULL, content_hash text NOT NULL, document_id uuid, created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,family_id,version)
);
CREATE TABLE on_production_input_proposals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), actor_id text NOT NULL, session_hash text NOT NULL,
 expires_at timestamptz NOT NULL, proposal_cipher text NOT NULL, proposal_digest text NOT NULL, base_revision integer NOT NULL, input_revision integer NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id)
);
CREATE TABLE on_production_input_source_bindings (
 tenant_id uuid NOT NULL, proposal_id uuid NOT NULL, source_id uuid NOT NULL, source_digest text NOT NULL,
 PRIMARY KEY(tenant_id,proposal_id,source_id),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES on_production_input_proposals(tenant_id,id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES on_production_input_sources(tenant_id,id)
);
CREATE TABLE on_production_input_previews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, proposal_id uuid NOT NULL, preview_cipher text NOT NULL, preview_digest text NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES on_production_input_proposals(tenant_id,id), UNIQUE(tenant_id,id)
);
CREATE TABLE on_production_input_editions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), revision integer NOT NULL CHECK(revision>0), proposal_id uuid NOT NULL,
 preview_id uuid NOT NULL, edition_cipher text NOT NULL, edition_digest text NOT NULL, approved_at timestamptz NOT NULL,
 UNIQUE(tenant_id,revision), UNIQUE(tenant_id,id), UNIQUE(tenant_id,proposal_id),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES on_production_input_proposals(tenant_id,id), FOREIGN KEY(tenant_id,preview_id) REFERENCES on_production_input_previews(tenant_id,id)
);
CREATE TABLE on_production_input_decisions (
 tenant_id uuid NOT NULL, proposal_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('approve','reject')), reason text NOT NULL,
 actor_id text NOT NULL, session_hash text NOT NULL, command_id uuid NOT NULL, edition_id uuid, recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,proposal_id), FOREIGN KEY(tenant_id,proposal_id) REFERENCES on_production_input_proposals(tenant_id,id),
 FOREIGN KEY(tenant_id,edition_id) REFERENCES on_production_input_editions(tenant_id,id)
);
CREATE TABLE on_production_input_commands (
 tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), command_id uuid NOT NULL, session_hash text NOT NULL, expires_at timestamptz NOT NULL,
 fingerprint text NOT NULL, request_digest text NOT NULL, receipt_cipher text NOT NULL, receipt_digest text NOT NULL, accepted_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,command_id)
);
CREATE INDEX on_production_input_sources_tenant ON on_production_input_sources(tenant_id,created_at DESC);
CREATE INDEX on_production_input_sources_document ON on_production_input_sources(tenant_id,document_id) WHERE document_id IS NOT NULL;
CREATE INDEX on_production_input_proposals_tenant ON on_production_input_proposals(tenant_id,created_at DESC);
CREATE FUNCTION on_production_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable production input evidence'; END $$;
CREATE TRIGGER on_production_input_sources_immutable BEFORE UPDATE OR DELETE ON on_production_input_sources FOR EACH ROW EXECUTE FUNCTION on_production_input_immutable();
CREATE TRIGGER on_production_input_proposals_immutable BEFORE UPDATE OR DELETE ON on_production_input_proposals FOR EACH ROW EXECUTE FUNCTION on_production_input_immutable();
CREATE TRIGGER on_production_input_source_bindings_immutable BEFORE UPDATE OR DELETE ON on_production_input_source_bindings FOR EACH ROW EXECUTE FUNCTION on_production_input_immutable();
CREATE TRIGGER on_production_input_previews_immutable BEFORE UPDATE OR DELETE ON on_production_input_previews FOR EACH ROW EXECUTE FUNCTION on_production_input_immutable();
CREATE TRIGGER on_production_input_editions_immutable BEFORE UPDATE OR DELETE ON on_production_input_editions FOR EACH ROW EXECUTE FUNCTION on_production_input_immutable();
CREATE TRIGGER on_production_input_decisions_immutable BEFORE UPDATE OR DELETE ON on_production_input_decisions FOR EACH ROW EXECUTE FUNCTION on_production_input_immutable();
CREATE TRIGGER on_production_input_commands_immutable BEFORE UPDATE OR DELETE ON on_production_input_commands FOR EACH ROW EXECUTE FUNCTION on_production_input_immutable();
`;
