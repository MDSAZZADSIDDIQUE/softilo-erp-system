-- Platform services: external connections (HMRC, bank feeds, Companies House, email, FX, AI),
-- automations, the document inbox, AI interaction log, team management and MFA.
--
-- Every external service sits behind a provider interface in apps/api/src/integrations. Demo providers
-- and live providers write the same rows, so switching a tenant from demo to live data changes nothing here.

-- ---------------------------------------------------------------- platform tables (no tenant RLS)

-- Daily reference rates, GBP per one unit of the currency. Shared by all tenants.
CREATE TABLE fx_rates (
  currency   char(3) NOT NULL,
  date       date NOT NULL,
  rate       numeric(18,8) NOT NULL CHECK (rate > 0),
  source     text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (currency, date)
);
GRANT SELECT, INSERT, UPDATE ON fx_rates TO softilo_app;

-- Time-based one-time passwords (RFC 6238). The secret is only readable by the platform connection.
CREATE TABLE user_mfa (
  user_id        uuid PRIMARY KEY REFERENCES users(id),
  secret         text NOT NULL,
  enabled_at     timestamptz,
  last_step      bigint,                     -- last accepted time step, so a code cannot be replayed
  recovery_codes text[] NOT NULL DEFAULT '{}', -- sha256 of each unused recovery code
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sessions ADD COLUMN mfa_pending boolean NOT NULL DEFAULT false;
-- The app may see whether a colleague has MFA turned on (for HMRC fraud headers and the team page), never the secret.
GRANT SELECT (user_id, enabled_at) ON user_mfa TO softilo_app;
ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_colleagues ON user_mfa USING (user_id IN (SELECT user_id FROM memberships WHERE tenant_id = current_tenant()));

-- ---------------------------------------------------------------- tenant tables

-- One row per connected external service (HMRC MTD, bank feed). Tokens are kept here encrypted by the app
-- (see lib/crypto.ts) and never returned by the API.
CREATE TABLE integration_connections (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  provider      text NOT NULL,              -- hmrc_vat | bank_feed
  mode          text NOT NULL CHECK (mode IN ('demo','live')),
  status        text NOT NULL CHECK (status IN ('pending','connected','expired','revoked','error')),
  label         text,
  external_ref  text,                       -- VRN, bank account id from the provider
  account_code  text,                       -- bank feeds: the ledger bank account the feed fills
  secrets       text,                       -- encrypted JSON (access/refresh tokens)
  state         text,                       -- OAuth state while pending
  expires_at    timestamptz,
  last_synced_at timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_ref)
);

ALTER TABLE bank_transactions ADD COLUMN source text NOT NULL DEFAULT 'csv' CHECK (source IN ('csv','feed'));
ALTER TABLE bank_transactions ADD COLUMN external_id text;
ALTER TABLE bank_transactions ADD COLUMN matched_by text;  -- user | rule | automation
CREATE UNIQUE INDEX bank_transactions_external ON bank_transactions (tenant_id, bank_account_code, external_id) WHERE external_id IS NOT NULL;

-- Rules that code recurring bank lines (fees, rent, utilities) without anyone touching them.
CREATE TABLE bank_rules (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  match_text   text NOT NULL,               -- case-insensitive substring of description or reference
  direction    text NOT NULL CHECK (direction IN ('in','out','any')),
  account_code text NOT NULL,
  vat_code     text NOT NULL DEFAULT 'OS',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, account_code) REFERENCES accounts(tenant_id, code)
);

ALTER TABLE contacts ADD COLUMN credit_limit numeric(19,2);
ALTER TABLE contacts ADD COLUMN reminders boolean NOT NULL DEFAULT true;
ALTER TABLE vat_returns ADD COLUMN submission_mode text CHECK (submission_mode IN ('demo','live'));
ALTER TABLE vat_returns DROP CONSTRAINT vat_returns_status_check;
ALTER TABLE vat_returns ADD CONSTRAINT vat_returns_status_check CHECK (status IN ('finalised','submitted'));

-- Messages sent to people outside the company (invoices, statements, payment reminders).
CREATE TABLE outbox_messages (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  channel      text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  template     text NOT NULL,              -- invoice | reminder_1 | reminder_2 | reminder_3 | statement | invitation
  to_address   text NOT NULL,
  to_name      text,
  subject      text NOT NULL,
  body         text NOT NULL,
  related_type text,
  related_id   uuid,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  mode         text NOT NULL CHECK (mode IN ('demo','live')),
  provider_ref text,
  error        text,
  created_by   text NOT NULL DEFAULT 'user', -- user | automation
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX outbox_related ON outbox_messages (tenant_id, related_type, related_id);

-- Automations: each kind is configured once per tenant and every run is logged.
CREATE TABLE automation_rules (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  kind        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  settings    jsonb NOT NULL DEFAULT '{}',
  last_run_at timestamptz,
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE automation_runs (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  kind        text NOT NULL,
  trigger     text NOT NULL CHECK (trigger IN ('schedule','manual','event')),
  status      text NOT NULL CHECK (status IN ('ok','partial','failed','skipped')),
  summary     text NOT NULL,
  actions     jsonb NOT NULL DEFAULT '[]',  -- what it did: [{type, entity, id, label}]
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automation_runs_tenant ON automation_runs (tenant_id, started_at DESC);
CREATE TRIGGER automation_runs_append_only BEFORE UPDATE OR DELETE ON automation_runs FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Document inbox: supplier invoices, freight and customs paperwork waiting to be read and turned into drafts.
CREATE TABLE documents (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  filename      text NOT NULL,
  media_type    text NOT NULL,
  content       text NOT NULL,             -- base64 for binary files, plain text otherwise
  size_bytes    int NOT NULL,
  sha256        text NOT NULL,
  source        text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','email','demo')),
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received','extracted','needs_review','converted','rejected','failed')),
  doc_type      text,                      -- supplier_invoice | freight_invoice | customs_entry | credit_note | other
  extraction    jsonb,
  extractor     text,                      -- demo-rules | claude model id
  confidence    numeric(4,3),
  warnings      jsonb NOT NULL DEFAULT '[]',
  linked_type   text,
  linked_id     uuid,
  error         text,
  uploaded_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  extracted_at  timestamptz,
  UNIQUE (tenant_id, sha256)
);

-- Every AI suggestion is kept: what was asked, what came back, which model, who acted on it.
CREATE TABLE ai_interactions (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid REFERENCES users(id),
  kind       text NOT NULL,                -- extraction | assistant
  provider   text NOT NULL,                -- demo | claude
  model      text,
  input      jsonb NOT NULL,
  output     jsonb NOT NULL,
  tools_used jsonb NOT NULL DEFAULT '[]',
  input_tokens  int,
  output_tokens int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_interactions_tenant ON ai_interactions (tenant_id, created_at DESC);
CREATE TRIGGER ai_interactions_append_only BEFORE UPDATE OR DELETE ON ai_interactions FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'integration_connections','bank_rules','outbox_messages','automation_rules','automation_runs','documents','ai_interactions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO softilo_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON automation_runs, ai_interactions FROM softilo_app;

-- Team management: owners and admins add colleagues and change roles from inside the tenant.
GRANT INSERT, UPDATE, DELETE ON memberships TO softilo_app;
DROP POLICY tenant_members ON memberships;
CREATE POLICY tenant_members ON memberships USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
