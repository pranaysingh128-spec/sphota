/**
 * ENVIRONMENT VARIABLE SECURITY CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 * VITE_SUPABASE_URL      ✅ safe to expose  — public project URL
 * VITE_SUPABASE_ANON_KEY ✅ safe to expose  — anon key, protected by RLS
 *
 * AI_KEY_1               ❌ server-side ONLY — never prefix with VITE_
 * AI_KEY_2               ❌ server-side ONLY — never prefix with VITE_
 * AI_KEY_3               ❌ server-side ONLY — never prefix with VITE_
 * SUPABASE_SERVICE_ROLE_KEY ❌ server-side ONLY — never prefix with VITE_
 * FIELD_ENCRYPTION_KEY   ❌ server-side ONLY — never prefix with VITE_
 *
 * If you add a new API key or secret: it goes in api/ and uses process.env.
 * It NEVER goes in src/ and NEVER uses import.meta.env.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createClient } from "@supabase/supabase-js";

let supabaseUrl  = import.meta.env.VITE_SUPABASE_URL as string ?? "";
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string ?? "";

// Normalize URL — auto-prepend https:// if the protocol is missing
if (supabaseUrl && !supabaseUrl.startsWith("https://") && !supabaseUrl.startsWith("http://")) {
  supabaseUrl = "https://" + supabaseUrl;
}

// Create client — if env vars are missing at runtime (not build time) the app
// will show auth errors rather than crashing the entire build.
export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnon || "placeholder",
  { auth: { persistSession: true } }
);

// Runtime warning (only fires in the browser, not during build)
if (typeof window !== "undefined" && (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY)) {
  console.error("VITE_SUPABASE_URL:", import.meta.env.VITE_SUPABASE_URL ? "set" : "MISSING");
  console.error("VITE_SUPABASE_ANON_KEY:", import.meta.env.VITE_SUPABASE_ANON_KEY ? "set" : "MISSING");
  console.error("Add these to Vercel → Project → Settings → Environment Variables");
}
