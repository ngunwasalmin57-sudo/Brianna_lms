-- Snippe-specific columns, constraints, indexes, and webhook inbox.
-- Run after schema.sql; safe to apply repeatedly.

CREATE TABLE IF NOT EXISTS loan_payment_intents (
  id BIGSERIAL PRIMARY KEY,
  loan_id INT NOT NULL REFERENCES loans(id),
  customer_id INT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('snippe','azampay')),
  provider_order_id TEXT NOT NULL UNIQUE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'push',
  qr_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  checkout_url TEXT,
  gateway_reference TEXT,
  provider_transaction_id TEXT,
  channel TEXT,
  customer_reference TEXT,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS loan_payment_intents_customer_created_idx ON loan_payment_intents(customer_id,created_at DESC);

CREATE TABLE IF NOT EXISTS loan_payout_intents (
  id BIGSERIAL PRIMARY KEY,
  loan_id INT NOT NULL REFERENCES loans(id),
  initiated_by INT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('snippe_mobile','snippe_bank','azampay_mobile','azampay_bank')),
  transaction_id TEXT NOT NULL UNIQUE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  principal_amount NUMERIC(14,2),
  destination TEXT NOT NULL,
  destination_name TEXT NOT NULL,
  destination_bank_code TEXT,
  next_due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','ambiguous','reversed')),
  provider_reference TEXT,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS loan_payout_intents_loan_created_idx ON loan_payout_intents(loan_id,created_at DESC);

ALTER TABLE loan_payment_intents DROP CONSTRAINT IF EXISTS loan_payment_intents_status_check;
ALTER TABLE loan_payment_intents DROP CONSTRAINT IF EXISTS loan_payment_intents_provider_check;
ALTER TABLE loan_payment_intents ADD CONSTRAINT loan_payment_intents_provider_check CHECK (provider IN ('snippe','azampay'));
ALTER TABLE loan_payment_intents ADD CONSTRAINT loan_payment_intents_status_check
  CHECK (status IN ('pending','paid','failed','cancelled','ambiguous','needs_review'));
ALTER TABLE loan_payment_intents ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'push';
ALTER TABLE loan_payment_intents ADD COLUMN IF NOT EXISTS qr_code TEXT;
ALTER TABLE loan_payment_intents DROP CONSTRAINT IF EXISTS loan_payment_intents_payment_method_check;
ALTER TABLE loan_payment_intents ADD CONSTRAINT loan_payment_intents_payment_method_check
  CHECK (payment_method IN ('push','card','qr'));

DROP INDEX IF EXISTS one_open_intent_per_loan;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_intent_per_loan
  ON loan_payment_intents (loan_id) WHERE status IN ('pending','ambiguous','needs_review');

