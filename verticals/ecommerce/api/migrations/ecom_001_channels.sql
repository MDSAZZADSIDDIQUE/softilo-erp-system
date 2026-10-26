-- E-commerce edition: sales channels, imported orders, payouts and customer returns.
-- Runs after the core schema (packages/db/migrations). Same rules as the core:
--   * every table has row-level security keyed on app.tenant_id
--   * payout lines are append-only (corrections are new payouts or adjustments)
--   * money is numeric, never float
-- Orders become core sales_invoices; returns become core credit notes; payouts post a core journal.

CREATE TABLE ecom_channels (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  kind              text NOT NULL CHECK (kind IN ('shopify','woocommerce','amazon','ebay','tiktok')),
  name              text NOT NULL,
  -- The customer account the channel's orders are invoiced to (what the channel owes us sits in debtors).
  contact_id        uuid NOT NULL REFERENCES contacts(id),
  warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  bank_account_code text NOT NULL,
  fee_vat_code      text NOT NULL CHECK (fee_vat_code IN ('S20','RC20','EX','OS')),
  vat_treatment     text NOT NULL DEFAULT 'seller' CHECK (vat_treatment IN ('seller','marketplace','export')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE ecom_orders (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  channel_id     uuid NOT NULL REFERENCES ecom_channels(id),
  external_id    text NOT NULL,
  order_number   text NOT NULL,
  date           date NOT NULL,
  currency       char(3) NOT NULL,
  customer_name  text NOT NULL,
  customer_email text,
  ship_country   text,
  vat_treatment  text NOT NULL CHECK (vat_treatment IN ('seller','marketplace','export')),
  total          numeric(19,2) NOT NULL,
  invoice_id     uuid NOT NULL REFERENCES sales_invoices(id),
  raw            jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Re-importing the same file never creates a second invoice.
  UNIQUE (tenant_id, channel_id, external_id)
);
CREATE INDEX ecom_orders_date ON ecom_orders (tenant_id, date);

CREATE TABLE ecom_returns (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  number           text NOT NULL,
  order_id         uuid NOT NULL REFERENCES ecom_orders(id),
  credit_note_id   uuid NOT NULL REFERENCES sales_invoices(id),
  received_date    date NOT NULL,
  -- Consumer Contracts Regulations 2013, reg. 34: refund within 14 days of getting the goods back.
  refund_due_by    date NOT NULL,
  reason           text,
  refund           numeric(19,2) NOT NULL CHECK (refund > 0),
  deduction        numeric(19,2) NOT NULL DEFAULT 0 CHECK (deduction >= 0),
  shipping_refunded boolean NOT NULL DEFAULT false,
  entry_id         uuid NOT NULL REFERENCES journal_entries(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE ecom_return_lines (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  return_id       uuid NOT NULL REFERENCES ecom_returns(id),
  invoice_line_id uuid NOT NULL REFERENCES sales_invoice_lines(id),
  quantity        numeric(18,4) NOT NULL CHECK (quantity > 0),
  net             numeric(19,2) NOT NULL,
  vat             numeric(19,2) NOT NULL,
  cost_gbp        numeric(19,2) NOT NULL,
  disposition     text NOT NULL CHECK (disposition IN ('restock','write_off','delivery'))
);

CREATE TABLE ecom_payouts (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  number            text NOT NULL,
  channel_id        uuid NOT NULL REFERENCES ecom_channels(id),
  external_id       text NOT NULL,
  date              date NOT NULL,
  currency          char(3) NOT NULL,
  amount            numeric(19,2) NOT NULL,
  sales             numeric(19,2) NOT NULL,
  refunds           numeric(19,2) NOT NULL,
  fees_net          numeric(19,2) NOT NULL,
  fees_vat          numeric(19,2) NOT NULL,
  fee_vat_code      text NOT NULL,
  reserves          numeric(19,2) NOT NULL,
  adjustments       numeric(19,2) NOT NULL,
  bank_account_code text NOT NULL,
  entry_id          uuid NOT NULL REFERENCES journal_entries(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, channel_id, external_id)
);

CREATE TABLE ecom_payout_lines (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  payout_id   uuid NOT NULL REFERENCES ecom_payouts(id),
  line_no     int NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('order','refund','fee','reserve','adjustment')),
  order_ref   text,
  order_id    uuid REFERENCES ecom_orders(id),
  amount      numeric(19,2) NOT NULL,
  description text NOT NULL,
  UNIQUE (payout_id, line_no)
);

CREATE TRIGGER ecom_payouts_append_only BEFORE UPDATE OR DELETE ON ecom_payouts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ecom_payout_lines_append_only BEFORE UPDATE OR DELETE ON ecom_payout_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ecom_return_lines_append_only BEFORE UPDATE OR DELETE ON ecom_return_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ecom_channels','ecom_orders','ecom_returns','ecom_return_lines','ecom_payouts','ecom_payout_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO softilo_app', t);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON ecom_payouts, ecom_payout_lines, ecom_return_lines FROM softilo_app;
