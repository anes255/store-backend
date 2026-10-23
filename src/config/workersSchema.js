// Workers & payroll schema. Created on boot (initDb) and lazily before the
// first workers request, so a fresh database works either way. Every
// statement is idempotent.
//
// Workers are the existing store_staff rows (one row per worker per store, so
// a worker can have a different job/role in each store); this adds:
//   worker_job_types            job titles per store (Order Confirmer, …)
//   worker_compensation_rules   how a worker is paid in a store
//   worker_order_actions        who did what to which order (commission source)
//   worker_login_history        successful / failed logins
//   worker_tokens               invitation + password-reset tokens (hashed)
//   payroll_periods / payroll_items / payroll_adjustments / payroll_payments
const pool = require('./db');

const STATEMENTS = [
  // worker fields on store_staff
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS username VARCHAR(80)",
  // store roles have text ids ("st_…"); older databases created this as UUID
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS role_template_id TEXT",
  "ALTER TABLE store_staff ALTER COLUMN role_template_id TYPE TEXT USING role_template_id::text",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT '[]'",
  "ALTER TABLE store_staff ALTER COLUMN role TYPE VARCHAR(200)",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS first_name VARCHAR(80)",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS last_name VARCHAR(80)",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS date_of_birth DATE",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS address TEXT",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS notes TEXT",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS avatar TEXT",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS job_type VARCHAR(120)",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS session_version INTEGER DEFAULT 0",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS failed_logins INTEGER DEFAULT 0",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS language VARCHAR(5)",
  "ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
  "CREATE INDEX IF NOT EXISTS idx_staff_store ON store_staff(store_id)",
  "CREATE INDEX IF NOT EXISTS idx_staff_username ON store_staff(LOWER(username))",
  "CREATE INDEX IF NOT EXISTS idx_staff_email ON store_staff(LOWER(email))",

  // order assignment
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_staff_id UUID",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ",
  "CREATE INDEX IF NOT EXISTS idx_orders_assigned ON orders(store_id, assigned_staff_id)",

  `CREATE TABLE IF NOT EXISTS worker_job_types(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    name VARCHAR(120) NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, name))`,

  `CREATE TABLE IF NOT EXISTS worker_compensation_rules(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    staff_id UUID NOT NULL,
    rule_type VARCHAR(30) NOT NULL,          -- fixed_monthly | per_confirmed | per_prepared | per_completed | per_shipped
    amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'DZD',
    frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
    label VARCHAR(120),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW())`,
  "CREATE INDEX IF NOT EXISTS idx_wcr_staff ON worker_compensation_rules(store_id, staff_id)",

  `CREATE TABLE IF NOT EXISTS worker_order_actions(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    staff_id UUID,                            -- NULL = done by the store owner
    order_id UUID NOT NULL,
    order_number VARCHAR(40),
    action VARCHAR(30) NOT NULL,              -- confirmed | prepared | completed | shipped | cancelled | preparing | assigned | called | status_change
    previous_status VARCHAR(40),
    new_status VARCHAR(40),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  "CREATE INDEX IF NOT EXISTS idx_woa_staff_time ON worker_order_actions(store_id, staff_id, action, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_woa_store_time ON worker_order_actions(store_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_woa_order ON worker_order_actions(order_id)",
  // One credit per order per paid action — re-confirming an order can never
  // pay twice, whoever does it.
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_woa_payable ON worker_order_actions(order_id, action) WHERE action IN ('confirmed','prepared','completed','shipped')",

  `CREATE TABLE IF NOT EXISTS worker_login_history(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID,
    store_id UUID,
    identifier VARCHAR(200),
    success BOOLEAN NOT NULL,
    reason VARCHAR(60),
    ip VARCHAR(64),
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  "CREATE INDEX IF NOT EXISTS idx_wlh_staff ON worker_login_history(staff_id, created_at DESC)",

  `CREATE TABLE IF NOT EXISTS worker_tokens(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL,
    store_id UUID NOT NULL,
    kind VARCHAR(10) NOT NULL,                -- invite | reset
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW())`,

  `CREATE TABLE IF NOT EXISTS payroll_periods(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    calculated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, year, month))`,

  `CREATE TABLE IF NOT EXISTS payroll_items(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id UUID NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
    store_id UUID NOT NULL,
    staff_id UUID NOT NULL,
    worker_name VARCHAR(160),
    job_type VARCHAR(120),
    currency VARCHAR(3) NOT NULL DEFAULT 'DZD',
    fixed_amount NUMERIC(14,2) DEFAULT 0,
    commission_amount NUMERIC(14,2) DEFAULT 0,
    bonuses NUMERIC(14,2) DEFAULT 0,
    deductions NUMERIC(14,2) DEFAULT 0,
    net_amount NUMERIC(14,2) DEFAULT 0,
    breakdown JSONB DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'calculated',   -- draft | calculated | approved | paid | cancelled
    locked BOOLEAN DEFAULT FALSE,
    notes TEXT,
    approved_at TIMESTAMPTZ,
    approved_by VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(period_id, staff_id, currency))`,
  "CREATE INDEX IF NOT EXISTS idx_pi_store_staff ON payroll_items(store_id, staff_id)",

  `CREATE TABLE IF NOT EXISTS payroll_adjustments(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES payroll_items(id) ON DELETE CASCADE,
    store_id UUID NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    reason TEXT NOT NULL,
    created_by VARCHAR(160),
    created_at TIMESTAMPTZ DEFAULT NOW())`,

  `CREATE TABLE IF NOT EXISTS payroll_payments(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES payroll_items(id) ON DELETE CASCADE,
    store_id UUID NOT NULL,
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL,
    method VARCHAR(20) NOT NULL,              -- cash | bank_transfer | ccp | baridimob | other
    reference VARCHAR(120),
    paid_at DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    created_by VARCHAR(160),
    created_at TIMESTAMPTZ DEFAULT NOW())`,

  // A delivered order credits a "completed" action to the worker who
  // confirmed it (or, failing that, the worker it is assigned to). Done in
  // the database so every path that marks orders delivered — the dashboard,
  // carrier sync, webhooks — is covered.
  `CREATE OR REPLACE FUNCTION worker_order_completed() RETURNS trigger AS $$
  BEGIN
    IF NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered' THEN
      INSERT INTO worker_order_actions(store_id, staff_id, order_id, order_number, action, previous_status, new_status, metadata)
        SELECT NEW.store_id, a.staff_id, NEW.id, NEW.order_number::text, 'completed', OLD.status, NEW.status, '{"credited_to":"confirmer"}'::jsonb
        FROM worker_order_actions a
        WHERE a.order_id = NEW.id AND a.action = 'confirmed' AND a.staff_id IS NOT NULL
        ORDER BY a.created_at DESC LIMIT 1
      ON CONFLICT DO NOTHING;
      IF NOT FOUND AND NEW.assigned_staff_id IS NOT NULL THEN
        INSERT INTO worker_order_actions(store_id, staff_id, order_id, order_number, action, previous_status, new_status, metadata)
          VALUES (NEW.store_id, NEW.assigned_staff_id, NEW.id, NEW.order_number::text, 'completed', OLD.status, NEW.status, '{"credited_to":"assignee"}'::jsonb)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS trg_worker_order_completed ON orders",
  "CREATE TRIGGER trg_worker_order_completed AFTER UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION worker_order_completed()",
];

let ready = null;
function ensureWorkersSchema() {
  if (!ready) {
    ready = (async () => {
      for (const sql of STATEMENTS) {
        try { await pool.query(sql); } catch (e) { console.log('[workers schema]', e.message.slice(0, 120)); }
      }
      // Existing rows: derive a status from is_active.
      try { await pool.query("UPDATE store_staff SET status = 'inactive' WHERE is_active = FALSE AND (status IS NULL OR status = 'active')"); } catch {}
      try { await pool.query("UPDATE store_staff SET status = 'active' WHERE status IS NULL"); } catch {}
    })();
  }
  return ready;
}

module.exports = { ensureWorkersSchema };
