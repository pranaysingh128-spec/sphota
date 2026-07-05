export const config = { runtime: "nodejs" };

// Merged: /api/consent  +  /api/delete-account
// Vercel rewrites in vercel.json route both URLs here via ?action= query param.
// Behaviour is 100% identical to the original two separate files.

// ── Inlined helpers ───────────────────────────────────────────────────────────
function setCors(req: any, res: any): boolean {
  const origin: string = req.headers["origin"] ?? "";
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

function getSupabaseEnv(): { url: string; key: string } | null {
  let url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url) { console.error("[account] Missing SUPABASE_URL"); return null; }
  if (!key) { console.error("[account] Missing SUPABASE_SERVICE_ROLE_KEY"); return null; }
  if (!url.startsWith("http")) url = "https://" + url;
  return { url, key };
}

async function verifyToken(token: string, url: string, key: string): Promise<string | null> {
  if (!token) return null;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? key;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: anonKey } });
    if (!r.ok) return null;
    const u = await r.json() as { id?: string };
    return u?.id ?? null;
  } catch { return null; }
}

function getRequestIp(req: any): string {
  return ((req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "") as string).split(",")[0].trim();
}

function logAudit(url: string, key: string, event: any): void {
  fetch(`${url}/rest/v1/audit_logs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: event.userId, action: event.action, resource_type: event.resourceType ?? null, resource_id: event.resourceId ?? null, ip: event.ip ?? null, user_agent: event.userAgent ?? null, details: event.details ?? null }),
  }).catch((err) => console.warn("[sphota/audit] Failed:", err?.message ?? err));
}

// ── Consent handler (original api/consent.ts logic) ───────────────────────────
async function handleConsent(req: any, res: any) {
  try {
    const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "").replace(/^(?!https?:\/\/)/, "https://");
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();

    async function getCtx() {
      if (!supabaseUrl || supabaseUrl === "https://" || !serviceKey) return { supabaseUrl, serviceKey, userId: "__misconfigured__" };
      if (!token) return { supabaseUrl, serviceKey, userId: "" };
      try {
        const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: serviceKey } });
        if (!authRes.ok) return { supabaseUrl, serviceKey, userId: "" };
        const user = await authRes.json() as { id?: string };
        return { supabaseUrl, serviceKey, userId: user?.id ?? "" };
      } catch { return { supabaseUrl, serviceKey, userId: "" }; }
    }

    if (req.method === "GET") {
      let ctx: any;
      try { ctx = await getCtx(); } catch { return res.status(200).json({ hasConsented: true, _warn: "ctx_error" }); }
      if (!ctx || ctx.userId === "__misconfigured__") return res.status(200).json({ hasConsented: true, _warn: "misconfigured" });
      if (!ctx.userId) return res.status(200).json({ unauthenticated: true, hasConsented: false });
      try {
        const r = await fetch(
          `${ctx.supabaseUrl}/rest/v1/consent_log?user_id=eq.${encodeURIComponent(ctx.userId)}&consent_type=eq.terms_and_privacy&withdrawn_at=is.null&order=given_at.desc&limit=1`,
          { headers: { Authorization: `Bearer ${ctx.serviceKey}`, apikey: ctx.serviceKey, Accept: "application/json" } }
        );
        if (!r.ok) return res.status(200).json({ hasConsented: false, _warn: "table_unavailable" });
        const rows = await r.json() as any[];
        const row = rows?.[0] ?? null;
        return res.status(200).json({ hasConsented: !!row, givenAt: row?.given_at ?? null });
      } catch { return res.status(200).json({ hasConsented: false, _warn: "check_failed" }); }
    }

    if (req.method === "POST") {
      let ctx: any;
      try { ctx = await getCtx(); } catch { return res.status(200).json({ ok: true, _warn: "not_persisted" }); }
      if (!ctx || !ctx.userId || ctx.userId === "__misconfigured__") return res.status(200).json({ ok: true, _warn: "not_persisted" });
      const body = req.body ?? {};
      const isWithdraw = req.query?.action === "withdraw" || body.action === "withdraw";
      if (isWithdraw) {
        try {
          await fetch(`${ctx.supabaseUrl}/rest/v1/consent_log?user_id=eq.${encodeURIComponent(ctx.userId)}&consent_type=eq.terms_and_privacy&withdrawn_at=is.null`,
            { method: "PATCH", headers: { Authorization: `Bearer ${ctx.serviceKey}`, apikey: ctx.serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ withdrawn_at: new Date().toISOString() }) }
          );
        } catch { /* best-effort */ }
        logAudit(ctx.supabaseUrl, ctx.serviceKey, { userId: ctx.userId, action: "consent_withdrawn", resourceType: "consent_log", ip: getRequestIp(req), userAgent: req.headers["user-agent"] ?? "" });
        return res.status(200).json({ ok: true });
      }
      const { consentType = "terms_and_privacy", version = "1.0" } = body;
      try {
        await fetch(`${ctx.supabaseUrl}/rest/v1/consent_log`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.serviceKey}`, apikey: ctx.serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: ctx.userId, consent_type: consentType, consent_version: version, ip: getRequestIp(req) || null, user_agent: req.headers["user-agent"] || null }),
        });
      } catch { /* best-effort */ }
      logAudit(ctx.supabaseUrl, ctx.serviceKey, { userId: ctx.userId, action: "consent_given", resourceType: "consent_log", ip: getRequestIp(req), userAgent: req.headers["user-agent"] ?? "", details: `type=${consentType} version=${version}` });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ message: "Method not allowed" });
  } catch (err) {
    console.error("[sphota/consent] Unhandled error:", err);
    return res.status(200).json({ hasConsented: true, _warn: "unhandled_error" });
  }
}

// ── Delete-account handler (original api/delete-account.ts logic) ─────────────
async function handleDeleteAccount(req: any, res: any) {
  if (req.method !== "DELETE") return res.status(405).json({ message: "Method not allowed" });
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ message: "Unauthorized" });
  const env = getSupabaseEnv();
  if (!env) return res.status(500).json({ message: "Server misconfigured" });
  const userId = await verifyToken(token, env.url, env.key);
  if (!userId) return res.status(401).json({ message: "Unauthorized" });
  try {
    logAudit(env.url, env.key, { userId, action: "account_deleted", resourceType: "auth_user", resourceId: userId, ip: getRequestIp(req), userAgent: req.headers["user-agent"] ?? "" });
    const r = await fetch(`${env.url}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.key}`, apikey: env.key },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error(`[sphota/delete-account] Supabase admin delete failed ${r.status}: ${text}`);
      return res.status(500).json({ message: "Failed to delete auth user" });
    }
    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("[sphota/delete-account] Error:", err?.message ?? err);
    return res.status(500).json({ message: "Failed to delete account" });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
export default async function handler(req: any, res: any) {
  if (setCors(req, res)) return;
  const action = String(req.query?.action ?? "consent");
  if (action === "delete-account") return handleDeleteAccount(req, res);
  return handleConsent(req, res);
}
