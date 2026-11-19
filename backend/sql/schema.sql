CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  email           TEXT,
  email_verified_at TIMESTAMPTZ,
  phone           TEXT UNIQUE,
  full_name       TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('loan_officer','supervisor','finance','management','director','ceo')),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id         SERIAL PRIMARY KEY,
  full_name  TEXT NOT NULL,
  officer_id INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loans (
  id            SERIAL PRIMARY KEY,
  loan_number   TEXT UNIQUE NOT NULL,
  client_id     INT NOT NULL REFERENCES clients(id),
  officer_id    INT REFERENCES users(id),
  product       TEXT NOT NULL CHECK (product IN ('Emergency','Group','Business Emergency')),
  stage         TEXT NOT NULL CHECK (stage IN ('assessment','verification','approval','disbursement','repayment')),
  status        TEXT NOT NULL CHECK (status IN ('in_progress','active','closed')),
  balance       NUMERIC(14,2) NOT NULL DEFAULT 0,
  next_due_date DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  username TEXT NOT NULL,
  action   TEXT NOT NULL,
  record   TEXT NOT NULL DEFAULT '',
  detail   TEXT NOT NULL DEFAULT ''
);

CREATE OR REPLACE FUNCTION audit_log_readonly() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is read only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();

CREATE TABLE IF NOT EXISTS loan_groups (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  location         TEXT NOT NULL,
  centre           TEXT NOT NULL,
  zone             TEXT NOT NULL,
  members_expected INT NOT NULL CHECK (members_expected > 0),
  meeting_day      TEXT NOT NULL,
  notes            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect','registration')),
  officer_id       INT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE loan_groups DROP CONSTRAINT IF EXISTS loan_groups_status_check;
ALTER TABLE loan_groups ADD CONSTRAINT loan_groups_status_check
  CHECK (status IN ('prospect','registration','assessment','closed'));

CREATE TABLE IF NOT EXISTS members (
  id          SERIAL PRIMARY KEY,
  group_id    INT NOT NULL REFERENCES loan_groups(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  national_id TEXT NOT NULL,
  phone       TEXT NOT NULL,
  business    TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('Leader','Secretary','Treasurer','Member')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS members_one_office_role
  ON members (group_id, role) WHERE role IN ('Leader','Secretary','Treasurer');

ALTER TABLE loan_groups DROP CONSTRAINT IF EXISTS loan_groups_status_check;
ALTER TABLE loan_groups ADD CONSTRAINT loan_groups_status_check
  CHECK (status IN ('prospect','registration','assessment','closed'));

CREATE TABLE IF NOT EXISTS members (
  id          SERIAL PRIMARY KEY,
  group_id    INT NOT NULL REFERENCES loan_groups(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  national_id TEXT NOT NULL,
  phone       TEXT NOT NULL,
  business    TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('Leader','Secretary','Treasurer','Member')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS members_one_office_role
  ON members (group_id, role) WHERE role IN ('Leader','Secretary','Treasurer');

ALTER TABLE clients ADD COLUMN IF NOT EXISTS national_id        TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone              TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS business_type      TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS business_location  TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source             TEXT CHECK (source IN ('self','staff','officer'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS introduced_by      TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS introduced_at      TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS application_status TEXT CHECK (application_status IN ('draft','submitted'));

CREATE UNIQUE INDEX IF NOT EXISTS clients_national_id_uq ON clients (national_id) WHERE national_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_phone_uq ON clients (phone) WHERE phone IS NOT NULL;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS national_id        TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone              TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS business_type      TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS business_location  TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source             TEXT CHECK (source IN ('self','staff','officer'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS introduced_by      TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS introduced_at      TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS application_status TEXT CHECK (application_status IN ('draft','submitted'));

CREATE UNIQUE INDEX IF NOT EXISTS clients_national_id_uq ON clients (national_id) WHERE national_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_phone_uq ON clients (phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS assessments (
  id                   SERIAL PRIMARY KEY,
  subject_type         TEXT NOT NULL CHECK (subject_type IN ('client','group')),
  subject_id           INT  NOT NULL,
  officer_id           INT  NOT NULL REFERENCES users(id),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  character_rating     TEXT CHECK (character_rating IN ('strong','average','weak')),
  character_note       TEXT NOT NULL DEFAULT '',
  attitude_rating      TEXT CHECK (attitude_rating IN ('strong','average','weak')),
  attitude_note        TEXT NOT NULL DEFAULT '',
  cohesion_rating      TEXT CHECK (cohesion_rating IN ('strong','average','weak')),
  cohesion_note        TEXT NOT NULL DEFAULT '',
  monthly_sales        BIGINT CHECK (monthly_sales >= 0),
  working_capital      BIGINT CHECK (working_capital >= 0),
  monthly_cash_flow    BIGINT CHECK (monthly_cash_flow >= 0),
  existing_obligations BIGINT CHECK (existing_obligations >= 0),
  repayment_capacity   BIGINT,
  recommended_amount   BIGINT,
  premises_visited     BOOLEAN NOT NULL DEFAULT FALSE,
  premises_ownership   TEXT CHECK (premises_ownership IN ('owned','rented','other')),
  premises_notes       TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at         TIMESTAMPTZ,
  UNIQUE (subject_type, subject_id)
);

-- roles:start
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('loan_officer','supervisor','committee','finance','management','director','ceo','admin','customer'));
-- roles:end

-- messages:start
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_change_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_zone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique_idx ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id           SERIAL PRIMARY KEY,
  sender_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient_id, sent_at DESC);
-- messages:end

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id SERIAL PRIMARY KEY,
  requested_username TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ,
  handled_by TEXT
);
CREATE INDEX IF NOT EXISTS password_reset_requests_pending_idx
  ON password_reset_requests (created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS email_challenges (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'password_reset')),
  code_hash TEXT NOT NULL,
  registration_payload JSONB,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email, purpose)
);
CREATE INDEX IF NOT EXISTS email_challenges_expiry_idx ON email_challenges (expires_at);

CREATE TABLE IF NOT EXISTS supervisor_zones (
  zone TEXT PRIMARY KEY,
  supervisor_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customer_requests (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK (request_type IN ('loan','group_registration','assessment','member_performance')),
  summary TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','visited','approved','rejected','completed')),
  zone TEXT,
  assigned_supervisor_id INT REFERENCES users(id) ON DELETE SET NULL,
  assigned_officer_id INT REFERENCES users(id) ON DELETE SET NULL,
  visit_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS assigned_supervisor_id INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS assigned_officer_id INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS visit_notes TEXT;
CREATE INDEX IF NOT EXISTS customer_requests_customer_idx ON customer_requests (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_requests_assigned_idx ON customer_requests (assigned_supervisor_id, assigned_officer_id, created_at DESC);

-- Loan servicing base fields and ledger. Snippe-specific intent tables and provider safeguards live in payments-hardening.sql.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('loan_officer','supervisor','committee','finance','management','director','ceo','admin','customer'));

ALTER TABLE clients ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS business_type TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS business_location TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS clients_user_id_unique ON clients(user_id) WHERE user_id IS NOT NULL;

ALTER TABLE loans ADD COLUMN IF NOT EXISTS principal_amount NUMERIC(14,2);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS savings_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS savings_rate NUMERIC(6,5) NOT NULL DEFAULT 0.05;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS processing_fee_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS processing_fee_rate NUMERIC(6,5) NOT NULL DEFAULT 0.10;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS interest_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS weekly_interest_rate NUMERIC(6,5) NOT NULL DEFAULT 0.0475;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS installment_count INT NOT NULL DEFAULT 25;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS weekly_installment_amount NUMERIC(14,2);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS final_installment_amount NUMERIC(14,2);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS first_due_date DATE;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS amount_due NUMERIC(14,2);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS repayment_performance NUMERIC(5,2);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS arrears NUMERIC(14,2);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS transfer_reference TEXT;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS disbursed_amount NUMERIC(14,2);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS disbursed_at TIMESTAMPTZ;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS loan_decision_records (
  id BIGSERIAL PRIMARY KEY, loan_id INT NOT NULL REFERENCES loans(id), reviewer_id INT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','returned')),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 10 AND 1000), decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signer_id INT REFERENCES users(id), signed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS loan_decision_records_loan_decided_idx ON loan_decision_records(loan_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS loan_payments (
  id BIGSERIAL PRIMARY KEY, loan_id INT NOT NULL REFERENCES loans(id), amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reference TEXT NOT NULL DEFAULT '', received_by INT REFERENCES users(id), received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_payments_loan_received_idx ON loan_payments(loan_id, received_at DESC);
