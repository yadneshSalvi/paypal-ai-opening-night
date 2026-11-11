/** Additive only. No existing show, payment, receipt or session is rewritten. */
export const supplierMigration = `
  CREATE TABLE on_supplier_requests (
    tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    supplier_id text NOT NULL CHECK(supplier_id IN ('brightline','northside','sister')),
    request_id uuid NOT NULL, payload_hash text NOT NULL, response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,supplier_id,request_id)
  );
  CREATE TABLE on_supplier_quotes (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    supplier_id text NOT NULL, revision integer NOT NULL, valid_until timestamptz NOT NULL,
    document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,supplier_id,revision)
  );
  CREATE INDEX on_supplier_quotes_tenant ON on_supplier_quotes(tenant_id,created_at);
  CREATE TABLE on_supplier_rfqs (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    actor_id text NOT NULL, expected_revision integer NOT NULL, payload_hash text NOT NULL,
    status text NOT NULL CHECK(status IN ('collecting','applied','needs_review')),
    request_ids jsonb NOT NULL, quote_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    last_code text, created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz
  );
  CREATE INDEX on_supplier_rfqs_tenant ON on_supplier_rfqs(tenant_id,created_at);
  CREATE TABLE on_rental_executions (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    plan_version integer NOT NULL, plan_digest text NOT NULL, quote_id uuid NOT NULL REFERENCES on_supplier_quotes(id),
    document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,plan_version)
  );
  CREATE TABLE on_resource_holds (
    id uuid PRIMARY KEY REFERENCES on_rental_executions(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    supplier_id text NOT NULL, unit_id text NOT NULL,
    window_start timestamptz NOT NULL, window_end timestamptz NOT NULL CHECK(window_end>window_start),
    status text NOT NULL CHECK(status IN ('provisional','confirmed','expired','released','returned')),
    expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX on_resource_holds_inventory ON on_resource_holds(tenant_id,supplier_id,unit_id,window_start,window_end);
  CREATE TABLE on_delivery_receipts (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    execution_id uuid NOT NULL REFERENCES on_rental_executions(id), version integer NOT NULL,
    nonce_hash text NOT NULL UNIQUE, document jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(execution_id,version)
  );
  CREATE INDEX on_delivery_receipts_tenant ON on_delivery_receipts(tenant_id,execution_id);
`;