CREATE INDEX IF NOT EXISTS loan_payment_intents_gateway_reference_idx
  ON loan_payment_intents (gateway_reference) WHERE gateway_reference IS NOT NULL;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS bank_code TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS bank_account_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS bank_details_submitted_by INT REFERENCES users(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS bank_details_verified_by INT REFERENCES users(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS bank_details_verified_at TIMESTAMPTZ;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_verified_bank_details_check;
ALTER TABLE clients ADD CONSTRAINT clients_verified_bank_details_check CHECK (
  bank_details_verified_at IS NULL OR (bank_code IS NOT NULL AND bank_account_number IS NOT NULL AND bank_account_name IS NOT NULL AND bank_details_submitted_by IS NOT NULL AND bank_details_verified_by IS NOT NULL AND bank_details_verified_by <> bank_details_submitted_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS clients_id_user_id_unique ON clients(id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS loans_id_client_id_unique ON loans(id,client_id);

ALTER TABLE loan_payment_intents ADD COLUMN IF NOT EXISTS client_id INT;
UPDATE loan_payment_intents i SET client_id=l.client_id FROM loans l WHERE i.loan_id=l.id AND i.client_id IS NULL;
ALTER TABLE loan_payment_intents DROP CONSTRAINT IF EXISTS loan_payment_intents_client_id_required;
ALTER TABLE loan_payment_intents DROP CONSTRAINT IF EXISTS loan_payment_intents_loan_client_fk;
ALTER TABLE loan_payment_intents DROP CONSTRAINT IF EXISTS loan_payment_intents_client_owner_fk;
ALTER TABLE loan_payment_intents ADD CONSTRAINT loan_payment_intents_client_id_required CHECK (client_id IS NOT NULL) NOT VALID;
ALTER TABLE loan_payment_intents ADD CONSTRAINT loan_payment_intents_loan_client_fk FOREIGN KEY (loan_id,client_id) REFERENCES loans(id,client_id) NOT VALID;
ALTER TABLE loan_payment_intents ADD CONSTRAINT loan_payment_intents_client_owner_fk FOREIGN KEY (client_id,customer_id) REFERENCES clients(id,user_id) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS loan_payment_intents_provider_transaction_unique ON loan_payment_intents(provider,provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS payment_intent_id BIGINT REFERENCES loan_payment_intents(id);
ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS loan_payments_provider_transaction_unique
  ON loan_payments(provider,provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS loan_payments_payment_intent_unique ON loan_payments(payment_intent_id) WHERE payment_intent_id IS NOT NULL;

ALTER TABLE loans ADD COLUMN IF NOT EXISTS payout_reversal_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS payout_reversal_at TIMESTAMPTZ;
ALTER TABLE loan_payout_intents ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'TZS';
ALTER TABLE loan_payout_intents ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(14,2);
ALTER TABLE loan_payout_intents ADD COLUMN IF NOT EXISTS total_debit NUMERIC(14,2);
ALTER TABLE loan_payout_intents ADD COLUMN IF NOT EXISTS reversal_reviewed_by INT REFERENCES users(id);
ALTER TABLE loan_payout_intents ADD COLUMN IF NOT EXISTS reversal_reviewed_at TIMESTAMPTZ;
ALTER TABLE loan_payout_intents ADD COLUMN IF NOT EXISTS reversal_review_note TEXT;
ALTER TABLE loan_payout_intents DROP CONSTRAINT IF EXISTS loan_payout_intents_provider_check;
ALTER TABLE loan_payout_intents ADD CONSTRAINT loan_payout_intents_provider_check CHECK (provider IN ('snippe_mobile','snippe_bank','azampay_mobile','azampay_bank'));
ALTER TABLE loan_payout_intents DROP CONSTRAINT IF EXISTS loan_payout_intents_currency_check;
ALTER TABLE loan_payout_intents DROP CONSTRAINT IF EXISTS loan_payout_intents_fee_check;
ALTER TABLE loan_payout_intents DROP CONSTRAINT IF EXISTS loan_payout_intents_total_check;
ALTER TABLE loan_payout_intents ADD CONSTRAINT loan_payout_intents_currency_check CHECK (currency = 'TZS');
ALTER TABLE loan_payout_intents ADD CONSTRAINT loan_payout_intents_fee_check CHECK (fee_amount IS NULL OR fee_amount >= 0);
ALTER TABLE loan_payout_intents ADD CONSTRAINT loan_payout_intents_total_check CHECK (
  (fee_amount IS NULL AND total_debit IS NULL) OR (fee_amount IS NOT NULL AND total_debit = amount + fee_amount)
);
CREATE UNIQUE INDEX IF NOT EXISTS loan_payout_intents_provider_reference_unique ON loan_payout_intents(provider_reference) WHERE provider_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_payout_per_loan ON loan_payout_intents(loan_id) WHERE status IN ('pending','ambiguous');

CREATE TABLE IF NOT EXISTS snippe_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  deduplication_key TEXT,
  event_id TEXT,
  event_type TEXT,
  provider_reference TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_valid BOOLEAN NOT NULL,
  processing_status TEXT NOT NULL CHECK (processing_status IN ('invalid','received','processing','processed','ignored','needs_review','failed')),
  payload_sha256 TEXT NOT NULL,
  failure_message TEXT,
  UNIQUE (event_id)
);
ALTER TABLE snippe_webhook_events ADD COLUMN IF NOT EXISTS deduplication_key TEXT;
UPDATE snippe_webhook_events
   SET deduplication_key='event:' || event_id
 WHERE deduplication_key IS NULL AND event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS snippe_webhook_events_deduplication_key_unique
  ON snippe_webhook_events(deduplication_key) WHERE deduplication_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS snippe_webhook_events_received_idx ON snippe_webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS snippe_webhook_events_reference_idx ON snippe_webhook_events(provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS azampay_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  deduplication_key TEXT,
  event_id TEXT UNIQUE,
  event_type TEXT,
  provider_reference TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_valid BOOLEAN NOT NULL,
  processing_status TEXT NOT NULL CHECK (processing_status IN ('invalid','received','processing','processed','ignored','needs_review','failed')),
  payload_sha256 TEXT NOT NULL,
  failure_message TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS azampay_webhook_events_deduplication_key_unique ON azampay_webhook_events(deduplication_key) WHERE deduplication_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS azampay_webhook_events_received_idx ON azampay_webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS azampay_webhook_events_reference_idx ON azampay_webhook_events(provider_reference) WHERE provider_reference IS NOT NULL;
