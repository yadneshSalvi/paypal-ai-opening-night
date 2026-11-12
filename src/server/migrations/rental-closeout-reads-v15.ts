/** Additive original-provider read history; return and approval records remain unchanged. */
export const rentalCloseoutReadsMigration = `
CREATE SEQUENCE on_rental_closeout_read_sequence;
CREATE TABLE on_rental_closeout_reads (
  tenant_id uuid NOT NULL, id uuid NOT NULL, grant_id uuid NOT NULL, intent_id uuid NOT NULL,
  sequence bigint NOT NULL UNIQUE, started_at timestamptz NOT NULL, digest text NOT NULL, document_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,grant_id) REFERENCES on_rental_closeout_grants(tenant_id,id)
);
CREATE INDEX on_rental_closeout_reads_original ON on_rental_closeout_reads(tenant_id,grant_id,sequence DESC);
CREATE TRIGGER on_rental_closeout_reads_immutable BEFORE UPDATE OR DELETE ON on_rental_closeout_reads FOR EACH ROW EXECUTE FUNCTION on_rental_closeout_immutable();
`;
