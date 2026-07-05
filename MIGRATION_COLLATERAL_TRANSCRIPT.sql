-- Migration: add collateral_transcript column to report_entries
-- Run once in Supabase SQL editor

ALTER TABLE report_entries
  ADD COLUMN IF NOT EXISTS collateral_transcript TEXT;
