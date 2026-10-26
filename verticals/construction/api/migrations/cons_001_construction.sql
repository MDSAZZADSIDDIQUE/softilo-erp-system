-- Softilo Construction & Trades edition.
-- Applied after the core migrations (see migrate() calls in src/server.ts). Same rules as core:
-- RLS on every tenant table, append-only cost and verification history.

CREATE TABLE cons_settings (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id),
  contractor_utr      text,
  employer_ref        text,              -- PAYE reference, e.g. 123/AB45678
  accounts_office_ref text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cons_projects (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  code                text NOT NULL,
  name                text NOT NULL,
  customer_id         uuid NOT NULL REFERENCES contacts(id),
  site_address        text,
  contract_sum        numeric(19,2) NOT NULL CHECK (contract_sum >= 0),
  retention_rate      numeric(6,4) NOT NULL DEFAULT 0.05 CHECK (retention_rate >= 0 AND retention_rate <= 0.2),
  vat_rate            text NOT NULL DEFAULT 'standard' CHECK (vat_rate IN ('standard','reduced','zero')),
  customer_cis_registered boolean NOT NULL DEFAULT true,
  end_user_notice     boolean NOT NULL DEFAULT false,   -- written end-user / intermediary confirmation held
  five_percent_disregard boolean NOT NULL DEFAULT false,
  due_days            int NOT NULL DEFAULT 7 CHECK (due_days >= 0),
  final_days          int NOT NULL DEFAULT 17 CHECK (final_days >= 0),
  payment_notice_days int NOT NULL DEFAULT 5 CHECK (payment_notice_days >= 0),
  pay_less_days       int NOT NULL DEFAULT 7 CHECK (pay_less_days >= 0),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','complete','closed')),
  start_date          date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE cons_budget_lines (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  project_id  uuid NOT NULL REFERENCES cons_projects(id),
  category    text NOT NULL CHECK (category IN ('labour','materials','plant','other')),
  description text NOT NULL,
  amount      numeric(19,2) NOT NULL CHECK (amount >= 0)
);

CREATE TABLE cons_variations (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  project_id  uuid NOT NULL REFERENCES cons_projects(id),
  number      text NOT NULL,
  description text NOT NULL,
  amount      numeric(19,2) NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  date        date NOT NULL,
  decided_at  timestamptz,
  UNIQUE (project_id, number)
);

CREATE TABLE cons_subcontractors (
  contact_id          uuid PRIMARY KEY REFERENCES contacts(id),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  business_type       text NOT NULL CHECK (business_type IN ('sole_trader','partnership','company','trust')),
  utr                 text NOT NULL CHECK (utr ~ '^\d{10}$'),
  nino                text,
  company_number      text,
  cis_status          text NOT NULL DEFAULT 'unverified' CHECK (cis_status IN ('unverified','gross','net','unmatched')),
  verification_number text,
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Every verification request and HMRC's answer, kept for evidence.
CREATE TABLE cons_verifications (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  contact_id          uuid NOT NULL REFERENCES cons_subcontractors(contact_id),
  status              text NOT NULL,
  verification_number text,
  gateway             text NOT NULL,
  response            jsonb NOT NULL DEFAULT '{}',
  at                  timestamptz NOT NULL DEFAULT now()
);

-- A job bill is a core supplier bill tagged to a project, with its CIS figures.
CREATE TABLE cons_job_bills (
  supplier_bill_id uuid PRIMARY KEY REFERENCES supplier_bills(id),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  project_id       uuid NOT NULL REFERENCES cons_projects(id),
  cis_status       text CHECK (cis_status IN ('gross','net','unmatched')),   -- null: not a CIS payment
  cis_rate         numeric(5,4),
  gross            numeric(19,2) NOT NULL,
  materials        numeric(19,2) NOT NULL,
  deduction        numeric(19,2) NOT NULL DEFAULT 0,
  payable          numeric(19,2) NOT NULL
);

-- Job cost ledger: one row per cost line, written in the same transaction as the journal.
CREATE TABLE cons_cost_entries (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  project_id  uuid NOT NULL REFERENCES cons_projects(id),
  date        date NOT NULL,
  category    text NOT NULL CHECK (category IN ('labour','materials','plant','other')),
  description text NOT NULL,
  amount      numeric(19,2) NOT NULL,
  source_type text NOT NULL,
  source_id   uuid NOT NULL,
  entry_id    uuid NOT NULL REFERENCES journal_entries(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cons_cost_entries_project ON cons_cost_entries (tenant_id, project_id, category);

CREATE TABLE cons_applications (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  project_id         uuid NOT NULL REFERENCES cons_projects(id),
  application_no     int NOT NULL,
  reference          text NOT NULL,
  sales_invoice_id   uuid NOT NULL REFERENCES sales_invoices(id),
  stage              text NOT NULL CHECK (stage IN ('interim','practical_completion','final')),
  period_end         date NOT NULL,
  date               date NOT NULL,
  gross_to_date      numeric(19,2) NOT NULL,
  retention_rate     numeric(6,4) NOT NULL,
  retention_to_date  numeric(19,2) NOT NULL,
  net_to_date        numeric(19,2) NOT NULL,
  previous_net       numeric(19,2) NOT NULL,
  retention_movement numeric(19,2) NOT NULL,
  amount_due         numeric(19,2) NOT NULL CHECK (amount_due > 0),
  vat_code           text NOT NULL,
  vat                numeric(19,2) NOT NULL,
  total              numeric(19,2) NOT NULL,
  due_date           date NOT NULL,
  final_date         date NOT NULL,
  payment_notice_by  date NOT NULL,
  pay_less_by        date NOT NULL,
  entry_id           uuid NOT NULL REFERENCES journal_entries(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, application_no),
  UNIQUE (tenant_id, reference)
);

CREATE TABLE cons_cis_returns (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  tax_month_end  date NOT NULL,
  nil            boolean NOT NULL,
  payload        jsonb NOT NULL,
  total_deducted numeric(19,2) NOT NULL,
  gateway        text NOT NULL,
  hmrc_receipt   jsonb NOT NULL,
  submitted_by   uuid REFERENCES users(id),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tax_month_end)
);

CREATE TRIGGER cons_cost_entries_append_only BEFORE UPDATE OR DELETE ON cons_cost_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER cons_verifications_append_only BEFORE UPDATE OR DELETE ON cons_verifications FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER cons_applications_append_only BEFORE UPDATE OR DELETE ON cons_applications FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER cons_job_bills_append_only BEFORE UPDATE OR DELETE ON cons_job_bills FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER cons_cis_returns_append_only BEFORE UPDATE OR DELETE ON cons_cis_returns FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cons_settings','cons_projects','cons_budget_lines','cons_variations','cons_subcontractors','cons_verifications',
    'cons_job_bills','cons_cost_entries','cons_applications','cons_cis_returns'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO softilo_app', t);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON cons_cost_entries, cons_verifications, cons_applications, cons_job_bills, cons_cis_returns FROM softilo_app;
