-- ═══════════════════════════════════════════════════════════════════════════
-- COMMAND LOG MIGRATION
-- Run this in Supabase SQL Editor (one time)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. command_log_entries table
CREATE TABLE IF NOT EXISTS command_log_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  doctor_id             uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  category              text CHECK (category IN ('doctor','build','learning','note') OR category IS NULL),
  raw_input             text NOT NULL,
  structured_data       jsonb,
  status                text,
  doctor_name_normalized text
);

-- Index for fast lookup by owner
CREATE INDEX IF NOT EXISTS command_log_entries_doctor_id_idx ON command_log_entries(doctor_id);
CREATE INDEX IF NOT EXISTS command_log_entries_created_at_idx ON command_log_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS command_log_entries_normalized_name_idx ON command_log_entries(doctor_name_normalized);

-- RLS: only the owning doctor can read/write their own entries
ALTER TABLE command_log_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS command_log_own_rows ON command_log_entries;
CREATE POLICY command_log_own_rows ON command_log_entries
  FOR ALL
  USING (doctor_id = auth.uid())
  WITH CHECK (doctor_id = auth.uid());

-- 2. gmail_tokens table (refresh tokens stored encrypted)
CREATE TABLE IF NOT EXISTS gmail_tokens (
  doctor_id     uuid PRIMARY KEY REFERENCES doctors(id) ON DELETE CASCADE,
  enc_token     text NOT NULL,
  enc_iv        text NOT NULL,
  enc_tag       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- RLS: only the owner row
ALTER TABLE gmail_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gmail_tokens_own_row ON gmail_tokens;
CREATE POLICY gmail_tokens_own_row ON gmail_tokens
  FOR ALL
  USING (doctor_id = auth.uid())
  WITH CHECK (doctor_id = auth.uid());
