-- ══════════════════════════════════════════════════════════════════════════════
-- SPHOTA — RLS + Migration SQL (FINAL — every type verified from live DB export)
--
-- EXACT LIVE TYPES:
--   ai_usage.user_id              = text       → auth.uid()::text
--   audit_logs.user_id            = uuid       → auth.uid()
--   consent_log.user_id           = uuid       → auth.uid()
--   appointments.doctor_id        = uuid       → auth.uid()
--   medications.doctor_id         = uuid       → auth.uid()
--   patients.doctor_id            = uuid       → auth.uid()
--   report_entries.doctor_id      = uuid       → auth.uid()
--   doctors.id                    = uuid       → auth.uid()
--   doctors.linked_doctor_id      = text       (no RLS needed)
--   report_drafts.doctor_id       = text       → auth.uid()::text
--   receptionist_invites.doctor_user_id = text → auth.uid()::text
-- ══════════════════════════════════════════════════════════════════════════════

-- ── consent_log (user_id = uuid) ──────────────────────────────────────────────
ALTER TABLE consent_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own consent" ON consent_log;
CREATE POLICY "Users can read own consent"
  ON consent_log FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own consent" ON consent_log;
CREATE POLICY "Users can insert own consent"
  ON consent_log FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ── ai_usage (user_id = text) ─────────────────────────────────────────────────
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_usage user policy" ON ai_usage;
CREATE POLICY "ai_usage user policy"
  ON ai_usage FOR ALL
  USING     (auth.uid()::text = user_id)
  WITH CHECK (auth.uid()::text = user_id);

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

-- ── report_drafts (doctor_id = text) ─────────────────────────────────────────
ALTER TABLE report_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors can manage own drafts" ON report_drafts;
CREATE POLICY "Doctors can manage own drafts"
  ON report_drafts FOR ALL
  USING     (auth.uid()::text = doctor_id)
  WITH CHECK (auth.uid()::text = doctor_id);

-- ── report_usage ──────────────────────────────────────────────────────────────
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

-- ── audit_logs (user_id = uuid) ───────────────────────────────────────────────
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own audit logs" ON audit_logs;
CREATE POLICY "Users read own audit logs"
  ON audit_logs FOR SELECT USING (auth.uid() = user_id);

-- ── patients (doctor_id = uuid) ───────────────────────────────────────────────
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors own their patients" ON patients;
CREATE POLICY "Doctors own their patients"
  ON patients FOR ALL
  USING     (auth.uid() = doctor_id)
  WITH CHECK (auth.uid() = doctor_id);

-- ── report_entries (doctor_id = uuid) ────────────────────────────────────────
ALTER TABLE report_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors own their report entries" ON report_entries;
CREATE POLICY "Doctors own their report entries"
  ON report_entries FOR ALL
  USING     (auth.uid() = doctor_id)
  WITH CHECK (auth.uid() = doctor_id);

-- ── medications (doctor_id = uuid) ───────────────────────────────────────────
ALTER TABLE medications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors own their medications" ON medications;
CREATE POLICY "Doctors own their medications"
  ON medications FOR ALL
  USING     (auth.uid() = doctor_id)
  WITH CHECK (auth.uid() = doctor_id);

-- ── appointments (doctor_id = uuid) ──────────────────────────────────────────
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors own their appointments" ON appointments;
CREATE POLICY "Doctors own their appointments"
  ON appointments FOR ALL
  USING     (auth.uid() = doctor_id)
  WITH CHECK (auth.uid() = doctor_id);

-- ── doctors (id = uuid) ───────────────────────────────────────────────────────
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

-- ── receptionist_invites (doctor_user_id = text) ──────────────────────────────
ALTER TABLE receptionist_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Doctors manage own invites" ON receptionist_invites;
CREATE POLICY "Doctors manage own invites"
  ON receptionist_invites FOR ALL
  USING     (auth.uid()::text = doctor_user_id)
  WITH CHECK (auth.uid()::text = doctor_user_id);

-- ── Missing columns ───────────────────────────────────────────────────────────
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS mci_number           TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS note_format          TEXT NOT NULL DEFAULT 'SOAP';
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS data_region          TEXT NOT NULL DEFAULT 'India';
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS data_retention_years TEXT DEFAULT 'never';
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS consent_given_at     TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS doctors_linked_doctor_idx ON doctors(linked_doctor_id);

ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone            TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS reason           TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS checked_in_at    TIMESTAMPTZ;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS consent_given_at TIMESTAMPTZ;
