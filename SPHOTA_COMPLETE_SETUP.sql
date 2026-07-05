-- ══════════════════════════════════════════════════════════════════════════════
-- SPHOTA — COMPLETE SUPABASE SETUP (Run this entire file in Supabase SQL Editor)
--
-- Run ORDER: This single file contains everything in the correct order.
-- You can run it all at once — every statement uses IF NOT EXISTS / OR REPLACE.
--
-- HOW TO MAKE A DOCTOR FREE FOREVER (unlimited access):
--   UPDATE doctors SET plan = 'unlimited', plan_expires_at = NULL
--     WHERE id = '<paste-doctor-uuid-here>';
--   UPDATE report_usage SET unlimited = true
--     WHERE user_id = '<paste-doctor-uuid-here>';
--
-- Find a doctor UUID: Supabase → Authentication → Users → copy the UID
-- ══════════════════════════════════════════════════════════════════════════════

-- ── STEP 1: RLS for all tables ────────────────────────────────────────────────

-- consent_log (user_id = uuid)
ALTER TABLE consent_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own consent" ON consent_log;
CREATE POLICY "Users can read own consent"
  ON consent_log FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own consent" ON consent_log;
CREATE POLICY "Users can insert own consent"
  ON consent_log FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ai_usage (user_id = text)
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_usage user policy" ON ai_usage;
CREATE POLICY "ai_usage user policy"
  ON ai_usage FOR ALL
  USING     (auth.uid()::text = user_id)
  WITH CHECK (auth.uid()::text = user_id);

-- report_drafts (doctor_id = text)
ALTER TABLE report_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors can manage own drafts" ON report_drafts;
CREATE POLICY "Doctors can manage own drafts"
  ON report_drafts FOR ALL
  USING     (auth.uid()::text = doctor_id)
  WITH CHECK (auth.uid()::text = doctor_id);

-- audit_logs (user_id = uuid)
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own audit logs" ON audit_logs;
CREATE POLICY "Users read own audit logs"
  ON audit_logs FOR SELECT USING (auth.uid() = user_id);

-- patients (doctor_id = uuid)
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors own their patients" ON patients;
CREATE POLICY "Doctors own their patients"
  ON patients FOR ALL
  USING     (auth.uid() = doctor_id)
  WITH CHECK (auth.uid() = doctor_id);

-- report_entries (doctor_id = uuid)
ALTER TABLE report_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors own their report entries" ON report_entries;
CREATE POLICY "Doctors own their report entries"
  ON report_entries FOR ALL
  USING     (auth.uid() = doctor_id)
  WITH CHECK (auth.uid() = doctor_id);

-- Add columns introduced in June 2025 migrations (safe to run on existing DBs)
ALTER TABLE report_entries ADD COLUMN IF NOT EXISTS collateral_transcript TEXT;
ALTER TABLE report_entries ADD COLUMN IF NOT EXISTS review_confirmed_at TEXT;

-- medications (doctor_id = uuid)
ALTER TABLE medications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors own their medications" ON medications;
CREATE POLICY "Doctors own their medications"
  ON medications FOR ALL
  USING     (auth.uid() = doctor_id)
  WITH CHECK (auth.uid() = doctor_id);

-- appointments (doctor_id = uuid)
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors own their appointments" ON appointments;
CREATE POLICY "Doctors own their appointments"
  ON appointments FOR ALL
  USING     (auth.uid() = doctor_id)
  WITH CHECK (auth.uid() = doctor_id);

-- doctors (id = uuid)
ALTER TABLE doctors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors read own profile" ON doctors;
CREATE POLICY "Doctors read own profile"
  ON doctors FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "Doctors update own profile" ON doctors;
