/** Navigation authority is additive metadata. Existing show snapshots and receipts are never rewritten. */
export const rehearsalsMigration = `
  CREATE TABLE on_rehearsal_workspaces (
    id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE on_rehearsal_members (
    tenant_id uuid PRIMARY KEY REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES on_rehearsal_workspaces(id) ON DELETE CASCADE,
    actor_id text NOT NULL UNIQUE, actor jsonb NOT NULL,
    label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 64),
    authority_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), last_opened_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX on_rehearsal_members_workspace ON on_rehearsal_members(workspace_id,last_opened_at DESC,tenant_id);
  CREATE TABLE on_rehearsal_requests (
    workspace_id uuid NOT NULL REFERENCES on_rehearsal_workspaces(id) ON DELETE CASCADE,
    request_id uuid NOT NULL, payload_hash text NOT NULL, kind text NOT NULL CHECK(kind IN ('create','switch','rename')),
    source_tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), target_tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id),
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,request_id)
  );
`;
