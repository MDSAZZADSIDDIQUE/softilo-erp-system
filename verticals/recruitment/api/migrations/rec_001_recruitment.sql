-- Softilo Recruitment edition: clients, workers, placements, rate cards, timesheets and AWR absences.
-- Runs after the core schema. Every table has tenant row-level security; approved timesheets are frozen.
-- Client invoices are core sales_invoices; worker pay accruals are core journal entries.

CREATE TABLE rec_consultants (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  email      text,
  archived   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Recruitment details for a core customer contact.
CREATE TABLE rec_clients (
  contact_id   uuid PRIMARY KEY REFERENCES contacts(id),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  -- Off-payroll working: medium/large clients make the IR35 status determination.
  client_size  text NOT NULL CHECK (client_size IN ('small','medium_large')),
  vat_code     text NOT NULL DEFAULT 'S20',
  terms_agreed_on date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rec_workers (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  first_name         text NOT NULL,
  last_name          text NOT NULL,
  email              text,
  phone              text,
  engagement         text NOT NULL CHECK (engagement IN ('paye','umbrella','ltd')),
  umbrella_name      text,
  company_name       text,
  company_number     text,
  ir35_status        text CHECK (ir35_status IN ('inside','outside')),
  kid_issued_on      date,
  -- Limited-company contractors may opt out of the Conduct Regulations before introduction.
  conduct_regs_opt_out boolean NOT NULL DEFAULT false,
  archived           boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (engagement <> 'umbrella' OR umbrella_name IS NOT NULL),
  CHECK (engagement <> 'ltd' OR company_name IS NOT NULL),
  CHECK (engagement = 'ltd' OR (ir35_status IS NULL AND NOT conduct_regs_opt_out))
);

CREATE TABLE rec_placements (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  number          text NOT NULL,
  client_id       uuid NOT NULL REFERENCES rec_clients(contact_id),
  worker_id       uuid NOT NULL REFERENCES rec_workers(id),
  consultant_id   uuid REFERENCES rec_consultants(id),
  job_title       text NOT NULL,
  start_date      date NOT NULL,
  end_date        date,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  holiday_rate    numeric(7,4) NOT NULL DEFAULT 0 CHECK (holiday_rate >= 0 AND holiday_rate < 1),
  on_cost_rate    numeric(7,4) NOT NULL DEFAULT 0 CHECK (on_cost_rate >= 0 AND on_cost_rate < 1),
  awr_applies     boolean NOT NULL,
  -- First day of the first assignment in this role with this hirer (may predate this placement).
  awr_start       date NOT NULL,
  sds_received_on date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX rec_placements_client ON rec_placements (tenant_id, client_id);

CREATE TABLE rec_placement_rates (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  placement_id uuid NOT NULL REFERENCES rec_placements(id),
  rate_type    text NOT NULL,
  pay_rate     numeric(19,4) NOT NULL CHECK (pay_rate >= 0),
  charge_rate  numeric(19,4) NOT NULL CHECK (charge_rate >= 0),
  UNIQUE (placement_id, rate_type)
);

CREATE TABLE rec_timesheets (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  number           text NOT NULL,
  placement_id     uuid NOT NULL REFERENCES rec_placements(id),
  week_ending      date NOT NULL,
  status           text NOT NULL CHECK (status IN ('draft','submitted','approved','rejected','invoiced')),
  hours            numeric(10,2) NOT NULL DEFAULT 0,
  pay              numeric(19,2) NOT NULL DEFAULT 0,
  holiday          numeric(19,2) NOT NULL DEFAULT 0,
  on_costs         numeric(19,2) NOT NULL DEFAULT 0,
  charge           numeric(19,2) NOT NULL DEFAULT 0,
  approved_by      text,
  approved_at      timestamptz,
  rejected_reason  text,
  accrual_entry_id uuid REFERENCES journal_entries(id),
  invoice_id       uuid REFERENCES sales_invoices(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  UNIQUE (placement_id, week_ending),
  CHECK (status NOT IN ('approved','invoiced') OR (accrual_entry_id IS NOT NULL AND approved_by IS NOT NULL)),
  CHECK (status <> 'invoiced' OR invoice_id IS NOT NULL)
);
CREATE INDEX rec_timesheets_status ON rec_timesheets (tenant_id, status);

CREATE TABLE rec_timesheet_lines (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  timesheet_id uuid NOT NULL REFERENCES rec_timesheets(id),
  date         date NOT NULL,
  rate_type    text NOT NULL,
  hours        numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24)
);

-- Rates used for each rate type, frozen at approval so later rate changes never move past invoices.
CREATE TABLE rec_timesheet_rates (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  timesheet_id uuid NOT NULL REFERENCES rec_timesheets(id),
  rate_type    text NOT NULL,
  hours        numeric(10,2) NOT NULL,
  pay_rate     numeric(19,4) NOT NULL,
  charge_rate  numeric(19,4) NOT NULL,
  pay          numeric(19,2) NOT NULL,
  charge       numeric(19,2) NOT NULL,
  UNIQUE (timesheet_id, rate_type)
);

CREATE TABLE rec_absences (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  placement_id uuid NOT NULL REFERENCES rec_placements(id),
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('annual_leave','sickness','jury_service','hirer_shutdown','strike',
                                               'pregnancy_maternity','family_leave','other')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

-- Once approved, a timesheet's hours and amounts are frozen: only approved → invoiced (with its invoice) may follow.
CREATE OR REPLACE FUNCTION rec_timesheet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved','invoiced') THEN
      RAISE EXCEPTION 'Timesheet % is approved and cannot be deleted', OLD.number USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'invoiced'
     OR (OLD.status = 'approved' AND ((to_jsonb(NEW) - 'status' - 'invoice_id') <> (to_jsonb(OLD) - 'status' - 'invoice_id')
                                      OR NEW.status NOT IN ('approved','invoiced'))) THEN
    RAISE EXCEPTION 'Timesheet % is approved and cannot be changed', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rec_timesheets_guard BEFORE UPDATE OR DELETE ON rec_timesheets FOR EACH ROW EXECUTE FUNCTION rec_timesheet_guard();

CREATE OR REPLACE FUNCTION rec_timesheet_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM rec_timesheets WHERE id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.timesheet_id ELSE NEW.timesheet_id END);
  IF st IN ('approved','invoiced') THEN
    RAISE EXCEPTION 'The timesheet is approved; its hours cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER rec_timesheet_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON rec_timesheet_lines FOR EACH ROW EXECUTE FUNCTION rec_timesheet_child_guard();
CREATE TRIGGER rec_timesheet_rates_guard BEFORE UPDATE OR DELETE ON rec_timesheet_rates FOR EACH ROW EXECUTE FUNCTION rec_timesheet_child_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rec_consultants','rec_clients','rec_workers','rec_placements','rec_placement_rates',
    'rec_timesheets','rec_timesheet_lines','rec_timesheet_rates','rec_absences'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO softilo_app', t);
  END LOOP;
END $$;
