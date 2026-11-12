/** Additive immutable interruption, decision and original-capture allocation history. */
export const disruptionsMigration = `
CREATE TABLE on_disruption_records (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('report','assessment','decision')), digest text NOT NULL,
  document_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id)
);
CREATE INDEX on_disruption_records_history ON on_disruption_records(tenant_id,kind,created_at);
CREATE TABLE on_disruption_commands (
  tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id), command_id uuid NOT NULL,
  actor_id text NOT NULL, session_hash text NOT NULL, payload_hash text NOT NULL,
  receipt_cipher text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE on_event_remedy_items (
  tenant_id uuid NOT NULL, id uuid NOT NULL, decision_id uuid NOT NULL, ticket_id uuid NOT NULL,
  digest text NOT NULL, allocation_cipher text NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,decision_id,ticket_id),
  FOREIGN KEY(tenant_id,decision_id) REFERENCES on_disruption_records(tenant_id,id)
);
CREATE TABLE on_event_remedy_progress (
  tenant_id uuid NOT NULL, item_id uuid NOT NULL, intent_id uuid,
  last_code text, dispatch_authorized_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,item_id), UNIQUE(tenant_id,intent_id),
  FOREIGN KEY(tenant_id,item_id) REFERENCES on_event_remedy_items(tenant_id,id)
);
CREATE TABLE on_disruption_stops (
  tenant_id uuid NOT NULL, decision_id uuid NOT NULL, actor_id text NOT NULL, stopped_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  detail_cipher text NOT NULL, PRIMARY KEY(tenant_id,decision_id),
  FOREIGN KEY(tenant_id,decision_id) REFERENCES on_disruption_records(tenant_id,id)
);
CREATE FUNCTION on_disruption_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Disruption and cancellation history is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER on_disruption_records_immutable BEFORE UPDATE OR DELETE ON on_disruption_records FOR EACH ROW EXECUTE FUNCTION on_disruption_immutable();
CREATE TRIGGER on_disruption_commands_immutable BEFORE UPDATE OR DELETE ON on_disruption_commands FOR EACH ROW EXECUTE FUNCTION on_disruption_immutable();
CREATE TRIGGER on_event_remedy_items_immutable BEFORE UPDATE OR DELETE ON on_event_remedy_items FOR EACH ROW EXECUTE FUNCTION on_disruption_immutable();
CREATE TRIGGER on_disruption_stops_immutable BEFORE UPDATE OR DELETE ON on_disruption_stops FOR EACH ROW EXECUTE FUNCTION on_disruption_immutable();
`;
