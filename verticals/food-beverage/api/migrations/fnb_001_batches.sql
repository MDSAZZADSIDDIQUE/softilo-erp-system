-- Softilo Food & Beverage: batches (lots), date marks and batch movements.
-- Runs after the core migrations (packages/db/migrations). Same rules as the core:
--   * every table has row-level security keyed on app.tenant_id
--   * batch movements are append-only; balances are a projection rebuilt from them
--   * batches carry quantity only: value stays at weighted average in stock_movements/stock_balances

-- Food settings per product. Products without a row are not batch-tracked.
CREATE TABLE fnb_product_settings (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  product_id      uuid NOT NULL REFERENCES products(id),
  batch_tracked   boolean NOT NULL DEFAULT true,
  date_type       text NOT NULL DEFAULT 'use_by' CHECK (date_type IN ('use_by','best_before')),
  shelf_life_days int CHECK (shelf_life_days >= 0),
  storage         text NOT NULL DEFAULT 'ambient' CHECK (storage IN ('ambient','chilled','frozen')),
  -- The 14 regulated allergens (retained Regulation 1169/2011, Annex II).
  allergens       text[] NOT NULL DEFAULT '{}' CHECK (allergens <@ ARRAY[
    'gluten','crustaceans','eggs','fish','peanuts','soybeans','milk','nuts',
    'celery','mustard','sesame','sulphites','lupin','molluscs']::text[]),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id)
);

-- Customer requirements, e.g. supermarkets and caterers who need N days of life left on delivery.
CREATE TABLE fnb_customer_settings (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  contact_id    uuid NOT NULL REFERENCES contacts(id),
  min_life_days int NOT NULL DEFAULT 0 CHECK (min_life_days >= 0 AND min_life_days <= 3650),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id)
);

CREATE TABLE fnb_batches (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  code         text NOT NULL CHECK (length(code) BETWEEN 1 AND 60),
  expiry       date,
  date_type    text NOT NULL CHECK (date_type IN ('use_by','best_before')),
  supplier_id  uuid REFERENCES contacts(id),
  receipt_id   uuid REFERENCES goods_receipts(id),   -- first receipt (one step back)
  received_on  date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_id, code)
);
CREATE INDEX fnb_batches_expiry ON fnb_batches (tenant_id, expiry);

CREATE TABLE fnb_batch_movements (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  batch_id       uuid NOT NULL REFERENCES fnb_batches(id),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  date           date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('receipt','dispatch','return','write_off','adjustment')),
  quantity       numeric(18,4) NOT NULL CHECK (quantity <> 0),
  source_type    text NOT NULL,
  source_id      uuid,
  source_line_id uuid,
  contact_id     uuid REFERENCES contacts(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('receipt','return') AND quantity > 0) OR (kind IN ('dispatch','write_off') AND quantity < 0) OR kind = 'adjustment')
);
CREATE INDEX fnb_batch_movements_batch ON fnb_batch_movements (tenant_id, batch_id, date);
CREATE INDEX fnb_batch_movements_source ON fnb_batch_movements (tenant_id, source_type, source_id);

-- Projection of fnb_batch_movements, maintained in the same transaction.
CREATE TABLE fnb_batch_balances (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  batch_id     uuid NOT NULL REFERENCES fnb_batches(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  quantity     numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (tenant_id, batch_id, warehouse_id)
);

CREATE TRIGGER fnb_batch_movements_append_only BEFORE UPDATE OR DELETE ON fnb_batch_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fnb_product_settings','fnb_customer_settings','fnb_batches','fnb_batch_movements','fnb_batch_balances'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO softilo_app', t);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON fnb_batch_movements FROM softilo_app;
-- A batch's identity (product, code, date mark) is fixed once received.
REVOKE UPDATE, DELETE ON fnb_batches FROM softilo_app;
