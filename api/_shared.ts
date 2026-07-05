// Shared utilities for Vercel serverless functions.
// Prefixed with _ so Vercel does NOT treat this as a standalone function.

export function setCors(req: any, res: any): boolean {
  const origin: string = req.headers?.["origin"] ?? "";
  if (!origin) {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") { res.status(204).end(); return true; }
    return false;
  }
  const allowed = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const isVercelPreview = origin.endsWith(".vercel.app");
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const isAllowed = isLocalhost || process.env.NODE_ENV !== "production" || isVercelPreview || allowed.includes(origin);
  res.setHeader("Access-Control-Allow-Origin", isAllowed ? origin : "null");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

export function getSupabaseEnv(): { url: string; key: string } | null {
  let url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url) { console.error("[_shared] Missing SUPABASE_URL"); return null; }
  if (!key) { console.error("[_shared] Missing SUPABASE_SERVICE_ROLE_KEY"); return null; }
  if (!url.startsWith("http")) url = "https://" + url;
  return { url, key };
}

export async function verifySupabaseToken(
  token: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<string | null> {
  if (!token) return null;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? serviceKey;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
    if (!res.ok) return null;
    const user = await res.json() as { id?: string };
    return user?.id ?? null;
  } catch {
    return null;
  }
}

// ── Twilio WhatsApp alert (best-effort, never throws) ─────────────────────────
// Called from any serverless function when a critical error occurs.
// Requires env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, TWILIO_WHATSAPP_TO
export async function sendWhatsAppAlert(message: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken  = process.env.TWILIO_AUTH_TOKEN  ?? "";
  const from       = process.env.TWILIO_WHATSAPP_FROM ?? ""; // e.g. whatsapp:+14155238886
  const to         = process.env.TWILIO_WHATSAPP_TO   ?? ""; // e.g. whatsapp:+91XXXXXXXXXX
  if (!accountSid || !authToken || !from || !to) return;

  const body = `🚨 Sphota Alert\n${message.slice(0, 1500)}`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    });
  } catch (err) {
    console.warn("[sendWhatsAppAlert] failed:", err instanceof Error ? err.message : err);
  }
}
