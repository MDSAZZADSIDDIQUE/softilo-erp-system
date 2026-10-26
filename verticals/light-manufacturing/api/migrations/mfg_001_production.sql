-- Softilo light manufacturing: work centres, multi-level BOMs, works orders.
-- Runs after the core migrations. Same rules as core:
--   * every table has row-level security keyed on app.tenant_id
--   * BOM lines/operations and works-order transactions are append-only
--     (a BOM change is a new version; a correction is a new transaction)

CREATE TABLE mfg_work_centres (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,
  name          text NOT NULL,
  labour_rate   numeric(19,4) NOT NULL CHECK (labour_rate >= 0),    -- £ per hour
  overhead_rate numeric(19,4) NOT NULL CHECK (overhead_rate >= 0),  -- £ per hour, from budget ÷ normal capacity
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE mfg_boms (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  product_id  uuid NOT NULL REFERENCES products(id),
  version     int NOT NULL CHECK (version > 0),
  output_qty  numeric(18,4) NOT NULL CHECK (output_qty > 0),
  is_active   boolean NOT NULL DEFAULT false,
  notes       text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_id, version)
);
CREATE UNIQUE INDEX mfg_boms_one_active ON mfg_boms (tenant_id, product_id) WHERE is_active;

CREATE TABLE mfg_bom_lines (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  bom_id       uuid NOT NULL REFERENCES mfg_boms(id),
  line_no      int NOT NULL,
  component_id uuid NOT NULL REFERENCES products(id),
  quantity     numeric(18,4) NOT NULL CHECK (quantity > 0),
  wastage_pct  numeric(7,4) NOT NULL DEFAULT 0 CHECK (wastage_pct >= 0 AND wastage_pct < 1000),
  UNIQUE (bom_id, line_no)
);

CREATE TABLE mfg_bom_operations (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  bom_id             uuid NOT NULL REFERENCES mfg_boms(id),
  seq                int NOT NULL,
  work_centre_id     uuid NOT NULL REFERENCES mfg_work_centres(id),
  description        text NOT NULL,
  setup_hours        numeric(10,4) NOT NULL DEFAULT 0 CHECK (setup_hours >= 0),
  run_hours_per_unit numeric(12,6) NOT NULL DEFAULT 0 CHECK (run_hours_per_unit >= 0),
  UNIQUE (bom_id, seq)
);

CREATE TABLE mfg_works_orders (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  number        text NOT NULL,
  product_id    uuid NOT NULL REFERENCES products(id),
  bom_id        uuid NOT NULL REFERENCES mfg_boms(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),
  completed_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (completed_qty >= 0),
  scrapped_qty  numeric(18,4) NOT NULL DEFAULT 0 CHECK (scrapped_qty >= 0),
  status        text NOT NULL CHECK (status IN ('planned','released','completed','cancelled')),
  due_date      date,
  notes         text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  completed_at  timestamptz,
  UNIQUE (tenant_id, number)
);
CREATE INDEX mfg_works_orders_status ON mfg_works_orders (tenant_id, status);

-- Requirements snapshot taken when the order is created; later BOM versions never change it.
CREATE TABLE mfg_works_order_components (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  works_order_id uuid NOT NULL REFERENCES mfg_works_orders(id),
  product_id     uuid NOT NULL REFERENCES products(id),
  required_qty   numeric(18,4) NOT NULL CHECK (required_qty > 0),
  issued_qty     numeric(18,4) NOT NULL DEFAULT 0,
  UNIQUE (works_order_id, product_id)
);

-- Every movement of value into or out of an order's WIP. Σ value = the order's WIP balance,
-- and Σ over all orders = the WIP account in the ledger.
CREATE TABLE mfg_wo_transactions (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  works_order_id uuid NOT NULL REFERENCES mfg_works_orders(id),
  date           date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('issue','labour','overhead','complete','scrap','variance')),
  product_id     uuid REFERENCES products(id),
  work_centre_id uuid REFERENCES mfg_work_centres(id),
  quantity       numeric(18,4),
  hours          numeric(10,4),
  value          numeric(19,2) NOT NULL,   -- + into WIP, − out of WIP
  -- Null only for zero-value bookings, which post no journal.
  entry_id       uuid REFERENCES journal_entries(id) DEFERRABLE INITIALLY DEFERRED,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfg_wo_transactions_order ON mfg_wo_transactions (tenant_id, works_order_id);

CREATE TRIGGER mfg_bom_lines_append_only BEFORE UPDATE OR DELETE ON mfg_bom_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER mfg_bom_operations_append_only BEFORE UPDATE OR DELETE ON mfg_bom_operations FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER mfg_wo_transactions_append_only BEFORE UPDATE OR DELETE ON mfg_wo_transactions FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mfg_work_centres','mfg_boms','mfg_bom_lines','mfg_bom_operations',
    'mfg_works_orders','mfg_works_order_components','mfg_wo_transactions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO softilo_app', t);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON mfg_bom_lines, mfg_bom_operations, mfg_wo_transactions FROM softilo_app;
