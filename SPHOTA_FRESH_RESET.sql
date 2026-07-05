-- ══════════════════════════════════════════════════════════════════════════════
-- SPHOTA — FRESH RESET SQL (v5 — with all fixes)
-- Run ONCE in Supabase → SQL Editor → paste all → Run
--
-- ⚠️  DESTRUCTIVE: Deletes ALL data + ALL existing logged-in sessions.
--     Auth users in auth.users are NOT deleted — only public schema data.
--
-- AFTER RUNNING:
--   1. Log in to Sphota app (creates doctors row)
--   2. Run: UPDATE doctors SET role = 'admin' WHERE email = 'your@email.com';
--   3. Set your PIN again in the app (old PIN was wiped)
-- ══════════════════════════════════════════════════════════════════════════════

-- STEP 0: DROP EVERYTHING (clean slate)
DROP VIEW IF EXISTS active_subscriptions CASCADE;

DROP POLICY IF EXISTS "admin_full_access" ON doctors;
DROP POLICY IF EXISTS "admin_full_access_doctors" ON doctors;
DROP POLICY IF EXISTS "doctors_select_own" ON doctors;
DROP POLICY IF EXISTS "doctors_insert_own" ON doctors;
DROP POLICY IF EXISTS "doctors_update_own" ON doctors;
DROP POLICY IF EXISTS "doctors_own_row" ON doctors;
DROP POLICY IF EXISTS "admin_delete_doctors" ON doctors;
DROP POLICY IF EXISTS "Doctors read own profile" ON doctors;
DROP POLICY IF EXISTS "Doctors update own profile" ON doctors;
DROP POLICY IF EXISTS "Doctors insert own profile" ON doctors;

DROP POLICY IF EXISTS "patients_doctor_access" ON patients;
DROP POLICY IF EXISTS "patients_doctor_own" ON patients;
DROP POLICY IF EXISTS "admin_full_access_patients" ON patients;
DROP POLICY IF EXISTS "Doctors own their patients" ON patients;

DROP POLICY IF EXISTS "report_entries_doctor_access" ON report_entries;
DROP POLICY IF EXISTS "report_entries_doctor_own" ON report_entries;
DROP POLICY IF EXISTS "Doctors own their report entries" ON report_entries;

DROP POLICY IF EXISTS "medications_doctor_access" ON medications;
DROP POLICY IF EXISTS "medications_doctor_own" ON medications;
DROP POLICY IF EXISTS "Doctors own their medications" ON medications;

DROP POLICY IF EXISTS "appointments_doctor_access" ON appointments;
DROP POLICY IF EXISTS "appointments_doctor_own" ON appointments;
DROP POLICY IF EXISTS "Doctors own their appointments" ON appointments;

DROP POLICY IF EXISTS "report_usage_own" ON report_usage;
DROP POLICY IF EXISTS "Users manage own report usage" ON report_usage;

DROP POLICY IF EXISTS "subscriptions_select_own" ON subscriptions;
DROP POLICY IF EXISTS "subscriptions_insert_any" ON subscriptions;
DROP POLICY IF EXISTS "subscriptions_admin_all" ON subscriptions;
DROP POLICY IF EXISTS "subscriptions_service_insert" ON subscriptions;

DROP POLICY IF EXISTS "ai_usage_own" ON ai_usage;
DROP POLICY IF EXISTS "ai_usage user policy" ON ai_usage;

DROP POLICY IF EXISTS "audit_logs_own" ON audit_logs;
DROP POLICY IF EXISTS "audit_logs_select_own" ON audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert_auth" ON audit_logs;
DROP POLICY IF EXISTS "Users read own audit logs" ON audit_logs;

DROP POLICY IF EXISTS "consent_log_own_select" ON consent_log;
DROP POLICY IF EXISTS "consent_log_own_insert" ON consent_log;
DROP POLICY IF EXISTS "Users can read own consent" ON consent_log;
DROP POLICY IF EXISTS "Users can insert own consent" ON consent_log;

DROP POLICY IF EXISTS "report_drafts_own" ON report_drafts;
DROP POLICY IF EXISTS "Doctors can manage own drafts" ON report_drafts;

