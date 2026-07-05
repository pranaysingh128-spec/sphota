export const config = { runtime: "nodejs" };
import { z } from "zod";

// ── Self-contained helpers ──────────────────────────────────────────────────
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
interface RateLimitEntry { count: number; windowStart: number; }
const _rlStores = new Map<string, Map<string, RateLimitEntry>>();
function isRateLimited(ns: string, ip: string, limit: number, windowMs: number): boolean {
  if (!_rlStores.has(ns)) _rlStores.set(ns, new Map());
  const store = _rlStores.get(ns)!;
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry || now - entry.windowStart > windowMs) { store.set(ip, { count: 1, windowStart: now }); return false; }
  entry.count += 1;
  return entry.count > limit;
}
function getClientIp(req: any): string {
  return ((req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "") as string).split(",")[0].trim();
}
// ───────────────────────────────────────────────────────────────────────────

const AppointmentSchema = z.object({
  patientId: z.union([z.string().min(1), z.number()]),
  date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  time:      z.string().regex(/^\d{2}:\d{2}$/, "time must be HH:MM"),
  notes:     z.string().max(1000).optional(),
});

export default async function handler(req: any, res: any) {
  if (setCors(req, res)) return;
  if (isRateLimited("receptionist-appt", getClientIp(req), 60, 60000)) return res.status(429).json({ message: "Too many requests" });

  const apptId = req.query?.id && req.query.id !== "_" ? req.query.id : null;

  // Route by method + whether we have an id
  if (req.method === "POST" && !apptId) return handleCreate(req, res);
  if (req.method === "PATCH" && apptId)  return handleReschedule(req, res, apptId);
  if (req.method === "DELETE" && apptId) return handleCancel(req, res, apptId);
  return res.status(405).json({ message: "Method not allowed" });
}

async function getSupabase(req: any, res: any) {
  let url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) { res.status(500).json({ message: "Server not configured" }); return null; }
  if (!url.startsWith("http")) url = "https://" + url;
  return { url, key };
}

async function verifyJwt(url: string, key: string, token: string): Promise<string | null> {
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { "Authorization": `Bearer ${token}`, "apikey": key } });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.id ?? null;
  } catch { return null; }
}

async function getLinkedDoctorId(url: string, key: string, uid: string): Promise<string | null> {
  try {
    const r = await fetch(`${url}/rest/v1/doctors?id=eq.${encodeURIComponent(uid)}&select=linked_doctor_id`, {
      headers: { "Authorization": `Bearer ${key}`, "apikey": key, "Accept": "application/json" },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0]?.linked_doctor_id ?? null;
  } catch { return null; }
}

async function handleCreate(req: any, res: any) {
  const sb = await getSupabase(req, res);
  if (!sb) return;
  const { url, key } = sb;
  try {
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ message: "Unauthorized" });
    const uid = await verifyJwt(url, key, token);
    if (!uid) return res.status(401).json({ message: "Unauthorized" });
    const linkedDoctorId = await getLinkedDoctorId(url, key, uid);
    if (!linkedDoctorId) return res.status(403).json({ message: "Not linked to a doctor" });

    const parsed = AppointmentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    const { patientId, date, time, notes } = parsed.data;

    const r = await fetch(`${url}/rest/v1/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "apikey": key, "Prefer": "return=representation" },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        doctor_id: linkedDoctorId,
        patient_id: parseInt(String(patientId), 10),
        date, time,
        notes: notes?.trim() ?? "",
      }),
    });
    const text = await r.text();
    let data: any; try { data = text ? JSON.parse(text) : []; } catch { data = []; }
    if (!r.ok) return res.status(400).json({ message: data?.message ?? "Failed to add appointment" });
    return res.json(Array.isArray(data) ? data[0] : data);
  } catch (err: any) {
    console.error("[receptionist/appointments POST] error:", err?.message ?? err);
    return res.status(500).json({ message: err?.message ?? "Failed to add appointment" });
  }
}

async function handleReschedule(req: any, res: any, apptId: string) {
  const sb = await getSupabase(req, res);
  if (!sb) return;
  const { url, key } = sb;
  try {
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const uid = await verifyJwt(url, key, token);
    if (!uid) return res.status(401).json({ message: "Unauthorized" });
    const linkedDoctorId = await getLinkedDoctorId(url, key, uid);
    if (!linkedDoctorId) return res.status(403).json({ message: "Not linked to a doctor" });

    const { date, time, notes } = req.body ?? {};
    if (!date || !time) return res.status(400).json({ message: "Date and time are required" });

    const r = await fetch(
      `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(apptId)}&doctor_id=eq.${encodeURIComponent(linkedDoctorId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "apikey": key, "Prefer": "return=minimal" },
        body: JSON.stringify({ date, time, notes: notes?.trim() ?? "" }),
      }
    );
    if (!r.ok) {
      const t = await r.text();
      let parsed: any; try { parsed = JSON.parse(t); } catch { parsed = {}; }
      return res.status(400).json({ message: parsed?.message ?? "Failed to reschedule appointment" });
    }
    logAuditEvent(url, key, { userId: uid, action: "receptionist_reschedule_appointment", resourceType: "appointment", resourceId: String(apptId), ip: getRequestIp(req) });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ message: err?.message ?? "Failed to process request" });
  }
}

async function handleCancel(req: any, res: any, apptId: string) {
  const sb = await getSupabase(req, res);
  if (!sb) return;
  const { url, key } = sb;
  try {
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const uid = await verifyJwt(url, key, token);
    if (!uid) return res.status(401).json({ message: "Unauthorized" });
    const linkedDoctorId = await getLinkedDoctorId(url, key, uid);
    if (!linkedDoctorId) return res.status(403).json({ message: "Not linked to a doctor" });

    const r = await fetch(
      `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(apptId)}&doctor_id=eq.${encodeURIComponent(linkedDoctorId)}`,
      { method: "DELETE", headers: { "Authorization": `Bearer ${key}`, "apikey": key, "Prefer": "return=minimal" } }
    );
    if (!r.ok) {
      const t = await r.text();
      let parsed: any; try { parsed = JSON.parse(t); } catch { parsed = {}; }
      return res.status(400).json({ message: parsed?.message ?? "Failed to cancel appointment" });
    }
    logAuditEvent(url, key, { userId: uid, action: "receptionist_cancel_appointment", resourceType: "appointment", resourceId: String(apptId), ip: getRequestIp(req) });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ message: err?.message ?? "Failed to process request" });
  }
}
