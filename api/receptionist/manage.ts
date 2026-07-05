export const config = { runtime: "nodejs" };

// ── Self-contained helpers (no ../_shared import — Vercel can't resolve it from subfolders) ──
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

interface RateLimitEntry { count: number; windowStart: number; }
const stores = new Map<string, Map<string, RateLimitEntry>>();
function isRateLimited(namespace: string, ip: string, limit: number, windowMs: number): boolean {
  if (!stores.has(namespace)) stores.set(namespace, new Map());
  const store = stores.get(namespace)!;
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry || now - entry.windowStart > windowMs) { store.set(ip, { count: 1, windowStart: now }); return false; }
  entry.count += 1;
  return entry.count > limit;
}
function getClientIp(req: any): string {
  return ((req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "") as string).split(",")[0].trim();
}
function logAuditEvent(supabaseUrl: string, serviceKey: string, event: any): void {
  fetch(`${supabaseUrl}/rest/v1/audit_logs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: event.userId, action: event.action, resource_type: event.resourceType ?? null, resource_id: event.resourceId ?? null, ip: event.ip ?? null, user_agent: event.userAgent ?? null, details: event.details ?? null }),
  }).catch((err) => console.warn("[sphota/audit] Failed:", err?.message ?? err));
}
function getRequestIp(req: any): string {
  return ((req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "") as string).split(",")[0].trim();
}
// ─────────────────────────────────────────────────────────────────────────────

async function getSupabaseCtx(req: any, res: any): Promise<{ url: string; key: string; uid: string } | null> {
  let url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) { res.status(500).json({ message: "Server not configured" }); return null; }
  if (!url.startsWith("http")) url = "https://" + url;

  const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
  if (!token) { res.status(401).json({ message: "Unauthorized" }); return null; }

  try {
    const authRes = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: key },
    });
    if (!authRes.ok) { res.status(401).json({ message: "Unauthorized" }); return null; }
    const authUser = await authRes.json() as { id?: string };
    const uid = authUser.id ?? "";
    if (!uid) { res.status(401).json({ message: "Unauthorized" }); return null; }
    return { url, key, uid };
  } catch { res.status(401).json({ message: "Unauthorized" }); return null; }
}

export default async function handler(req: any, res: any) {
  if (setCors(req, res)) return;
  if (isRateLimited("receptionist-manage", getClientIp(req), 60, 60000)) return res.status(429).json({ message: "Too many requests" });

  // ── GET: list receptionists linked to the authenticated doctor ──────────────
  if (req.method === "GET") {
    const ctx = await getSupabaseCtx(req, res);
    if (!ctx) return;
    const { url, key, uid } = ctx;

    async function sbGet(path: string) {
      try {
        const r = await fetch(`${url}/rest/v1/${path}`, {
          headers: { Authorization: `Bearer ${key}`, apikey: key, Accept: "application/json" },
        });
        const text = await r.text().catch(() => "");
        return { ok: r.ok, data: text ? (() => { try { return JSON.parse(text); } catch { return []; } })() : [] };
      } catch (err: any) {
        return { ok: false, data: [] };
      }
    }

    try {
      const rows = await sbGet(
        `doctors?role=eq.receptionist&linked_doctor_id=eq.${encodeURIComponent(uid)}&select=id,name`
      );

      // Fallback: check used invites if no doctors rows found
      // DB schema: receptionist_invites has columns: id, doctor_user_id, email, used (boolean), created_at
      if (!rows.ok || !Array.isArray(rows.data) || rows.data.length === 0) {
        const inviteRows = await sbGet(
          `receptionist_invites?doctor_user_id=eq.${encodeURIComponent(uid)}&used=eq.true&select=id,email&order=created_at.desc`
        );
        if (inviteRows.ok && Array.isArray(inviteRows.data) && inviteRows.data.length > 0) {
          return res.json(inviteRows.data.map((inv: any) => ({
            id: inv.id,
            name: inv.email?.split("@")[0] ?? "Receptionist",
            email: inv.email ?? "",
          })));
        }
        return res.json([]);
      }

      const result = await Promise.all(
        rows.data.map(async (r: any) => {
          let emailAddr = "";
          try {
            const authRes = await fetch(`${url}/auth/v1/admin/users/${r.id}`, {
              headers: { Authorization: `Bearer ${key}`, apikey: key },
            });
            if (authRes.ok) {
              const u = await authRes.json();
              emailAddr = u?.email ?? "";
            }
          } catch { /* fall through */ }

          if (!emailAddr) {
            const inviteRes = await sbGet(
              `receptionist_invites?doctor_user_id=eq.${encodeURIComponent(uid)}&used=eq.true&select=email&limit=1`
            );
            if (inviteRes.ok && Array.isArray(inviteRes.data) && inviteRes.data[0]) {
              emailAddr = inviteRes.data[0].email ?? "";
            }
          }
          return { id: r.id, name: r.name ?? "", email: emailAddr };
        })
      );
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ message: err?.message ?? "Failed to load receptionist list" });
    }
  }

  // ── DELETE: unlink/remove a receptionist ────────────────────────────────────
  if (req.method === "DELETE") {
    const ctx = await getSupabaseCtx(req, res);
    if (!ctx) return;
    const { url, key, uid } = ctx;

    const receptionistId = req.query?.id as string;
    if (!receptionistId) return res.status(400).json({ message: "Missing receptionist id" });

    try {
      // Path A: ID is a doctors row UUID (normal case — receptionist completed signup)
      const checkRes = await fetch(
        `${url}/rest/v1/doctors?id=eq.${encodeURIComponent(receptionistId)}&linked_doctor_id=eq.${encodeURIComponent(uid)}&role=eq.receptionist&select=id`,
        { headers: { Authorization: `Bearer ${key}`, apikey: key, Accept: "application/json" } }
      );
      const checkData = checkRes.ok ? await checkRes.json().catch(() => []) : [];

      if (Array.isArray(checkData) && checkData.length > 0) {
        // Found a real doctors row — unlink it and mark as removed so login is blocked
        await fetch(`${url}/rest/v1/doctors?id=eq.${encodeURIComponent(receptionistId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key, Prefer: "return=minimal" },
          body: JSON.stringify({ linked_doctor_id: null, role: "receptionist_removed" }),
        });
        logAuditEvent(url, key, { userId: uid, action: "doctor_removed_receptionist", resourceType: "receptionist", resourceId: receptionistId, ip: getRequestIp(req) });
        return res.json({ ok: true });
      }

      // Path B: ID is a receptionist_invites UUID (fallback — shown via invite row when doctors row missing)
      const inviteRes = await fetch(
        `${url}/rest/v1/receptionist_invites?id=eq.${encodeURIComponent(receptionistId)}&doctor_user_id=eq.${encodeURIComponent(uid)}&select=id,email`,
        { headers: { Authorization: `Bearer ${key}`, apikey: key, Accept: "application/json" } }
      );
      const inviteData = inviteRes.ok ? await inviteRes.json().catch(() => []) : [];

      if (Array.isArray(inviteData) && inviteData.length > 0) {
        const invite = inviteData[0];

        // Delete the invite row so it no longer appears in the linked receptionist list
        await fetch(`${url}/rest/v1/receptionist_invites?id=eq.${encodeURIComponent(receptionistId)}&doctor_user_id=eq.${encodeURIComponent(uid)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${key}`, apikey: key, Prefer: "return=minimal" },
        });

        // Also unlink any doctors row that matched this email, if it exists
        if (invite.email) {
          const usersRes = await fetch(`${url}/auth/v1/admin/users?email=${encodeURIComponent(invite.email)}`, {
            headers: { Authorization: `Bearer ${key}`, apikey: key },
          });
          if (usersRes.ok) {
            const usersData = await usersRes.json().catch(() => null);
            const recpUserId = usersData?.users?.[0]?.id ?? usersData?.id ?? null;
            if (recpUserId) {
              await fetch(`${url}/rest/v1/doctors?id=eq.${encodeURIComponent(recpUserId)}&linked_doctor_id=eq.${encodeURIComponent(uid)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key, Prefer: "return=minimal" },
                body: JSON.stringify({ linked_doctor_id: null, role: "receptionist_removed" }),
              });
            }
          }
        }

        logAuditEvent(url, key, { userId: uid, action: "doctor_revoked_receptionist_invite", resourceType: "receptionist_invite", resourceId: receptionistId, ip: getRequestIp(req) });
        return res.json({ ok: true });
      }

      // Neither path found anything owned by this doctor
      return res.status(404).json({ message: "Receptionist not found or not linked to your account" });

    } catch (err: any) {
      return res.status(500).json({ message: err?.message ?? "Failed to remove receptionist" });
    }
  }

  return res.status(405).json({ message: "Method not allowed" });
}