DROP POLICY IF EXISTS "receptionist_invites_own" ON receptionist_invites;
DROP POLICY IF EXISTS "receptionist_invites_public_read" ON receptionist_invites;
DROP POLICY IF EXISTS "Doctors manage own invites" ON receptionist_invites;

DROP POLICY IF EXISTS "beta_feedback_insert" ON beta_feedback;
DROP POLICY IF EXISTS "beta_feedback_admin_read" ON beta_feedback;
DROP POLICY IF EXISTS "beta_feedback_admin_update" ON beta_feedback;

DROP POLICY IF EXISTS "admin_actions_admin_only" ON admin_actions;
DROP POLICY IF EXISTS "admin_actions_insert_auth" ON admin_actions;

DROP FUNCTION IF EXISTS increment_ai_usage(TEXT, TEXT, TIMESTAMPTZ) CASCADE;
DROP FUNCTION IF EXISTS is_admin() CASCADE;

DROP TABLE IF EXISTS admin_actions        CASCADE;
DROP TABLE IF EXISTS report_entries       CASCADE;
DROP TABLE IF EXISTS medications          CASCADE;
DROP TABLE IF EXISTS appointments         CASCADE;
DROP TABLE IF EXISTS patients             CASCADE;
DROP TABLE IF EXISTS report_drafts        CASCADE;
DROP TABLE IF EXISTS receptionist_invites CASCADE;
DROP TABLE IF EXISTS report_usage         CASCADE;
DROP TABLE IF EXISTS subscriptions        CASCADE;
DROP TABLE IF EXISTS ai_usage             CASCADE;
DROP TABLE IF EXISTS audit_logs           CASCADE;
DROP TABLE IF EXISTS consent_log          CASCADE;
DROP TABLE IF EXISTS beta_feedback        CASCADE;
DROP TABLE IF EXISTS admin_actions        CASCADE;
DROP TABLE IF EXISTS doctors              CASCADE;


-- STEP 1: SECURITY DEFINER HELPER
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM doctors WHERE id = auth.uid() AND role = 'admin');
END;
$$;


-- STEP 2: CREATE ALL TABLES

