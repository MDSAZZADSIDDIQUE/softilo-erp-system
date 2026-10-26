-- Softilo Pharma & Medical edition: batch control under Good Distribution Practice.
-- Runs after the core migrations. Rules enforced here, not only in the app:
--   * every table has row-level security keyed on app.tenant_id
--   * batch movements and status events are append-only
--   * a batch's quantity on hand is maintained from its movements and can never go negative
--   * a batch's status only changes through a recorded event; release, rejection, recall and
--     re-quarantine need a named Responsible Person
--   * stock can only be dispatched from a released batch that is in date on the dispatch date
--   * batch number, expiry and product of a batch can never be edited

-- ---------------------------------------------------------------- master data

CREATE TABLE pharma_products (
  product_id      uuid PRIMARY KEY REFERENCES products(id),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  kind            text NOT NULL CHECK (kind IN ('medicine','device')),
  legal_category  text CHECK (legal_category IN ('POM','P','GSL')),
  cd_schedule     int CHECK (cd_schedule BETWEEN 1 AND 5),
  storage         text NOT NULL DEFAULT 'ambient' CHECK (storage IN ('ambient','cold_chain','frozen')),
  batch_tracked   boolean NOT NULL DEFAULT true,
  licence_number  text,                       -- PL / MA number for medicines
  device_mark     text CHECK (device_mark IN ('UKCA','CE','CE_UKNI')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'device' OR legal_category IS NOT NULL),
  CHECK (kind = 'medicine' OR (legal_category IS NULL AND cd_schedule IS NULL))
);

CREATE TABLE pharma_responsible_persons (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  appointed_on date NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE pharma_customer_profiles (
  contact_id          uuid PRIMARY KEY REFERENCES contacts(id),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  min_shelf_life_days int NOT NULL DEFAULT 0 CHECK (min_shelf_life_days BETWEEN 0 AND 1095)
);

CREATE TABLE pharma_customer_licences (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  contact_id          uuid NOT NULL REFERENCES contacts(id),
  type                text NOT NULL CHECK (type IN ('wda_h','gphc_pharmacy','gmc_practitioner','dispensing_doctor','nhs_trust','home_office_cd')),
  number              text NOT NULL,
  valid_from          date,
  expires_on          date,
  verified_on         date,
  verified_by         uuid REFERENCES users(id),
  verification_source text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, contact_id, type, number),
  CHECK (expires_on IS NULL OR valid_from IS NULL OR expires_on >= valid_from)
);
CREATE INDEX pharma_customer_licences_contact ON pharma_customer_licences (tenant_id, contact_id);

-- ---------------------------------------------------------------- batches

-- One row per batch received on one goods-receipt line. The same manufacturer batch number
-- received twice gives two rows, each with its own quarantine and release.
CREATE TABLE pharma_batches (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  product_id       uuid NOT NULL REFERENCES products(id),
  warehouse_id     uuid NOT NULL REFERENCES warehouses(id),
  batch_number     text NOT NULL CHECK (length(trim(batch_number)) > 0),
  expiry           date NOT NULL,
  manufactured_on  date,
  supplier_id      uuid NOT NULL REFERENCES contacts(id),
  receipt_id       uuid NOT NULL REFERENCES goods_receipts(id),
  receipt_line_id  uuid NOT NULL REFERENCES goods_receipt_lines(id),
  received_on      date NOT NULL,
  received_qty     numeric(18,4) NOT NULL CHECK (received_qty > 0),
  on_hand          numeric(18,4) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  status           text NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine','released','rejected','recalled')),
  status_event_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (manufactured_on IS NULL OR manufactured_on <= expiry)
);
CREATE INDEX pharma_batches_product ON pharma_batches (tenant_id, product_id, warehouse_id, expiry);
CREATE INDEX pharma_batches_number ON pharma_batches (tenant_id, product_id, batch_number);

CREATE TABLE pharma_batch_movements (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  batch_id    uuid NOT NULL REFERENCES pharma_batches(id),
  date        date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('receipt','dispatch','return','adjustment')),
  quantity    numeric(18,4) NOT NULL CHECK (quantity <> 0),
  source_type text NOT NULL,
  source_id   uuid,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('receipt','return')) = (quantity > 0) OR kind = 'adjustment')
);
CREATE INDEX pharma_batch_movements_batch ON pharma_batch_movements (tenant_id, batch_id);
CREATE INDEX pharma_batch_movements_source ON pharma_batch_movements (tenant_id, source_type, source_id);

CREATE TABLE pharma_batch_events (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  batch_id    uuid NOT NULL REFERENCES pharma_batches(id),
  action      text NOT NULL CHECK (action IN ('receive','release','reject','quarantine','recall')),
  from_status text,
  to_status   text NOT NULL,
  reason      text,
  reference   text,                         -- e.g. MHRA drug alert or recall number
  decided_by  uuid NOT NULL REFERENCES users(id),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (action = 'receive' OR from_status IS NOT NULL)
);
CREATE INDEX pharma_batch_events_batch ON pharma_batch_events (tenant_id, batch_id, decided_at);

