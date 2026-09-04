-- PG Ledger schema. Money is stored as whole rupees (integer).
-- "Delete" on anything financial is modeled as a status change, never a row removal —
-- see rent_charges.status ('waived') and payments.status ('voided').

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS floors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  room_no TEXT NOT NULL,
  sharing_type INTEGER NOT NULL,
  default_rent INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(floor_id, room_no)
);

CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  bed_no INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  alt_phone TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  emergency_relation TEXT,
  occupation TEXT,
  id_proof_type TEXT,
  id_proof_number TEXT,
  joining_date DATE NOT NULL,
  rent_due_day INTEGER NOT NULL DEFAULT 5,
  monthly_rent INTEGER NOT NULL,
  deposit_amount INTEGER NOT NULL DEFAULT 0,
  deposit_paid_date DATE,
  deposit_refund_amount INTEGER,
  deposit_refund_date DATE,
  status TEXT NOT NULL DEFAULT 'active',
  vacate_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'bank',
  opening_balance INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS account_transactions (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  txn_date DATE NOT NULL DEFAULT CURRENT_DATE,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_id INTEGER,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rent_charges (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  expected_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  waived_reason TEXT,
  waived_at TIMESTAMPTZ,
  original_amount INTEGER,
  adjusted_reason TEXT,
  adjusted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, period_year, period_month)
);

-- Patches an already-created table (this file uses CREATE TABLE IF NOT EXISTS,
-- which won't add columns to a table that already exists) — safe to re-run.
ALTER TABLE rent_charges ADD COLUMN IF NOT EXISTS original_amount INTEGER;
ALTER TABLE rent_charges ADD COLUMN IF NOT EXISTS adjusted_reason TEXT;
ALTER TABLE rent_charges ADD COLUMN IF NOT EXISTS adjusted_at TIMESTAMPTZ;

-- "Give notice" doesn't change tenants.status — a tenant on notice is still
-- 'active' (still occupying their bed, still billed rent) right up until the
-- day they actually vacate. These two columns are the only record of notice
-- having been given; the app shows a "Notice" pill instead of "Active"
-- whenever notice_date is set on an otherwise-active tenant.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notice_date DATE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS expected_vacate_date DATE;

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  rent_charge_id INTEGER REFERENCES rent_charges(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL,
  pay_date DATE NOT NULL DEFAULT CURRENT_DATE,
  mode TEXT NOT NULL DEFAULT 'cash',
  status TEXT NOT NULL DEFAULT 'active',
  voided_reason TEXT,
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  floor_id INTEGER REFERENCES floors(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenants_room ON tenants(room_id);
CREATE INDEX IF NOT EXISTS idx_rent_charges_period ON rent_charges(period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_txn_account ON account_transactions(account_id);
