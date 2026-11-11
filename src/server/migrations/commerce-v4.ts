/** Additive only: existing snapshots, receipts and original rental identities are untouched. */
export const commerceMigration = `
  CREATE TABLE on_wallet_setups (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    semantic_key text NOT NULL, provider_setup_id text UNIQUE, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,semantic_key)
  );
  CREATE TABLE on_wallet_operations (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    setup_id uuid NOT NULL REFERENCES on_wallet_setups(id) ON DELETE CASCADE,
    phase text NOT NULL CHECK(phase IN ('setup','exchange')), request_id uuid NOT NULL UNIQUE,
    document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(setup_id,phase)
  );
  CREATE TABLE on_saved_wallets (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    setup_id uuid NOT NULL UNIQUE REFERENCES on_wallet_setups(id), seller text NOT NULL CHECK(seller='venue'),
    provider_token_id text NOT NULL, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(seller,provider_token_id)
  );
  CREATE TABLE on_ticket_cohorts (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL UNIQUE REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE on_cohort_tickets (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    cohort_id uuid NOT NULL REFERENCES on_ticket_cohorts(id) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 80), tier text NOT NULL CHECK(tier IN ('standard','vip')),
    amount_minor integer NOT NULL, root_intent_id uuid, capture_intent_id uuid, document jsonb NOT NULL,
    CHECK((ordinal<=42 AND tier='standard' AND amount_minor=3500) OR (ordinal>42 AND tier='vip' AND amount_minor=5000)),
    UNIQUE(cohort_id,ordinal), UNIQUE(root_intent_id), UNIQUE(capture_intent_id)
  );
  CREATE INDEX on_cohort_tickets_tenant ON on_cohort_tickets(tenant_id,cohort_id);
  CREATE TABLE on_remedy_batches (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL UNIQUE REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE on_remedy_items (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES on_shows(tenant_id) ON DELETE CASCADE,
    batch_id uuid NOT NULL REFERENCES on_remedy_batches(id) ON DELETE CASCADE,
    ticket_id uuid NOT NULL, capture_id text NOT NULL, amount_minor integer NOT NULL CHECK(amount_minor=1500),
    ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 38), intent_id uuid, document jsonb NOT NULL,
    UNIQUE(batch_id,ordinal), UNIQUE(tenant_id,ticket_id), UNIQUE(tenant_id,capture_id), UNIQUE(intent_id)
  );
`;
