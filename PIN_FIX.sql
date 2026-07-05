-- ══════════════════════════════════════════════════════════════════
-- PIN FIX — Run this in Supabase SQL Editor
-- This adds the pin_hash column that was missing from the doctors table.
-- Without this column, the PIN is never saved and resets every login.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS pin_hash TEXT;

-- Verify it was added (should show pin_hash in the results):
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'doctors' AND column_name = 'pin_hash';
