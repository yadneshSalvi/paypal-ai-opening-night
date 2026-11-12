/** Immutable typed strategy, tour assignment and requirements-learning reviews. */
export const planningWorkbenchMigration = `
CREATE TABLE on_planning_workbench_reviews (
 tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('strategies','tour','learning')),
 actor_id text NOT NULL, session_hash text NOT NULL, expires_at timestamptz NOT NULL, fingerprint text NOT NULL,
 base_revision integer NOT NULL, review_cipher text NOT NULL, review_digest text NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE on_planning_workbench_commands (
 tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), command_id uuid NOT NULL, actor_id text NOT NULL, session_hash text NOT NULL,
 expires_at timestamptz NOT NULL, fingerprint text NOT NULL, request_digest text NOT NULL, receipt_cipher text NOT NULL, receipt_digest text NOT NULL,
 accepted_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE on_planning_workbench_admissions (
 tenant_id uuid NOT NULL, review_id uuid NOT NULL, command_id uuid NOT NULL, admitted_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,review_id), FOREIGN KEY(tenant_id,review_id) REFERENCES on_planning_workbench_reviews(tenant_id,id),
 FOREIGN KEY(tenant_id,command_id) REFERENCES on_planning_workbench_commands(tenant_id,command_id)
);
CREATE INDEX on_planning_workbench_review_time ON on_planning_workbench_reviews(tenant_id,created_at DESC);
CREATE FUNCTION on_planning_workbench_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable planning workbench evidence'; END $$;
CREATE TRIGGER on_planning_workbench_reviews_immutable BEFORE UPDATE OR DELETE ON on_planning_workbench_reviews FOR EACH ROW EXECUTE FUNCTION on_planning_workbench_immutable();
CREATE TRIGGER on_planning_workbench_commands_immutable BEFORE UPDATE OR DELETE ON on_planning_workbench_commands FOR EACH ROW EXECUTE FUNCTION on_planning_workbench_immutable();
CREATE TRIGGER on_planning_workbench_admissions_immutable BEFORE UPDATE OR DELETE ON on_planning_workbench_admissions FOR EACH ROW EXECUTE FUNCTION on_planning_workbench_immutable();
`;
