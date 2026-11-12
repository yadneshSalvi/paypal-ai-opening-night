/**
 * Additive only. One row per strategy-agent or communications-writer run.
 *
 * The row is committed before any provider request, so a live model call is counted against the
 * per-production and global daily caps even when its response is lost. A row left in `dispatching`
 * is an unknown outcome, never a success. Recorded-output runs make no provider request and are
 * stored with mode `recorded`; they are never counted as live calls.
 * `document_cipher` holds the tenant-bound encrypted result (validated output, checks, failure).
 */
export const modelAgentsMigration = `
CREATE TABLE on_model_agent_runs (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
 agent text NOT NULL CHECK(agent IN ('strategy','writer')),
 mode text NOT NULL CHECK(mode IN ('live','recorded')),
 command_id uuid NOT NULL,
 actor_id text NOT NULL, session_hash text NOT NULL, base_revision integer NOT NULL,
 state text NOT NULL CHECK(state IN ('dispatching','completed','failed')),
 failure_code text, model text, response_id text, input_digest text NOT NULL, document_cipher text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 UNIQUE(tenant_id, agent, command_id)
);
CREATE INDEX on_model_agent_runs_tenant ON on_model_agent_runs(tenant_id, agent, created_at DESC);
CREATE INDEX on_model_agent_runs_live ON on_model_agent_runs(created_at) WHERE mode='live';
`;
