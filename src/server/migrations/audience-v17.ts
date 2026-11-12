/** Additive audience-only storage. Existing tickets, money, sessions and show snapshots are untouched. */
export const audienceMigration = `
CREATE TABLE on_audience_workspaces (
  tenant_id uuid PRIMARY KEY REFERENCES on_shows(tenant_id), revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE on_audience_capabilities (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL, ticket_id text NOT NULL,
  capture_id text NOT NULL, token_hash text NOT NULL UNIQUE, issuer_actor_id text NOT NULL,
  issuer_session_hash text NOT NULL, issuer_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  digest text NOT NULL, document_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), CHECK(expires_at<=issuer_expires_at)
);
CREATE INDEX on_audience_capabilities_ticket ON on_audience_capabilities(tenant_id,ticket_id,created_at);
CREATE TABLE on_audience_revocations (
  tenant_id uuid NOT NULL, capability_id uuid NOT NULL, digest text NOT NULL, document_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,capability_id),
  FOREIGN KEY(tenant_id,capability_id) REFERENCES on_audience_capabilities(tenant_id,id)
);
CREATE TABLE on_audience_drafts (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL,
  issuer_actor_id text NOT NULL, issuer_session_hash text NOT NULL, digest text NOT NULL,
  source_digest text NOT NULL, document_cipher text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id)
);
CREATE INDEX on_audience_drafts_history ON on_audience_drafts(tenant_id,created_at DESC);
CREATE TABLE on_audience_approvals (
  tenant_id uuid NOT NULL, id uuid NOT NULL, draft_id uuid NOT NULL,
  digest text NOT NULL, document_cipher text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,draft_id),
  FOREIGN KEY(tenant_id,draft_id) REFERENCES on_audience_drafts(tenant_id,id)
);
CREATE TABLE on_audience_stops (
  tenant_id uuid NOT NULL, approval_id uuid NOT NULL, digest text NOT NULL, document_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,approval_id),
  FOREIGN KEY(tenant_id,approval_id) REFERENCES on_audience_approvals(tenant_id,id)
);
CREATE TABLE on_audience_commands (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), command_id uuid NOT NULL,
  actor_id text NOT NULL, session_hash text NOT NULL, session_expires_at timestamptz NOT NULL, payload_hash text NOT NULL,
  receipt_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE on_audience_delivery_passes (
  tenant_id uuid NOT NULL, id uuid NOT NULL, approval_id uuid NOT NULL,
  actor_id text NOT NULL, session_hash text NOT NULL, limit_count integer NOT NULL CHECK(limit_count BETWEEN 1 AND 10),
  digest text NOT NULL, document_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,approval_id) REFERENCES on_audience_approvals(tenant_id,id),
  FOREIGN KEY(tenant_id,id) REFERENCES on_audience_commands(tenant_id,command_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE on_audience_delivery_progress (
  tenant_id uuid NOT NULL, pass_id uuid NOT NULL, processed integer NOT NULL DEFAULT 0 CHECK(processed BETWEEN 0 AND 10),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','interrupted')),
  error_code text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,pass_id), FOREIGN KEY(tenant_id,pass_id) REFERENCES on_audience_delivery_passes(tenant_id,id)
);
CREATE TABLE on_audience_deliveries (
  tenant_id uuid NOT NULL, id uuid NOT NULL, approval_id uuid NOT NULL, capability_id uuid NOT NULL,
  ticket_id text NOT NULL, digest text NOT NULL, document_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,approval_id,capability_id),
  FOREIGN KEY(tenant_id,approval_id) REFERENCES on_audience_approvals(tenant_id,id),
  FOREIGN KEY(tenant_id,capability_id) REFERENCES on_audience_capabilities(tenant_id,id)
);
CREATE INDEX on_audience_inbox ON on_audience_deliveries(tenant_id,capability_id,created_at DESC);
CREATE FUNCTION on_audience_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audience original grants, content, approvals and receipts are immutable' USING ERRCODE='23000'; END; $$;
CREATE TRIGGER on_audience_capabilities_immutable BEFORE UPDATE OR DELETE ON on_audience_capabilities FOR EACH ROW EXECUTE FUNCTION on_audience_history_immutable();
CREATE TRIGGER on_audience_revocations_immutable BEFORE UPDATE OR DELETE ON on_audience_revocations FOR EACH ROW EXECUTE FUNCTION on_audience_history_immutable();
CREATE TRIGGER on_audience_drafts_immutable BEFORE UPDATE OR DELETE ON on_audience_drafts FOR EACH ROW EXECUTE FUNCTION on_audience_history_immutable();
CREATE TRIGGER on_audience_approvals_immutable BEFORE UPDATE OR DELETE ON on_audience_approvals FOR EACH ROW EXECUTE FUNCTION on_audience_history_immutable();
CREATE TRIGGER on_audience_stops_immutable BEFORE UPDATE OR DELETE ON on_audience_stops FOR EACH ROW EXECUTE FUNCTION on_audience_history_immutable();
CREATE TRIGGER on_audience_commands_immutable BEFORE UPDATE OR DELETE ON on_audience_commands FOR EACH ROW EXECUTE FUNCTION on_audience_history_immutable();
CREATE TRIGGER on_audience_passes_immutable BEFORE UPDATE OR DELETE ON on_audience_delivery_passes FOR EACH ROW EXECUTE FUNCTION on_audience_history_immutable();
CREATE TRIGGER on_audience_deliveries_immutable BEFORE UPDATE OR DELETE ON on_audience_deliveries FOR EACH ROW EXECUTE FUNCTION on_audience_history_immutable();
`;