ALTER TABLE pharma_batches ADD CONSTRAINT pharma_batches_status_event
  FOREIGN KEY (status_event_id) REFERENCES pharma_batch_events(id) DEFERRABLE INITIALLY DEFERRED;

-- A supply to a customer: the core sales invoice plus the licence evidence relied on.
CREATE TABLE pharma_dispatches (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  invoice_id   uuid NOT NULL REFERENCES sales_invoices(id),
  customer_id  uuid NOT NULL REFERENCES contacts(id),
  date         date NOT NULL,
  licences     jsonb NOT NULL DEFAULT '[]',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_id)
);

-- ---------------------------------------------------------------- integrity triggers

-- Movements keep on_hand current, and dispatches only come from released, in-date batches.
CREATE OR REPLACE FUNCTION pharma_apply_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record;
BEGIN
  SELECT status, expiry INTO b FROM pharma_batches WHERE id = NEW.batch_id FOR UPDATE;
  IF NEW.kind = 'dispatch' THEN
    IF b.status <> 'released' THEN
      RAISE EXCEPTION 'Batch is % and cannot be dispatched', b.status USING ERRCODE = 'check_violation';
    END IF;
    IF b.expiry < NEW.date THEN
      RAISE EXCEPTION 'Batch expired on % and cannot be dispatched', b.expiry USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE pharma_batches SET on_hand = on_hand + NEW.quantity WHERE id = NEW.batch_id;
  RETURN NEW;
END $$;
CREATE TRIGGER pharma_batch_movement_apply AFTER INSERT ON pharma_batch_movements
  FOR EACH ROW EXECUTE FUNCTION pharma_apply_movement();

-- Quality decisions need an active Responsible Person, and must start from the batch's current status.
CREATE OR REPLACE FUNCTION pharma_apply_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status text;
BEGIN
  IF NEW.action <> 'receive' THEN
    IF NOT EXISTS (SELECT 1 FROM pharma_responsible_persons WHERE user_id = NEW.decided_by AND active) THEN
      RAISE EXCEPTION 'Only a Responsible Person can % a batch', NEW.action USING ERRCODE = 'check_violation';
    END IF;
    SELECT status INTO current_status FROM pharma_batches WHERE id = NEW.batch_id FOR UPDATE;
    IF current_status IS DISTINCT FROM NEW.from_status THEN
      RAISE EXCEPTION 'Batch status changed to % before this decision was recorded', current_status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE pharma_batches SET status = NEW.to_status, status_event_id = NEW.id WHERE id = NEW.batch_id;
  RETURN NEW;
END $$;
CREATE TRIGGER pharma_batch_event_apply AFTER INSERT ON pharma_batch_events
  FOR EACH ROW EXECUTE FUNCTION pharma_apply_event();

-- Identity of a batch is fixed; status only moves with a matching event.
CREATE OR REPLACE FUNCTION pharma_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharma_batches rows cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.product_id <> OLD.product_id OR NEW.warehouse_id <> OLD.warehouse_id OR NEW.batch_number <> OLD.batch_number
     OR NEW.expiry <> OLD.expiry OR NEW.received_qty <> OLD.received_qty OR NEW.receipt_line_id <> OLD.receipt_line_id THEN
    RAISE EXCEPTION 'Batch details are fixed once received' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT EXISTS (
    SELECT 1 FROM pharma_batch_events e
     WHERE e.id = NEW.status_event_id AND e.batch_id = NEW.id AND e.to_status = NEW.status
       AND NEW.status_event_id IS DISTINCT FROM OLD.status_event_id) THEN
    RAISE EXCEPTION 'Batch status can only change through a recorded decision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharma_batches_guard BEFORE UPDATE OR DELETE ON pharma_batches
  FOR EACH ROW EXECUTE FUNCTION pharma_batch_guard();

CREATE TRIGGER pharma_batch_movements_append_only BEFORE UPDATE OR DELETE ON pharma_batch_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER pharma_batch_events_append_only BEFORE UPDATE OR DELETE ON pharma_batch_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER pharma_dispatches_append_only BEFORE UPDATE OR DELETE ON pharma_dispatches
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- row-level security

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pharma_products','pharma_responsible_persons','pharma_customer_profiles','pharma_customer_licences',
    'pharma_batches','pharma_batch_movements','pharma_batch_events','pharma_dispatches'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO softilo_app', t);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON pharma_batch_movements, pharma_batch_events, pharma_dispatches FROM softilo_app;
REVOKE DELETE ON pharma_batches FROM softilo_app;
