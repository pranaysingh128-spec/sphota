-- ─────────────────────────────────────────────────────────────────────────
-- Migration: Active review confirmation
--
-- Adds a column to record when the treating psychiatrist clicked:
--   "I have reviewed this AI-generated report and take clinical
--    responsibility for its contents."
--
-- This is in addition to the existing audit_logs entry
-- (action = 'report_review_confirmed') written by /api/report-review.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE report_entries
  ADD COLUMN IF NOT EXISTS review_confirmed_at TEXT;
