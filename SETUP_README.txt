SPHOTA — SETUP INSTRUCTIONS
===========================

PROBLEMS FIXED IN THIS PACKAGE:
  1. Cannot add patients  → circular RLS fixed with is_admin() SECURITY DEFINER
  2. PIN asked every time → pin_hash column + localStorage unlock persistence
  3. Missing patient data → fresh DB reset (all old data wiped intentionally)

STEP 1 — RUN SQL (Supabase → SQL Editor)
  Open: SPHOTA_FRESH_RESET.sql
  Paste entire file → Run
  ⚠️  This DELETES all patients, reports, subscriptions data.
      Auth users are kept — you must re-create your doctor profile on next login.

STEP 2 — LOG IN TO SPHOTA APP
  Open your deployed Sphota app and sign in once.
  This recreates your row in the doctors table.

STEP 3 — MAKE YOURSELF ADMIN
  In Supabase SQL Editor, run (replace email):
    UPDATE doctors SET role = 'admin' WHERE email = 'your@email.com';

STEP 4 — SET YOUR PIN AGAIN
  In the Sphota app, set a new PIN (old PIN was wiped with the reset).

STEP 5 — OPEN COMMAND CENTER
  Open sphota_admin.html in Chrome (double-click the file).
  Enter your Supabase URL + anon key (saved to localStorage).
  You must be logged in to Sphota in the same browser first.

FILES:
  SPHOTA_FRESH_RESET.sql  — run this in Supabase (destructive reset)
  sphota_admin.html       — Admin Command Center (single file, no install)
  src/                    — updated Sphota app (PIN fix in AuthGate.tsx)
