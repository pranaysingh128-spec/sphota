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
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (setCors(req, res)) return;
  if (isRateLimited("receptionist", getClientIp(req), 60, 60000)) return res.status(429).json({ message: "Too many requests" });
  if (req.method !== "GET") return res.status(405).json({ message: "Method not allowed" });

  let url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return res.status(500).json({ message: "Server not configured" });
  if (!url.startsWith("http")) url = "https://" + url;

  async function verifyJwt(token: string): Promise<string | null> {
    try {
      const r = await fetch(`${url}/auth/v1/user`, {
        headers: { "Authorization": `Bearer ${token}`, "apikey": key },
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d?.id ?? null;
    } catch { return null; }
  }

  async function sbGet(path: string): Promise<any[]> {
    try {
      const r = await fetch(`${url}/rest/v1/${path}`, {
        headers: { "Authorization": `Bearer ${key}`, "apikey": key, "Accept": "application/json" },
      });
      const text = await r.text().catch(() => "");
      if (!r.ok) { console.warn("[dashboard/sbGet] non-ok", r.status, path, text.slice(0, 200)); return []; }
      try { return text ? JSON.parse(text) : []; } catch { return []; }
    } catch (err: any) {
      console.warn("[dashboard/sbGet] threw", path, err?.message);
      return [];
    }
  }

  // Like sbGet but returns null on non-ok (so caller can detect failure vs empty)
  async function sbGetOrNull(path: string): Promise<any[] | null> {
    try {
      const r = await fetch(`${url}/rest/v1/${path}`, {
        headers: { "Authorization": `Bearer ${key}`, "apikey": key, "Accept": "application/json" },
      });
      const text = await r.text().catch(() => "");
      if (!r.ok) { console.warn("[dashboard/sbGetOrNull] non-ok", r.status, path, text.slice(0, 200)); return null; }
      try { return text ? JSON.parse(text) : []; } catch { return []; }
    } catch (err: any) {
      console.warn("[dashboard/sbGetOrNull] threw", path, err?.message);
      return null;
    }
  }

  try {
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ message: "Unauthorized" });

    const uid = await verifyJwt(token);
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const docRows = await sbGet(`doctors?id=eq.${encodeURIComponent(uid)}&select=linked_doctor_id`);
    const linkedDoctorId = docRows?.[0]?.linked_doctor_id ?? null;

    if (!linkedDoctorId) return res.json({ linkedDoctorId: null, patients: [], appointments: [], visitHistory: [] });

    // Try to fetch patients with receptionist_hidden filter.
    // Falls back to unfiltered if the column doesn't exist yet (migration not yet run).
    const unfilteredPath = `patients?doctor_id=eq.${encodeURIComponent(linkedDoctorId)}&order=created_at.desc&select=id,name,age,gender,status,time,checked_in_at,created_at,phone,reason,address`;
    const filteredPath   = `patients?doctor_id=eq.${encodeURIComponent(linkedDoctorId)}&receptionist_hidden=not.eq.true&order=created_at.desc&select=id,name,age,gender,status,time,checked_in_at,created_at,phone,reason,address`;

    let patients: any[] | null = await sbGetOrNull(filteredPath);
    // null means the request failed (column likely doesn't exist) — fall back to unfiltered
    if (patients === null) {
      patients = await sbGet(unfilteredPath);
    }

    const [appointments, visitHistory] = await Promise.all([
      sbGet(`appointments?doctor_id=eq.${encodeURIComponent(linkedDoctorId)}&order=date.asc&select=id,patient_id,date,time,notes`),
      // Fetch report_entries dates for visit history — no clinical content, just dates
      sbGet(`report_entries?doctor_id=eq.${encodeURIComponent(linkedDoctorId)}&select=patient_id,date&order=date.desc`),
    ]);

    return res.json({ linkedDoctorId, patients, appointments, visitHistory });
  } catch (err: any) {
    console.error("[dashboard] Unhandled error:", err?.message ?? err);
    return res.status(500).json({ message: err?.message ?? "Failed to load dashboard. Please refresh." });
  }
}
