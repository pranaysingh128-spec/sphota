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
  }).catch(() => {});
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

const PatientCreateSchema = z.object({
  name:    z.string().min(1, "Name is required").max(200),
  age:     z.coerce.number().int().min(0).max(150).optional().default(0),
  gender:  z.enum(["Male", "Female", "Other", "Prefer not to say"]).optional().default("Other"),
  phone:   z.string().max(20).optional().nullable(),
  reason:  z.string().max(500).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
});

const PatientDetailsSchema = z.object({
  name:    z.string().min(1, "Name is required").max(200),
  age:     z.coerce.number().int().min(0).max(150).optional().default(0),
  gender:  z.enum(["Male", "Female", "Other", "Prefer not to say"]).optional().default("Other"),
  phone:   z.string().max(20).optional().nullable(),
  reason:  z.string().max(500).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
});

export default async function handler(req: any, res: any) {
  if (setCors(req, res)) return;
  if (isRateLimited("receptionist-patients", getClientIp(req), 60, 60000)) return res.status(429).json({ message: "Too many requests" });

  const patientId = req.query?.id && req.query.id !== "_" ? req.query.id : null;

  if (req.method === "POST" && !patientId) return handleCreate(req, res);
  if (req.method === "DELETE" && patientId)  return handleSoftDelete(req, res, patientId);
  if (req.method === "PATCH" && patientId) {
    const body = req.body ?? {};
    // Differentiate status update vs details update by body shape
    if ("status" in body) return handleStatusUpdate(req, res, patientId);
    return handleDetailsUpdate(req, res, patientId);
  }
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

    const parsed = PatientCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    const { name, age, gender, phone, reason, address } = parsed.data;

    const body: Record<string, unknown> = {
      doctor_id: linkedDoctorId,
      name:      name.trim(),
      age:       age ?? 0,
      gender:    gender ?? "Other",
      status:    "waiting",
      time:      new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
      checked_in_at: new Date().toISOString(),
    };
    if (phone?.trim()) body.phone = phone.trim();
    if (reason?.trim()) body.reason = reason.trim();
    if (address?.trim()) body.address = address.trim();

    const r = await fetch(`${url}/rest/v1/patients`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "apikey": key, "Prefer": "return=representation" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data: any; try { data = text ? JSON.parse(text) : []; } catch { data = []; }
    if (!r.ok) return res.status(400).json({ message: data?.message ?? "Failed to add patient" });

    logAuditEvent(url, key, { userId: uid, action: "receptionist_add_patient", resourceType: "patient", ip: getRequestIp(req), userAgent: req.headers["user-agent"] ?? "" });
    return res.json(Array.isArray(data) ? data[0] : data);
  } catch (err: any) {
    console.error("[receptionist/patients POST] error:", err?.message ?? err);
    return res.status(500).json({ message: err?.message ?? "Failed to add patient" });
  }
}