CREATE TABLE doctors (
  id                   UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL DEFAULT '',
  email                TEXT,
  specialty            TEXT DEFAULT 'Psychiatry',
  clinic               TEXT DEFAULT '',
  contact              TEXT DEFAULT '',
  role                 TEXT DEFAULT 'doctor',
  plan                 TEXT DEFAULT 'free',
  plan_expires_at      TIMESTAMPTZ DEFAULT NULL,
  pin_hash             TEXT,
  mci_number           TEXT,
  note_format          TEXT NOT NULL DEFAULT 'SOAP',
  data_region          TEXT NOT NULL DEFAULT 'India',
  data_retention_years TEXT DEFAULT 'never',
  consent_given_at     TIMESTAMPTZ,
  privacy_accepted_at  TIMESTAMPTZ,
  tour_done            BOOLEAN DEFAULT FALSE,
  admin_notes          TEXT,
  linked_doctor_id     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE patients (
  id               BIGSERIAL PRIMARY KEY,
  doctor_id        UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  age              INTEGER DEFAULT 0,
  gender           TEXT DEFAULT 'Unknown',
  time             TEXT DEFAULT '',
  status           TEXT DEFAULT 'waiting',
  phone            TEXT,
  reason           TEXT,
  address          TEXT,
  checked_in_at    TIMESTAMPTZ,
  consent_given_at TIMESTAMPTZ,
  receptionist_hidden BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_patients_doctor_id ON patients(doctor_id);
CREATE INDEX idx_patients_receptionist_hidden ON patients(doctor_id, receptionist_hidden) WHERE receptionist_hidden = true;

CREATE TABLE report_entries (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id                   UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  patient_id                  BIGINT NOT NULL,
  date                        TEXT NOT NULL,
  transcript                  TEXT DEFAULT '',
  raw_text                    TEXT DEFAULT '',
  edited_html                 TEXT,
  edited_at                   TEXT,
  review_confirmed_at         TEXT,
  notes                       TEXT DEFAULT '',
  flagged                     BOOLEAN DEFAULT FALSE,
  patient_doc_md              TEXT,
  patient_doc_hindi_md        TEXT,
  patient_doc_marathi_md      TEXT,
  patient_doc_bengali_md      TEXT,
  patient_doc_tamil_md        TEXT,
  patient_doc_telugu_md       TEXT,
  patient_doc_edited_html_en  TEXT,
  patient_doc_edited_html_hi  TEXT,
  scale_scores_json           TEXT,
  collateral_transcript       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_report_entries_doctor_id  ON report_entries(doctor_id);
CREATE INDEX idx_report_entries_patient_id ON report_entries(patient_id);

CREATE TABLE medications (
  id          BIGSERIAL PRIMARY KEY,
  doctor_id   UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  patient_id  BIGINT NOT NULL,
  data        JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_medications_doctor_patient ON medications(doctor_id, patient_id);
CREATE INDEX idx_medications_doctor_id ON medications(doctor_id);

CREATE TABLE appointments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  patient_id  BIGINT NOT NULL,
  date        TEXT NOT NULL,
  time        TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_appointments_doctor_id ON appointments(doctor_id);

CREATE TABLE report_usage (
  user_id             UUID PRIMARY KEY REFERENCES doctors(id) ON DELETE CASCADE,
  count               INTEGER NOT NULL DEFAULT 0,
  monthly_count       INTEGER NOT NULL DEFAULT 0,
  month_key           TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM'),
  feedback_bonus_used BOOLEAN NOT NULL DEFAULT FALSE,
  unlimited           BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                 TEXT NOT NULL,
  razorpay_order_id    TEXT,
  razorpay_payment_id  TEXT,
  amount_paise         INTEGER NOT NULL DEFAULT 0,
  currency             TEXT DEFAULT 'INR',
  status               TEXT DEFAULT 'active',
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end   TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE UNIQUE INDEX idx_subscriptions_order_id ON subscriptions(razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

CREATE TABLE ai_usage (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  call_count   INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, endpoint, window_start)
);
CREATE INDEX idx_ai_usage_user_id ON ai_usage(user_id);

CREATE TABLE audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  ip            TEXT,
  user_agent    TEXT,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);

CREATE TABLE consent_log (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL,
  consent_type TEXT NOT NULL DEFAULT 'privacy',
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE report_drafts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   TEXT NOT NULL,
  patient_id  BIGINT NOT NULL,
  draft_html  TEXT,
  transcript  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_drafts_doctor_id_patient_id_key UNIQUE (doctor_id, patient_id)
);
CREATE INDEX idx_report_drafts_doctor_id ON report_drafts(doctor_id);

-- receptionist_invites — uses 'email' column (NOT 'receptionist_email')
CREATE TABLE receptionist_invites (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_user_id   TEXT NOT NULL,
  email            TEXT NOT NULL,
  status           TEXT DEFAULT 'pending',
  used             BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE beta_feedback (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role               TEXT,
  ratings            JSONB,
  choices            JSONB,
  pricing_preference TEXT,
  open_answers       JSONB,
  contact            JSONB,
  contacted          BOOLEAN DEFAULT FALSE,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID,
  action_type   TEXT NOT NULL,
  target_table  TEXT,
  target_id     TEXT,
  old_value     JSONB,
  new_value     JSONB,
  performed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_admin_actions_admin_id     ON admin_actions(admin_id);
CREATE INDEX idx_admin_actions_performed_at ON admin_actions(performed_at);


-- STEP 3: ENABLE RLS
ALTER TABLE doctors              ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients             ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE medications          ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_usage         ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_drafts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE receptionist_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_feedback        ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_actions        ENABLE ROW LEVEL SECURITY;


-- STEP 4: RLS POLICIES
CREATE POLICY "doctors_select_own" ON doctors
  FOR SELECT USING (auth.uid() = id OR is_admin());
CREATE POLICY "doctors_insert_own" ON doctors
  FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "doctors_update_own" ON doctors
  FOR UPDATE USING (auth.uid() = id OR is_admin())
  WITH CHECK (auth.uid() = id OR is_admin());
CREATE POLICY "admin_delete_doctors" ON doctors
  FOR DELETE USING (is_admin());

CREATE POLICY "patients_doctor_own" ON patients
  FOR ALL USING (auth.uid() = doctor_id OR is_admin())
  WITH CHECK (auth.uid() = doctor_id OR is_admin());

CREATE POLICY "report_entries_doctor_own" ON report_entries
  FOR ALL USING (auth.uid() = doctor_id OR is_admin())
  WITH CHECK (auth.uid() = doctor_id OR is_admin());

CREATE POLICY "medications_doctor_own" ON medications
  FOR ALL USING (auth.uid() = doctor_id OR is_admin())
  WITH CHECK (auth.uid() = doctor_id OR is_admin());

CREATE POLICY "appointments_doctor_own" ON appointments
  FOR ALL USING (auth.uid() = doctor_id OR is_admin())
  WITH CHECK (auth.uid() = doctor_id OR is_admin());

CREATE POLICY "report_usage_own" ON report_usage
  FOR ALL USING (auth.uid() = user_id OR is_admin())
  WITH CHECK (auth.uid() = user_id OR is_admin());

CREATE POLICY "subscriptions_select_own" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id OR is_admin());
CREATE POLICY "subscriptions_insert_any" ON subscriptions
  FOR INSERT WITH CHECK (true);
CREATE POLICY "subscriptions_admin_all" ON subscriptions
  FOR ALL USING (is_admin());

CREATE POLICY "ai_usage_own" ON ai_usage
  FOR ALL USING (auth.uid()::text = user_id OR is_admin())
  WITH CHECK (auth.uid()::text = user_id OR is_admin());

CREATE POLICY "audit_logs_select_own" ON audit_logs
  FOR SELECT USING (auth.uid() = user_id OR is_admin());
CREATE POLICY "audit_logs_insert_auth" ON audit_logs
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "consent_log_own_select" ON consent_log
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "consent_log_own_insert" ON consent_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "report_drafts_own" ON report_drafts
  FOR ALL USING (auth.uid()::text = doctor_id OR is_admin())
  WITH CHECK (auth.uid()::text = doctor_id OR is_admin());

CREATE POLICY "receptionist_invites_own" ON receptionist_invites
  FOR ALL USING (auth.uid()::text = doctor_user_id OR is_admin())
  WITH CHECK (auth.uid()::text = doctor_user_id OR is_admin());
CREATE POLICY "receptionist_invites_public_read" ON receptionist_invites
  FOR SELECT USING (true);

CREATE POLICY "beta_feedback_insert" ON beta_feedback
  FOR INSERT WITH CHECK (true);
CREATE POLICY "beta_feedback_admin_read" ON beta_feedback
  FOR SELECT USING (is_admin());
CREATE POLICY "beta_feedback_admin_update" ON beta_feedback
  FOR UPDATE USING (is_admin());

CREATE POLICY "admin_actions_admin_only" ON admin_actions
  FOR ALL USING (is_admin());


-- STEP 5: HELPER FUNCTIONS & INDEXES
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

CREATE INDEX idx_doctors_plan_expires ON doctors(plan_expires_at) WHERE plan_expires_at IS NOT NULL;
CREATE INDEX idx_doctors_role         ON doctors(role);
CREATE INDEX idx_doctors_linked       ON doctors(linked_doctor_id);

CREATE OR REPLACE VIEW active_subscriptions AS
SELECT
  s.user_id, s.plan, s.razorpay_payment_id,
  s.amount_paise / 100.0 AS amount_inr,
  s.current_period_start, s.current_period_end, s.created_at
FROM subscriptions s
WHERE s.status = 'active'
  AND (s.current_period_end IS NULL OR s.current_period_end > NOW());


-- ── Supabase Realtime: enable for live cross-device sync ──
ALTER PUBLICATION supabase_realtime ADD TABLE patients;
ALTER PUBLICATION supabase_realtime ADD TABLE report_entries;
ALTER PUBLICATION supabase_realtime ADD TABLE medications;
ALTER PUBLICATION supabase_realtime ADD TABLE appointments;
ALTER PUBLICATION supabase_realtime ADD TABLE report_drafts;


-- ══════════════════════════════════════════════════════════════════════════════
-- AFTER RUNNING THIS SQL:
--   1. Reload the app, log in (this creates your doctors row)
--   2. Run: UPDATE doctors SET role = 'admin' WHERE email = 'getsphota@gmail.com';
--   3. Set PIN in profile settings
-- ══════════════════════════════════════════════════════════════════════════════
