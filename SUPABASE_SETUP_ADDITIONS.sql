-- ══════════════════════════════════════════════════════════════════════════════
-- SPHOTA — SQL ADDITIONS (run AFTER the base SUPABASE_SETUP.sql)
-- Adds: plan columns to doctors, subscriptions table, unlimited helper
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Add plan columns to doctors table ──────────────────────────────────────
ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free'
    CHECK (plan IN ('free','starter','clinical','premium','unlimited')),
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ DEFAULT NULL;

-- Index for plan expiry checks (e.g. cron that reverts expired plans)
CREATE INDEX IF NOT EXISTS idx_doctors_plan_expires ON doctors(plan_expires_at)
  WHERE plan_expires_at IS NOT NULL;

-- ── 2. Subscriptions table — payment history ───────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                 TEXT NOT NULL CHECK (plan IN ('starter','clinical','premium')),
  razorpay_order_id    TEXT,
  razorpay_payment_id  TEXT,
  amount_paise         INTEGER NOT NULL,
  currency             TEXT DEFAULT 'INR',
  status               TEXT DEFAULT 'active' CHECK (status IN ('active','cancelled','expired','refunded')),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end   TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status  ON subscriptions(status);

-- RLS: doctors can only read their own subscriptions
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscriptions_select_own" ON subscriptions;
CREATE POLICY "subscriptions_select_own" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can insert (used by Razorpay verify endpoint)
DROP POLICY IF EXISTS "subscriptions_service_insert" ON subscriptions;
CREATE POLICY "subscriptions_service_insert" ON subscriptions
  FOR INSERT WITH CHECK (true);

-- ── 3. Make a doctor's account unlimited (free forever) ───────────────────────
-- Run this manually for testing accounts, residents, demo doctors:
--
--   UPDATE doctors SET plan = 'unlimited', plan_expires_at = NULL
--     WHERE id = '<doctor-uuid>';
--
--   UPDATE report_usage SET unlimited = true
--     WHERE user_id = '<doctor-uuid>';
--
-- Both columns are checked; either one grants unlimited access.

-- ── 4. Helper view: active subscriptions ─────────────────────────────────────
CREATE OR REPLACE VIEW active_subscriptions AS
SELECT
  s.user_id,
  s.plan,
  s.razorpay_payment_id,
  s.amount_paise / 100.0 AS amount_inr,
  s.current_period_start,
  s.current_period_end,
  s.created_at
FROM subscriptions s
WHERE s.status = 'active'
  AND (s.current_period_end IS NULL OR s.current_period_end > NOW());

-- ── 5. Update report_usage unlimited column to use doctors.plan as fallback ────
-- The existing unlimited column in report_usage is the primary flag.
-- The doctors.plan = 'unlimited' provides a backup check.
-- No schema change needed — just document the convention.

-- ── 6. Razorpay idempotency — prevent duplicate payment processing ─────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_order_id
  ON subscriptions(razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- ── 7. Receptionist soft-delete: hide patient from receptionist view ───────────
-- Run this migration to enable the receptionist "Remove patient" feature.
-- The doctor side is NOT affected — doctor still sees all patients.
-- To permanently delete a patient, the doctor must do so from their own view.
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS receptionist_hidden boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_patients_receptionist_hidden
  ON patients(doctor_id, receptionist_hidden)
  WHERE receptionist_hidden = true;
