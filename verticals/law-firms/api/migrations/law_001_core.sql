-- Softilo for Law Firms: clients, matters, time, fee notes, matter ledgers and reconciliations.
-- Runs after the core migrations. Rules enforced here, not only in the app:
--   * every table has row-level security keyed on app.tenant_id
--   * the matter ledger is append-only
--   * no matter's client ledger may be overdrawn on any date (SRA Accounts Rules 2019, rule 5.3)
--   * billed time and signed-off reconciliations cannot be changed

-- ---------------------------------------------------------------- tables

-- Law details for a client; the client itself is a core contact, so fee notes sit on the usual debtors ledger.
CREATE TABLE law_clients (
  contact_id   uuid PRIMARY KEY REFERENCES contacts(id),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  client_type  text NOT NULL CHECK (client_type IN ('individual','organisation')),
  cdd_status   text NOT NULL DEFAULT 'pending' CHECK (cdd_status IN ('pending','complete')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE law_fee_earners (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  initials     text NOT NULL,
  hourly_rate  numeric(19,2) NOT NULL CHECK (hourly_rate >= 0),
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, initials)
);

CREATE TABLE law_matters (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  number        text NOT NULL,
  client_id     uuid NOT NULL REFERENCES law_clients(contact_id),
  description   text NOT NULL,
  fee_earner_id uuid NOT NULL REFERENCES law_fee_earners(id),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_on     date NOT NULL,
  closed_on     date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX law_matters_client ON law_matters (tenant_id, client_id);

CREATE TABLE law_fee_notes (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  number         text NOT NULL,
  matter_id      uuid NOT NULL REFERENCES law_matters(id),
  date           date NOT NULL,
  vat_code       text NOT NULL,
  net            numeric(19,2) NOT NULL CHECK (net > 0),
  vat            numeric(19,2) NOT NULL CHECK (vat >= 0),
  total          numeric(19,2) NOT NULL,
  amount_settled numeric(19,2) NOT NULL DEFAULT 0,
  entry_id       uuid NOT NULL REFERENCES journal_entries(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (total = net + vat),
  CHECK (amount_settled >= 0 AND amount_settled <= total)
);

CREATE TABLE law_time_entries (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  matter_id     uuid NOT NULL REFERENCES law_matters(id),
  fee_earner_id uuid NOT NULL REFERENCES law_fee_earners(id),
  date          date NOT NULL,
  minutes       int NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  units         int NOT NULL CHECK (units > 0),
  rate          numeric(19,2) NOT NULL CHECK (rate >= 0),
  value         numeric(19,2) NOT NULL CHECK (value >= 0),
  narrative     text NOT NULL,
  fee_note_id   uuid REFERENCES law_fee_notes(id),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX law_time_matter ON law_time_entries (tenant_id, matter_id, fee_note_id);

-- The matter ledger. Each row is written in the same transaction as the journal it belongs to.
-- side = 'client': money held for the client (positive = in, negative = out).
-- side = 'office': money the client owes the firm (positive = billed, negative = paid).
CREATE TABLE law_ledger_entries (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  matter_id    uuid NOT NULL REFERENCES law_matters(id),
  entry_id     uuid NOT NULL REFERENCES journal_entries(id),
  date         date NOT NULL,
  side         text NOT NULL CHECK (side IN ('client','office')),
  kind         text NOT NULL CHECK (kind IN ('receipt','payment','transfer','fee_note')),
  amount       numeric(19,2) NOT NULL CHECK (amount <> 0),
  counterparty text,
  reference    text,
  fee_note_id  uuid REFERENCES law_fee_notes(id),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX law_ledger_matter ON law_ledger_entries (tenant_id, matter_id, side, date);

CREATE TABLE law_reconciliations (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  statement_date         date NOT NULL,
  statement_balance      numeric(19,2) NOT NULL,
  outstanding_lodgements jsonb NOT NULL DEFAULT '[]',
  unpresented_payments   jsonb NOT NULL DEFAULT '[]',
  adjusted_bank          numeric(19,2) NOT NULL,
  cash_book              numeric(19,2) NOT NULL,
  client_ledgers         numeric(19,2) NOT NULL,
  client_control         numeric(19,2) NOT NULL,
  overdrawn_matters      int NOT NULL DEFAULT 0,
  balanced               boolean NOT NULL,
  prepared_by            uuid NOT NULL REFERENCES users(id),
  prepared_at            timestamptz NOT NULL DEFAULT now(),
  signed_off_by          uuid REFERENCES users(id),
  signed_off_at          timestamptz,
  sign_off_note          text
);
CREATE INDEX law_reconciliations_date ON law_reconciliations (tenant_id, statement_date);

-- ---------------------------------------------------------------- integrity triggers

CREATE TRIGGER law_ledger_entries_append_only BEFORE UPDATE OR DELETE ON law_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Rule 5.3: a matter's client ledger may never go below zero, on the entry's date or any later date.
-- The matter row is locked first so concurrent payments on one matter queue behind each other.
CREATE OR REPLACE FUNCTION law_check_client_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE low_date date; low numeric; num text;
BEGIN
  IF NEW.side <> 'client' OR NEW.amount > 0 THEN RETURN NEW; END IF;
  SELECT number INTO num FROM law_matters WHERE id = NEW.matter_id FOR UPDATE;
  SELECT ds.date, (SELECT sum(amount) FROM law_ledger_entries l
                    WHERE l.matter_id = NEW.matter_id AND l.side = 'client' AND l.date <= ds.date)
    INTO low_date, low
    FROM (SELECT DISTINCT date FROM law_ledger_entries
           WHERE matter_id = NEW.matter_id AND side = 'client' AND date >= NEW.date) ds
   ORDER BY 2 ASC LIMIT 1;
  IF low < 0 THEN
    RAISE EXCEPTION 'Client ledger for matter % would be overdrawn by % on %', num, -low, low_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER law_ledger_client_not_overdrawn AFTER INSERT ON law_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION law_check_client_ledger();

-- Billed time is part of a posted fee note: once stamped it cannot be changed or removed.
CREATE OR REPLACE FUNCTION law_time_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.fee_note_id IS NOT NULL THEN
    RAISE EXCEPTION 'Time entry has been billed on a fee note and cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER law_time_entries_guard BEFORE UPDATE OR DELETE ON law_time_entries
  FOR EACH ROW EXECUTE FUNCTION law_time_entry_guard();

-- Fee notes are posted documents: only the settled amount moves, and only upwards.
CREATE OR REPLACE FUNCTION law_fee_note_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.amount_settled < OLD.amount_settled
     OR (to_jsonb(NEW) - 'amount_settled') <> (to_jsonb(OLD) - 'amount_settled') THEN
    RAISE EXCEPTION 'law_fee_notes is append-only: issue a credit note instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER law_fee_notes_guard BEFORE UPDATE OR DELETE ON law_fee_notes
  FOR EACH ROW EXECUTE FUNCTION law_fee_note_guard();

-- A saved reconciliation is a record: it can be signed off once, and nothing else changes.
CREATE OR REPLACE FUNCTION law_reconciliation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.signed_off_at IS NOT NULL OR NEW.signed_off_at IS NULL OR NEW.signed_off_by IS NULL
     OR (to_jsonb(NEW) - 'signed_off_by' - 'signed_off_at' - 'sign_off_note')
        <> (to_jsonb(OLD) - 'signed_off_by' - 'signed_off_at' - 'sign_off_note') THEN
    RAISE EXCEPTION 'A reconciliation can only be signed off, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER law_reconciliations_guard BEFORE UPDATE OR DELETE ON law_reconciliations
  FOR EACH ROW EXECUTE FUNCTION law_reconciliation_guard();

-- ---------------------------------------------------------------- row-level security

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'law_clients','law_fee_earners','law_matters','law_fee_notes','law_time_entries',
    'law_ledger_entries','law_reconciliations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO softilo_app', t);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON law_ledger_entries FROM softilo_app;
REVOKE DELETE ON law_fee_notes, law_reconciliations FROM softilo_app;