CREATE POLICY "Doctors update own profile"
  ON doctors FOR UPDATE
  USING     (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "Doctors insert own profile" ON doctors;
CREATE POLICY "Doctors insert own profile"
  ON doctors FOR INSERT WITH CHECK (auth.uid() = id);

-- receptionist_invites (doctor_user_id = text)
ALTER TABLE receptionist_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors manage own invites" ON receptionist_invites;
CREATE POLICY "Doctors manage own invites"
  ON receptionist_invites FOR ALL
  USING     (auth.uid()::text = doctor_user_id)
  WITH CHECK (auth.uid()::text = doctor_user_id);

-- ── STEP 2: Missing columns (safe to re-run) ──────────────────────────────────

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS mci_number            TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS note_format           TEXT NOT NULL DEFAULT 'SOAP';
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS data_region           TEXT NOT NULL DEFAULT 'India';
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS data_retention_years  TEXT DEFAULT 'never';
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS consent_given_at      TIMESTAMPTZ;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS plan                  TEXT DEFAULT 'free'
  CHECK (plan IN ('free','starter','clinical','premium','unlimited'));
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS plan_expires_at       TIMESTAMPTZ DEFAULT NULL;
-- email column — mirrors auth.users.email so you can identify doctors at a glance
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS email                 TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS pin_hash              TEXT;

CREATE INDEX IF NOT EXISTS doctors_linked_doctor_idx ON doctors(linked_doctor_id);
CREATE INDEX IF NOT EXISTS idx_doctors_plan_expires  ON doctors(plan_expires_at)
  WHERE plan_expires_at IS NOT NULL;

ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone            TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS reason           TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS address          TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS checked_in_at    TIMESTAMPTZ;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS consent_given_at TIMESTAMPTZ;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS receptionist_hidden BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_patients_receptionist_hidden
  ON patients(doctor_id, receptionist_hidden)
  WHERE receptionist_hidden = true;

-- ── STEP 3: report_usage table ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS report_usage (
  user_id             UUID    PRIMARY KEY,
  count               INTEGER NOT NULL DEFAULT 0,
  monthly_count       INTEGER NOT NULL DEFAULT 0,
  month_key           TEXT    NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM'),
  feedback_bonus_used BOOLEAN NOT NULL DEFAULT FALSE,
  unlimited           BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE report_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own report usage" ON report_usage;
CREATE POLICY "Users manage own report usage"
  ON report_usage FOR ALL
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── STEP 4: increment_ai_usage RPC function ───────────────────────────────────

CREATE OR REPLACE FUNCTION increment_ai_usage(
  p_user_id      TEXT,
  p_endpoint     TEXT,
  p_window_start TIMESTAMPTZ
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_count INTEGER;
BEGIN
  INSERT INTO ai_usage (user_id, endpoint, window_start, call_count)
  VALUES (p_user_id, p_endpoint, p_window_start, 1)
  ON CONFLICT (user_id, endpoint, window_start)
  DO UPDATE SET call_count = ai_usage.call_count + 1;
  SELECT call_count INTO v_count FROM ai_usage
  WHERE user_id = p_user_id AND endpoint = p_endpoint AND window_start = p_window_start;
  RETURN v_count;
END;
$$;

-- ── STEP 5: subscriptions table (Razorpay payment history) ───────────────────

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

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscriptions_select_own" ON subscriptions;
CREATE POLICY "subscriptions_select_own" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "subscriptions_service_insert" ON subscriptions;
CREATE POLICY "subscriptions_service_insert" ON subscriptions
  FOR INSERT WITH CHECK (true);

-- Razorpay idempotency — prevent duplicate payment processing
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_order_id
  ON subscriptions(razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- ── STEP 6: Active subscriptions helper view ──────────────────────────────────

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

-- ══════════════════════════════════════════════════════════════════════════════
-- HOW TO FIND DOCTORS BY EMAIL (much easier than hunting UIDs)
-- ══════════════════════════════════════════════════════════════════════════════
--
--   SELECT id, email, plan, plan_expires_at FROM doctors ORDER BY created_at DESC;
--
-- ══════════════════════════════════════════════════════════════════════════════
-- HOW TO GRANT UNLIMITED ACCESS TO A DOCTOR (by email — copy-paste friendly)
-- ══════════════════════════════════════════════════════════════════════════════
--
--   -- Step 1: find the doctor's UUID by email
--   SELECT id FROM doctors WHERE email = 'doctor@example.com';
--
--   -- Step 2: grant unlimited (replace the UUID below)
--   UPDATE doctors
--     SET plan = 'unlimited', plan_expires_at = NULL
--     WHERE id = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
--
--   UPDATE report_usage
--     SET unlimited = true
--     WHERE user_id = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
--
-- Or do it in one shot by email (no UUID needed):
--   UPDATE doctors
--     SET plan = 'unlimited', plan_expires_at = NULL
--     WHERE email = 'doctor@example.com';
--   UPDATE report_usage
--     SET unlimited = true
--     WHERE user_id = (SELECT id FROM doctors WHERE email = 'doctor@example.com');
--
-- To REVOKE unlimited access later:
--   UPDATE doctors SET plan = 'free', plan_expires_at = NULL
--     WHERE email = 'doctor@example.com';
--   UPDATE report_usage SET unlimited = false
--     WHERE user_id = (SELECT id FROM doctors WHERE email = 'doctor@example.com');
-- ══════════════════════════════════════════════════════════════════════════════
-- HOW TO GRANT A TIME-LIMITED PLAN (e.g. 3 months of Premium)
-- ══════════════════════════════════════════════════════════════════════════════
--
--   UPDATE doctors
--     SET plan = 'premium',
--         plan_expires_at = NOW() + INTERVAL '3 months'
--     WHERE email = 'doctor@example.com';
-- ══════════════════════════════════════════════════════════════════════════════
