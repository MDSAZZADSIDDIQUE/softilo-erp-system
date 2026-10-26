-- Softilo core schema.
-- Rules enforced here, not only in the app:
--   * every tenant table has row-level security keyed on app.tenant_id
--   * ledger, stock, VAT and audit tables are append-only
--   * every journal entry balances at commit
--   * nothing can be posted on or before the tenant's lock date
--   * manual journals cannot touch control accounts

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'softilo_app') THEN
    CREATE ROLE softilo_app NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: post a reversing entry instead', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$;

-- ---------------------------------------------------------------- platform (no RLS)

CREATE TABLE tenants (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  company_number  text,
  vat_number      text,
  vat_scheme      text NOT NULL DEFAULT 'standard' CHECK (vat_scheme IN ('standard','cash')),
  base_currency   char(3) NOT NULL DEFAULT 'GBP',
  lock_date       date,
  address         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id    uuid NOT NULL REFERENCES users(id),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  role       text NOT NULL CHECK (role IN ('owner','admin','finance','operations','accountant','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,          -- sha256 of the session token
  user_id     uuid NOT NULL REFERENCES users(id),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

-- ---------------------------------------------------------------- tenant tables

CREATE TABLE number_sequences (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  kind       text NOT NULL,
  prefix     text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE accounts (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  code       text NOT NULL,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  role       text,
  is_control boolean NOT NULL DEFAULT false,
  is_bank    boolean NOT NULL DEFAULT false,
  archived   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, code),
  UNIQUE (tenant_id, role)
);

CREATE TABLE journal_entries (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  number      text NOT NULL,
  date        date NOT NULL,
  memo        text NOT NULL,
  source_type text NOT NULL,
  source_id   uuid,
  reverses_id uuid REFERENCES journal_entries(id),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX journal_entries_date ON journal_entries (tenant_id, date);
CREATE INDEX journal_entries_source ON journal_entries (tenant_id, source_type, source_id);

CREATE TABLE journal_lines (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  entry_id     uuid NOT NULL REFERENCES journal_entries(id),
  line_no      int NOT NULL,
  account_code text NOT NULL,
  debit        numeric(19,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       numeric(19,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description  text,
  CHECK (debit = 0 OR credit = 0),
  CHECK (debit <> 0 OR credit <> 0),
  FOREIGN KEY (tenant_id, account_code) REFERENCES accounts(tenant_id, code),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX journal_lines_account ON journal_lines (tenant_id, account_code);

CREATE TABLE vat_entries (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  entry_id   uuid NOT NULL REFERENCES journal_entries(id),
  date       date NOT NULL,
  direction  text NOT NULL CHECK (direction IN ('sales','purchase')),
  vat_code   text NOT NULL,
  net        numeric(19,2) NOT NULL,
  vat        numeric(19,2) NOT NULL,
  vat_return_id uuid
);
CREATE INDEX vat_entries_date ON vat_entries (tenant_id, date);

CREATE TABLE contacts (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  kind             text NOT NULL CHECK (kind IN ('customer','supplier','both')),
  name             text NOT NULL,
  email            text,
  phone            text,
  company_number   text,
  vat_number       text,
  currency         char(3) NOT NULL DEFAULT 'GBP',
  payment_terms_days int NOT NULL DEFAULT 30,
  address          jsonb NOT NULL DEFAULT '{}',
  archived         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_name ON contacts (tenant_id, name);

CREATE TABLE warehouses (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  code       text NOT NULL,
  name       text NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE products (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  sku               text NOT NULL,
  name              text NOT NULL,
  description       text,
  uom               text NOT NULL DEFAULT 'each',
  hs_code           text,
  barcode           text,
  weight_kg         numeric(18,4),
  volume_m3         numeric(18,6),
  sales_price       numeric(19,4) NOT NULL DEFAULT 0,
  sales_vat_code    text NOT NULL DEFAULT 'S20',
  purchase_vat_code text NOT NULL DEFAULT 'S20',
  track_stock       boolean NOT NULL DEFAULT true,
  reorder_level     numeric(18,4),
  archived          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE stock_movements (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  date         date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('receipt','issue','return','landed_cost','adjustment')),
  quantity     numeric(18,4) NOT NULL,
  value        numeric(19,2) NOT NULL,
  source_type  text NOT NULL,
  source_id    uuid,
  -- Deferred so movements can be written before the journal whose amounts depend on them.
  entry_id     uuid REFERENCES journal_entries(id) DEFERRABLE INITIALLY DEFERRED,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product ON stock_movements (tenant_id, product_id, warehouse_id, date);

-- Projection of stock_movements, maintained in the same transaction; rebuildable at any time.
CREATE TABLE stock_balances (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  quantity     numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  value        numeric(19,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, product_id, warehouse_id),
  CHECK (quantity <> 0 OR value = 0)
);

CREATE TABLE purchase_orders (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  number        text NOT NULL,
  supplier_id   uuid NOT NULL REFERENCES contacts(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  date          date NOT NULL,
  expected_date date,
  currency      char(3) NOT NULL,
  rate          numeric(18,8) NOT NULL CHECK (rate > 0),
  status        text NOT NULL CHECK (status IN ('draft','approved','part_received','received','cancelled')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE purchase_order_lines (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  po_id        uuid NOT NULL REFERENCES purchase_orders(id),
  line_no      int NOT NULL,
  product_id   uuid NOT NULL REFERENCES products(id),
  description  text NOT NULL,
  quantity     numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price   numeric(19,6) NOT NULL CHECK (unit_price >= 0),
  vat_code     text NOT NULL,
  received_qty numeric(18,4) NOT NULL DEFAULT 0
);

CREATE TABLE goods_receipts (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  number       text NOT NULL,
  po_id        uuid NOT NULL REFERENCES purchase_orders(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  date         date NOT NULL,
  entry_id     uuid NOT NULL REFERENCES journal_entries(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE goods_receipt_lines (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  receipt_id    uuid NOT NULL REFERENCES goods_receipts(id),
  po_line_id    uuid NOT NULL REFERENCES purchase_order_lines(id),
  product_id    uuid NOT NULL REFERENCES products(id),
  quantity      numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost_gbp numeric(20,6) NOT NULL,
  value_gbp     numeric(19,2) NOT NULL,
  billed        boolean NOT NULL DEFAULT false,
  shipment_id   uuid
);

CREATE TABLE supplier_bills (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  number       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('bill','credit')),
  supplier_id  uuid NOT NULL REFERENCES contacts(id),
  supplier_ref text NOT NULL,
  date         date NOT NULL,
  due_date     date NOT NULL,
  currency     char(3) NOT NULL,
  rate         numeric(18,8) NOT NULL CHECK (rate > 0),
  total        numeric(19,2) NOT NULL,
  total_gbp    numeric(19,2) NOT NULL,
  amount_paid  numeric(19,2) NOT NULL DEFAULT 0,
  entry_id     uuid NOT NULL REFERENCES journal_entries(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE supplier_bill_lines (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  bill_id            uuid NOT NULL REFERENCES supplier_bills(id),
  line_no            int NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('receipt','account')),
  receipt_line_id    uuid REFERENCES goods_receipt_lines(id),
  account_code       text,
  description        text NOT NULL,
  net                numeric(19,2) NOT NULL,
  vat_code           text NOT NULL,
  vat                numeric(19,2) NOT NULL
);

CREATE TABLE shipments (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  number      text NOT NULL,
  reference   text,                -- container / bill of lading
  mrn         text,                -- customs entry (Movement Reference Number)
  date        date NOT NULL,
  status      text NOT NULL CHECK (status IN ('open','costed')),
  entry_id    uuid REFERENCES journal_entries(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
ALTER TABLE goods_receipt_lines ADD FOREIGN KEY (shipment_id) REFERENCES shipments(id);

CREATE TABLE shipment_costs (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  shipment_id  uuid NOT NULL REFERENCES shipments(id),
  description  text NOT NULL,
  amount_gbp   numeric(19,2) NOT NULL,
  method       text NOT NULL CHECK (method IN ('value','weight','volume','quantity'))
);

CREATE TABLE landed_cost_allocations (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  shipment_id     uuid NOT NULL REFERENCES shipments(id),
  cost_id         uuid NOT NULL REFERENCES shipment_costs(id),
  receipt_line_id uuid NOT NULL REFERENCES goods_receipt_lines(id),
  amount          numeric(19,2) NOT NULL
);

CREATE TABLE sales_invoices (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  number       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('invoice','credit')),
  customer_id  uuid NOT NULL REFERENCES contacts(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  customer_ref text,
  date         date NOT NULL,
  due_date     date NOT NULL,
  currency     char(3) NOT NULL,
  rate         numeric(18,8) NOT NULL CHECK (rate > 0),
  total        numeric(19,2) NOT NULL,
  total_gbp    numeric(19,2) NOT NULL,
  amount_paid  numeric(19,2) NOT NULL DEFAULT 0,
  credits_id   uuid REFERENCES sales_invoices(id),
  entry_id     uuid NOT NULL REFERENCES journal_entries(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE sales_invoice_lines (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  invoice_id   uuid NOT NULL REFERENCES sales_invoices(id),
  line_no      int NOT NULL,
  product_id   uuid REFERENCES products(id),
  description  text NOT NULL,
  quantity     numeric(18,4) NOT NULL,
  unit_price   numeric(19,6) NOT NULL,
  net          numeric(19,2) NOT NULL,
  vat_code     text NOT NULL,
  vat          numeric(19,2) NOT NULL,
  account_code text NOT NULL,
  cost_gbp     numeric(19,2) NOT NULL DEFAULT 0
);

CREATE TABLE payments (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  number            text NOT NULL,
  direction         text NOT NULL CHECK (direction IN ('receipt','payment')),
  contact_id        uuid NOT NULL REFERENCES contacts(id),
  bank_account_code text NOT NULL,
  date              date NOT NULL,
  currency          char(3) NOT NULL,
  rate              numeric(18,8) NOT NULL CHECK (rate > 0),
  amount            numeric(19,2) NOT NULL CHECK (amount > 0),
  reference         text,
  entry_id          uuid NOT NULL REFERENCES journal_entries(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE payment_allocations (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  payment_id    uuid NOT NULL REFERENCES payments(id),
  document_type text NOT NULL CHECK (document_type IN ('sales_invoice','supplier_bill')),
  document_id   uuid NOT NULL,
  amount        numeric(19,2) NOT NULL CHECK (amount > 0)
);

CREATE TABLE bank_transactions (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  bank_account_code text NOT NULL,
  date              date NOT NULL,
  description       text NOT NULL,
  reference         text,
  amount            numeric(19,2) NOT NULL,
  import_hash       text NOT NULL,
  status            text NOT NULL DEFAULT 'unreconciled' CHECK (status IN ('unreconciled','reconciled')),
  entry_id          uuid REFERENCES journal_entries(id),
  payment_id        uuid REFERENCES payments(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bank_account_code, import_hash)
);

CREATE TABLE pva_entries (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  statement   text NOT NULL,       -- e.g. 2026-09
  mrn         text NOT NULL,
  date        date NOT NULL,
  value_gbp   numeric(19,2) NOT NULL,
  vat_gbp     numeric(19,2) NOT NULL,
  shipment_id uuid REFERENCES shipments(id),
  entry_id    uuid NOT NULL REFERENCES journal_entries(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mrn)
);

CREATE TABLE vat_returns (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  period_key   text NOT NULL,
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  boxes        jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('finalised','submitted')),
  entry_id     uuid NOT NULL REFERENCES journal_entries(id),
  hmrc_receipt jsonb,
  submitted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_key)
);
ALTER TABLE vat_entries ADD FOREIGN KEY (vat_return_id) REFERENCES vat_returns(id);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid REFERENCES users(id),
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  data       jsonb NOT NULL DEFAULT '{}',
  ip         text,
  at         timestamptz NOT NULL DEFAULT now(),
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);
CREATE INDEX audit_log_tenant ON audit_log (tenant_id, id);

-- ---------------------------------------------------------------- integrity triggers

-- Every journal entry must balance and have at least two lines, checked at commit.
CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dr numeric; crd numeric; n int;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO dr, crd, n
    FROM journal_lines WHERE entry_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'Journal entry % has fewer than two lines', NEW.number USING ERRCODE = 'check_violation';
  END IF;
  IF dr <> crd THEN
    RAISE EXCEPTION 'Journal entry % does not balance (debits %, credits %)', NEW.number, dr, crd
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Nothing may be dated on or before the lock date.
CREATE OR REPLACE FUNCTION check_lock_date() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lock date;
BEGIN
  SELECT lock_date INTO lock FROM tenants WHERE id = NEW.tenant_id;
  IF lock IS NOT NULL AND NEW.date <= lock THEN
    RAISE EXCEPTION 'The books are locked up to %; cannot post on %', lock, NEW.date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_lock BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_lock_date();

-- Manual journals cannot post to control accounts (debtors, creditors, stock, GRNI, VAT).
CREATE OR REPLACE FUNCTION check_manual_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_entries e JOIN accounts a ON a.tenant_id = NEW.tenant_id AND a.code = NEW.account_code
     WHERE e.id = NEW.entry_id AND e.source_type = 'manual' AND a.is_control
  ) THEN
    RAISE EXCEPTION 'Account % is a control account and only accepts postings from its sub-ledger', NEW.account_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_line_manual_control BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION check_manual_control();

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- VAT entries are append-only except for being stamped with the return that includes them, once.
CREATE OR REPLACE FUNCTION vat_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.vat_return_id IS NOT NULL
     OR (to_jsonb(NEW) - 'vat_return_id') <> (to_jsonb(OLD) - 'vat_return_id') THEN
    RAISE EXCEPTION 'vat_entries is append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vat_entries_guard BEFORE UPDATE OR DELETE ON vat_entries FOR EACH ROW EXECUTE FUNCTION vat_entry_guard();

-- ---------------------------------------------------------------- row-level security

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'number_sequences','accounts','journal_entries','journal_lines','vat_entries','contacts','warehouses',
    'products','stock_movements','stock_balances','purchase_orders','purchase_order_lines','goods_receipts',
    'goods_receipt_lines','supplier_bills','supplier_bill_lines','shipments','shipment_costs',
    'landed_cost_allocations','sales_invoices','sales_invoice_lines','payments','payment_allocations',
    'bank_transactions','pva_entries','vat_returns','audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO softilo_app', t);
  END LOOP;
END $$;

-- The app role can read its own tenant row and update settings; it never sees other tenants.
-- (Not FORCEd: the platform connection, which owns the tables, creates tenants and runs sign-in.)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant()) WITH CHECK (id = current_tenant());
GRANT SELECT, UPDATE ON tenants TO softilo_app;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_members ON memberships USING (tenant_id = current_tenant());
GRANT SELECT ON memberships TO softilo_app;
GRANT SELECT (id, email, name) ON users TO softilo_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO softilo_app;

-- Ledger, stock and audit rows can never be changed or removed by the app, even before the triggers.
REVOKE UPDATE, DELETE ON journal_entries, journal_lines, stock_movements, audit_log FROM softilo_app;
REVOKE DELETE ON vat_entries FROM softilo_app;
