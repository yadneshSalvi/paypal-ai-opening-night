export const sourcesMigration = `
CREATE TABLE on_source_documents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
 actor_id text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL,
 family_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), current boolean NOT NULL DEFAULT true,
 kind text NOT NULL CHECK(kind IN ('text','pdf','spreadsheet')), format text NOT NULL, media_type text NOT NULL,
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 4194304), content_hash text NOT NULL,
 metadata_cipher text, extraction_cipher text, extraction_digest text,
 state text NOT NULL CHECK(state IN ('saved','parsing','ready','needs_attention','failed','deleted')),
 parser_version text, parser_lease uuid, parser_lease_until timestamptz, failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id), UNIQUE(tenant_id,family_id,version)
);
CREATE UNIQUE INDEX on_source_current_version ON on_source_documents(tenant_id,family_id) WHERE current=true;
CREATE INDEX on_source_documents_tenant ON on_source_documents(tenant_id,created_at DESC);
CREATE TABLE on_source_objects (
 tenant_id uuid NOT NULL, source_id uuid PRIMARY KEY, bytes_cipher text NOT NULL,
 FOREIGN KEY(tenant_id,source_id) REFERENCES on_source_documents(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE on_source_compilations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
 actor_id text NOT NULL, session_hash text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL,
 base_revision integer NOT NULL, base_digest text NOT NULL, source_bindings jsonb NOT NULL,
 request_cipher text, provider_output_cipher text, result_cipher text, result_digest text,
 requested_model text NOT NULL, resolved_model text, provider_source text NOT NULL CHECK(provider_source IN ('live_model','controlled_fixture')),
 state text NOT NULL CHECK(state IN ('dispatching','running','validating','completed','failed','indeterminate','unavailable','deleted')),
 provider_response_id text, provider_status text, provider_store boolean, failure_code text,
 poll_after timestamptz, poll_count integer NOT NULL DEFAULT 0, validation_lease uuid, validation_lease_until timestamptz,
 applied_at timestamptz, applied_revision integer, apply_command_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), purged_at timestamptz,
 UNIQUE(tenant_id,request_id), UNIQUE(tenant_id,id)
);
CREATE INDEX on_source_compilations_tenant ON on_source_compilations(tenant_id,actor_id,created_at DESC);
CREATE TABLE on_source_reviews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, compilation_id uuid NOT NULL, command_id uuid NOT NULL,
 actor_id text NOT NULL, session_hash text NOT NULL, base_revision integer NOT NULL, result_revision integer NOT NULL,
 compilation_digest text NOT NULL, reviewed_sources jsonb NOT NULL, accepted_assumptions jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,compilation_id) REFERENCES on_source_compilations(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,command_id), UNIQUE(compilation_id)
);
CREATE FUNCTION on_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME IN ('on_source_objects','on_source_reviews') THEN RAISE EXCEPTION 'Immutable source record'; END IF;
 IF TG_TABLE_NAME='on_source_documents' THEN
  IF (NEW.id,NEW.tenant_id,NEW.actor_id,NEW.request_id,NEW.request_hash,NEW.family_id,NEW.version,NEW.kind,NEW.format,NEW.media_type,NEW.byte_length,NEW.content_hash,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.actor_id,OLD.request_id,OLD.request_hash,OLD.family_id,OLD.version,OLD.kind,OLD.format,OLD.media_type,OLD.byte_length,OLD.content_hash,OLD.created_at)
  THEN RAISE EXCEPTION 'Immutable source identity'; END IF;
  IF OLD.state='deleted' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Deleted source tombstone'; END IF;
  IF NEW.state<>'deleted' AND NEW.metadata_cipher IS DISTINCT FROM OLD.metadata_cipher THEN RAISE EXCEPTION 'Immutable source metadata'; END IF;
  IF OLD.extraction_digest IS NOT NULL AND NEW.state<>'deleted' AND (NEW.extraction_cipher,NEW.extraction_digest,NEW.parser_version) IS DISTINCT FROM (OLD.extraction_cipher,OLD.extraction_digest,OLD.parser_version) THEN RAISE EXCEPTION 'Immutable source extraction'; END IF;
 END IF;
 IF TG_TABLE_NAME='on_source_compilations' THEN
  IF (NEW.id,NEW.tenant_id,NEW.actor_id,NEW.session_hash,NEW.request_id,NEW.request_hash,NEW.base_revision,NEW.base_digest,NEW.source_bindings,NEW.requested_model,NEW.provider_source,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.actor_id,OLD.session_hash,OLD.request_id,OLD.request_hash,OLD.base_revision,OLD.base_digest,OLD.source_bindings,OLD.requested_model,OLD.provider_source,OLD.created_at)
  THEN RAISE EXCEPTION 'Immutable compilation identity'; END IF;
  IF NEW.state<>'deleted' AND NEW.request_cipher IS DISTINCT FROM OLD.request_cipher THEN RAISE EXCEPTION 'Immutable compilation request'; END IF;
  IF OLD.provider_response_id IS NOT NULL AND NEW.provider_response_id IS DISTINCT FROM OLD.provider_response_id THEN RAISE EXCEPTION 'Immutable compilation provider identity'; END IF;
  IF OLD.state='deleted' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Deleted compilation tombstone'; END IF;
  IF OLD.applied_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Applied compilation is immutable'; END IF;
  IF NEW.state='deleted' AND (OLD.applied_at IS NOT NULL OR NEW.request_cipher IS NOT NULL OR NEW.result_cipher IS NOT NULL OR NEW.provider_output_cipher IS NOT NULL OR NEW.purged_at IS NULL) THEN RAISE EXCEPTION 'Incomplete compilation purge'; END IF;
  IF OLD.state IN ('completed','failed','indeterminate','unavailable') AND NEW.state<>'deleted' AND (NEW.state,NEW.result_cipher,NEW.result_digest,NEW.provider_output_cipher,NEW.provider_status,NEW.resolved_model,NEW.failure_code) IS DISTINCT FROM (OLD.state,OLD.result_cipher,OLD.result_digest,OLD.provider_output_cipher,OLD.provider_status,OLD.resolved_model,OLD.failure_code) THEN RAISE EXCEPTION 'Terminal compilation result'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER on_source_document_immutable BEFORE UPDATE ON on_source_documents FOR EACH ROW EXECUTE FUNCTION on_source_immutable();
CREATE TRIGGER on_source_object_immutable BEFORE UPDATE ON on_source_objects FOR EACH ROW EXECUTE FUNCTION on_source_immutable();
CREATE TRIGGER on_source_compilation_immutable BEFORE UPDATE ON on_source_compilations FOR EACH ROW EXECUTE FUNCTION on_source_immutable();
CREATE TRIGGER on_source_review_immutable BEFORE UPDATE ON on_source_reviews FOR EACH ROW EXECUTE FUNCTION on_source_immutable();
`;