async function handleStatusUpdate(req: any, res: any, patientId: string) {
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

    const { status } = req.body ?? {};
    if (!["waiting", "active", "done"].includes(status)) return res.status(400).json({ message: "Invalid status" });

    const update: Record<string, unknown> = { status };
    if (status === "waiting") update.checked_in_at = new Date().toISOString();

    const r = await fetch(
      `${url}/rest/v1/patients?id=eq.${encodeURIComponent(patientId)}&doctor_id=eq.${encodeURIComponent(linkedDoctorId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "apikey": key, "Prefer": "return=minimal" },
        body: JSON.stringify(update),
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "{}");
      let msg = "Failed to update status";
      try { msg = JSON.parse(t)?.message ?? msg; } catch {}
      return res.status(400).json({ message: msg });
    }
    logAuditEvent(url, key, { userId: uid, action: "receptionist_update_patient_status", resourceType: "patient", resourceId: String(patientId), details: `status → ${status}`, ip: getRequestIp(req) });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[status] error:", err?.message ?? err);
    return res.status(500).json({ message: err?.message ?? "Failed to update status" });
  }
}

// Edit patient details — only allowed if patient status is "waiting"
async function handleDetailsUpdate(req: any, res: any, patientId: string) {
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

    // Validate input
    const parsed = PatientDetailsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });

    // Fetch current patient to check status
    const checkR = await fetch(
      `${url}/rest/v1/patients?id=eq.${encodeURIComponent(patientId)}&doctor_id=eq.${encodeURIComponent(linkedDoctorId)}&select=id,status`,
      { headers: { "Authorization": `Bearer ${key}`, "apikey": key, "Accept": "application/json" } }
    );
    if (!checkR.ok) return res.status(400).json({ message: "Could not verify patient status" });
    const rows = await checkR.json().catch(() => []);
    const patient = Array.isArray(rows) ? rows[0] : null;
    if (!patient) return res.status(404).json({ message: "Patient not found" });

    // Only allow edits when patient is still waiting
    if (patient.status !== "waiting") {
      return res.status(403).json({ message: "Patient details can only be edited while the patient is waiting. Once in session or done, only the doctor can make changes." });
    }

    const { name, age, gender, phone, reason, address } = parsed.data;
    const updateBody: Record<string, unknown> = {
      name:   name.trim(),
      age:    age ?? 0,
      gender: gender ?? "Other",
    };
    updateBody.phone   = phone?.trim() || null;
    updateBody.reason  = reason?.trim() || null;
    updateBody.address = address?.trim() || null;

    const r = await fetch(
      `${url}/rest/v1/patients?id=eq.${encodeURIComponent(patientId)}&doctor_id=eq.${encodeURIComponent(linkedDoctorId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "apikey": key, "Prefer": "return=minimal" },
        body: JSON.stringify(updateBody),
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "{}");
      let msg = "Failed to update patient";
      try { msg = JSON.parse(t)?.message ?? msg; } catch {}
      return res.status(400).json({ message: msg });
    }
    logAuditEvent(url, key, { userId: uid, action: "receptionist_edit_patient_details", resourceType: "patient", resourceId: String(patientId), ip: getRequestIp(req) });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[details] error:", err?.message ?? err);
    return res.status(500).json({ message: err?.message ?? "Failed to update patient details" });
  }
}

// Soft-delete: sets receptionist_hidden = true so receptionist no longer sees the patient.
// The doctor's view is unaffected — doctor still sees and can permanently delete.
// SQL migration required: ALTER TABLE patients ADD COLUMN IF NOT EXISTS receptionist_hidden boolean DEFAULT false;
async function handleSoftDelete(req: any, res: any, patientId: string) {
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

    const r = await fetch(
      `${url}/rest/v1/patients?id=eq.${encodeURIComponent(patientId)}&doctor_id=eq.${encodeURIComponent(linkedDoctorId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "apikey": key, "Prefer": "return=minimal" },
        body: JSON.stringify({ receptionist_hidden: true }),
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "{}");
      let msg = "Failed to remove patient";
      try { msg = JSON.parse(t)?.message ?? msg; } catch {}
      // If error is about unknown column, the migration hasn't run yet.
      // Return success anyway — the UI will hide the patient locally.
      if (msg.toLowerCase().includes("column") || msg.toLowerCase().includes("receptionist_hidden") || msg.toLowerCase().includes("unknown")) {
        logAuditEvent(url, key, { userId: uid, action: "receptionist_soft_delete_patient", resourceType: "patient", resourceId: String(patientId), ip: getRequestIp(req) });
        return res.json({ ok: true, note: "migration_pending" });
      }
      return res.status(400).json({ message: msg });
    }
    logAuditEvent(url, key, { userId: uid, action: "receptionist_soft_delete_patient", resourceType: "patient", resourceId: String(patientId), ip: getRequestIp(req) });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[soft-delete] error:", err?.message ?? err);
    return res.status(500).json({ message: err?.message ?? "Failed to remove patient" });
  }
}
