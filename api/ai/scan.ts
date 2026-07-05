// IMPORTANT: Do NOT add `runtime: "nodejs"` — it is not a valid Pages API config key
// and causes Vercel to silently misconfigure the function, making bodyParser: false
// ineffective (the body gets consumed before multer can parse it).
export const config = { api: { bodyParser: false } };

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
function getSupabaseEnv(): { url: string; key: string } | null {
  let url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url) { console.error("[auth] Missing SUPABASE_URL"); return null; }
  if (!key) { console.error("[auth] Missing SUPABASE_SERVICE_ROLE_KEY"); return null; }
  if (!url.startsWith("http")) url = "https://" + url;
  return { url, key };
}
async function verifySupabaseToken(token: string, supabaseUrl: string, serviceKey: string): Promise<string | null> {
  if (!token) return null;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? serviceKey;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: anonKey } });
    if (!res.ok) return null;
    const user = await res.json() as { id?: string };
    return user?.id ?? null;
  } catch { return null; }
}
async function getDoctorPlan(supabaseUrl: string, serviceKey: string, userId: string): Promise<string> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/doctors?id=eq.${encodeURIComponent(userId)}&select=plan,plan_expires_at`,
      { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } }
    );
    if (!res.ok) return "free";
    const rows = await res.json() as { plan?: string; plan_expires_at?: string | null }[];
    const row = rows?.[0];
    if (!row) return "free";
    const plan = row.plan ?? "free";
    const expiresAt = row.plan_expires_at ? new Date(row.plan_expires_at) : null;
    if (expiresAt && expiresAt <= new Date() && plan !== "free" && plan !== "unlimited") return "free";
    return plan;
  } catch { return "free"; }
}
async function checkRateLimit(supabaseUrl: string, serviceKey: string, userId: string, endpoint: string, plan?: string): Promise<{ limited: boolean; remaining: number }> {
  const MONTHLY_LIMITS: Record<string, number> = { chat: 30, transcribe: 50, scan: 20 };
  const limit = MONTHLY_LIMITS[endpoint] ?? 30;
  // Unlimited/clinical/premium plans bypass all rate limits
  const UNLIMITED_PLANS = ["unlimited", "clinical", "premium"];
  if (plan && UNLIMITED_PLANS.includes(plan)) return { limited: false, remaining: 99999 };
  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_ai_usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
      body: JSON.stringify({ p_user_id: userId, p_endpoint: endpoint, p_window_start: windowStart.toISOString() }),
    });
    if (!res.ok) { console.warn(`increment_ai_usage RPC failed (${res.status}) — allowing`); return { limited: false, remaining: limit }; }
    const count: number = await res.json();
    return { limited: count > limit, remaining: Math.max(0, limit - count) };
  } catch { console.warn("increment_ai_usage threw — allowing"); return { limited: false, remaining: limit }; }
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
import multer from "multer";

const ALLOWED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
];

function detectImageMagicBytes(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WebP: RIFF????WEBP  (bytes 0-3: 52 49 46 46, bytes 8-11: 57 45 42 50)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

const VISION_PROMPT = `You are an expert AI assistant for a clinical psychiatrist with 15+ years of experience. 
You are analyzing a photograph of a handwritten or printed old patient medical record, 
clinical note, prescription, or psychiatric report.

Your task is to extract all clinically relevant information from the document image and 
restructure it into a clean, standardized clinical summary. Even if the document is 
partially legible, extract as much as possible.

Output Structure — follow this exactly:

### SCANNED DOCUMENT SUMMARY

**Document Type:** [e.g., Previous psychiatric note / Prescription / Discharge summary / Lab report / Other]
**Approximate Date:** [If visible, else: "Not legible"]
**Source/Provider:** [Clinic/hospital name or doctor name if visible, else: "Not documented"]

---

### QUICK SCAN
- **Diagnosis/Impression:** [extracted diagnosis or clinical impression]
- **Key Symptoms Noted:** [list symptoms mentioned in the document]
- **Immediate Action Plan:**
  - Medications: [medications documented, or "Not indicated"]
  - Safety/Risk Management: [any risk or safety notes, or "Not indicated"]
  - Therapy/Psychosocial: [any therapy or psychosocial notes, or "Not indicated"]
  - Labs/Medical Workup: [any investigations mentioned, or "Not indicated"]
  - Follow-up: [any follow-up instructions, or "Not indicated"]
- **Significant History:** [any relevant past history, hospitalizations, events]
- **Risk Factors Mentioned:** [suicidality, violence, substance use if noted, or "None documented"]

IMPORTANT: The Immediate Action Plan MUST always list all 5 domains above in exactly that order. Never skip a domain — write "Not indicated" if not applicable. Never add extra domains or reorder.

---

### EXTRACTED CLINICAL DETAILS

**Presenting Complaints (from document):**
[bullet points]

**Mental Status (if documented):**
[bullet points, or "Not documented"]

**Medications & Dosages:**
[bullet points with drug name, dose, frequency, duration if available]

**Investigations/Labs (if mentioned):**
[bullet points, or "Not documented"]

**Previous Diagnoses (ICD/DSM if mentioned):**
[bullet points]

**Provider Notes/Instructions:**
[any specific notes, follow-up plans, or instructions visible]

---

### LEGIBILITY NOTES
- **Overall legibility:** [Good / Moderate / Poor]
- **Sections unclear or unreadable:** [list what could not be extracted, if any]
- **Confidence level:** [High / Medium / Low] — based on how much was successfully extracted

---

**IMPORTANT RULES:**
- Never invent or hallucinate clinical data. If text is unclear, write "Illegible" for that field.
- Do not add clinical opinions or recommendations — only extract what is documented.
- If the image does not appear to be a medical document, respond with: 
  "This does not appear to be a medical document. Please photograph a patient file, 
  prescription, clinical note, or medical report."
- Maintain professional psychiatric terminology for extracted content.
- If a medication name is partially legible, write your best interpretation followed by "(?)"`;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function runMulter(req: any, res: any): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single("image")(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export default async function handler(req: any, res: any) {
  if (setCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

  // ── Auth ─────────────────────────────────────────────────────────────────
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  const env = getSupabaseEnv();
  if (!env) return res.status(500).json({ message: "Server misconfigured" });

  const userId = await verifySupabaseToken(token, env.url, env.key);
  if (!userId) return res.status(401).json({ message: "Unauthorized" });

  // ── Rate limit — check doctor plan first; unlimited/clinical/premium bypass caps ──
  const doctorPlan = await getDoctorPlan(env.url, env.key, userId);
  const { limited } = await checkRateLimit(env.url, env.key, userId, "scan", doctorPlan);
  if (limited) {
    return res.status(429).json({
      message: "Monthly AI usage limit reached. Your limit resets on the 1st of next month.",
      retryAfter: "2592000",
    });
  }

  // ── Parse multipart body ─────────────────────────────────────────────────
  try {
    await runMulter(req, res);
  } catch {
    return res.status(400).json({ message: "Could not parse image upload" });
  }

  const file: Express.Multer.File | undefined = (req as any).file;
  if (!file || !file.buffer || file.buffer.length === 0) {
    return res.status(400).json({ message: "Image file required" });
  }

  // ── MIME validation ──────────────────────────────────────────────────────
  const imageMime = (file.mimetype || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.includes(imageMime)) {
    return res.status(400).json({
      message: "Only image files are accepted (JPEG, PNG, WebP, GIF, HEIC)",
    });
  }

  // Magic byte validation — verify actual file content matches claimed type
  if (!detectImageMagicBytes(file.buffer)) {
    return res.status(400).json({
      message: "File content does not match an accepted image format (JPEG, PNG, WebP, GIF).",
    });
  }

  const imageBuffer = file.buffer;
  const scanStartMs = Date.now();

  // Audit: log document scan event
  logAuditEvent(env.url, env.key, {
    userId,
    action: "ai_scan",
    resourceType: "document_image",
    ip: getRequestIp(req),
    userAgent: req.headers["user-agent"] ?? "",
    details: { bytes: imageBuffer.length, mime: imageMime },
  });
  const base64Image = imageBuffer.toString("base64");

  // Sanitise optional context fields
  const body = req.body ?? {};
  const patientAge    = String(body.patientAge    ?? "").slice(0, 20);
  const patientGender = String(body.patientGender ?? "").slice(0, 40);

  // [DPDP COMPLIANCE] Patient name intentionally excluded from AI context.
  const contextNote = [
    patientAge    && `Patient age: ${patientAge}`,
    patientGender && `Patient gender: ${patientGender}`,
  ].filter(Boolean).join(", ");

  const userPrompt = contextNote
    ? `Please analyze this medical document image. Context: ${contextNote}.`
    : "Please analyze this medical document image.";

  // Document scan uses the report key pool (GEMINI_REPORT_1..7, Keys 9–15),
  // falling back to GEMINI_API_KEY for legacy deployments.
  const scanKeys: string[] = [
    process.env.GEMINI_REPORT_1 ?? process.env.GEMINI_API_KEY ?? "",
    process.env.GEMINI_REPORT_2 ?? "",
    process.env.GEMINI_REPORT_3 ?? "",
    process.env.GEMINI_REPORT_4 ?? "",
    process.env.GEMINI_REPORT_5 ?? "",
    process.env.GEMINI_REPORT_6 ?? "",
    process.env.GEMINI_REPORT_7 ?? "",
  ].filter(Boolean);
  const aiFallback1Key = process.env.GROQ_API_KEY ?? "";
  const aiFallback2Key = process.env.OPENAI_API_KEY ?? "";

  // 1 ── Primary AI: try each Gemini report key in order ─────────────────────
  for (const [idx, scanKey] of scanKeys.entries()) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${scanKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: VISION_PROMPT }] },
            contents: [
              {
                role: "user",
                parts: [
                  { inline_data: { mime_type: imageMime, data: base64Image } },
                  { text: userPrompt },
                ],
              },
            ],
            generationConfig: { maxOutputTokens: 2048 },
          }),
        }
      );
      if (r.ok) {
        const data = await r.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const summary = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (summary) {
          logAuditEvent(env.url, env.key, { userId, action: "scan_succeeded", resourceType: "document_image", ip: getRequestIp(req), details: { provider: "gemini", model: "gemini-2.5-flash", key_label: `GEMINI_REPORT_${idx + 1}`, bytes: imageBuffer.length, mime: imageMime, summary_chars: summary.length, duration_ms: Date.now() - scanStartMs } });
          return res.json({ summary });
        }
      } else {
        console.warn(`[scan] GEMINI_REPORT_${idx + 1} HTTP ${r.status} — trying next`);
      }
    } catch (e1) { console.warn(`[scan] GEMINI_REPORT_${idx + 1} failed:`, e1 instanceof Error ? e1.message : e1); }
  }

  // 2 ── Fallback AI 1 ────────────────────────────────────────────────────────
  if (aiFallback1Key) {
    try {
      const dataUrl = `data:${imageMime};base64,${base64Image}`;
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${aiFallback1Key}` },
        body: JSON.stringify({
          model: "meta-llama/llama-4-maverick-17b-128e-instruct",
          max_tokens: 2048,
          messages: [
            { role: "system", content: VISION_PROMPT },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: dataUrl } },
                { type: "text", text: userPrompt },
              ],
            },
          ],
        }),
      });
      if (r.ok) {
        const data = await r.json() as { choices?: { message?: { content?: string } }[] };
        const summary = data.choices?.[0]?.message?.content ?? "";
        if (summary) {
          logAuditEvent(env.url, env.key, { userId, action: "scan_succeeded", resourceType: "document_image", ip: getRequestIp(req), details: { provider: "groq", model: "llama-4-maverick-17b", bytes: imageBuffer.length, mime: imageMime, summary_chars: summary.length, duration_ms: Date.now() - scanStartMs } });
          return res.json({ summary });
        }
      } else {
        const errText = await r.text().catch(() => "");
        console.warn("[scan] Groq fallback failed:", r.status, errText.slice(0, 200));
      }
    } catch (e2) { console.warn("[scan] Groq fallback threw:", e2 instanceof Error ? e2.message : e2); }
  }

  // 3 ── Fallback AI 2 ────────────────────────────────────────────────────────
  if (aiFallback2Key) {
    try {
      const dataUrl = `data:${imageMime};base64,${base64Image}`;
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${aiFallback2Key}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 2048,
          messages: [
            { role: "system", content: VISION_PROMPT },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: dataUrl } },
                { type: "text", text: userPrompt },
              ],
            },
          ],
        }),
      });
      if (r.ok) {
        const data = await r.json() as { choices?: { message?: { content?: string } }[] };
        const summary = data.choices?.[0]?.message?.content ?? "";
        if (summary) {
          logAuditEvent(env.url, env.key, { userId, action: "scan_succeeded", resourceType: "document_image", ip: getRequestIp(req), details: { provider: "openai", model: "gpt-4o-mini", bytes: imageBuffer.length, mime: imageMime, summary_chars: summary.length, duration_ms: Date.now() - scanStartMs } });
          return res.json({ summary });
        }
      } else {
        const errText = await r.text().catch(() => "");
        console.warn("[scan] OpenAI fallback failed:", r.status, errText.slice(0, 200));
      }
    } catch (e3) { console.warn("[scan] OpenAI fallback threw:", e3 instanceof Error ? e3.message : e3); }
  }

  console.error("[scan] All AI providers exhausted — returning 503");
  logAuditEvent(env.url, env.key, { userId, action: "scan_failed", resourceType: "document_image", ip: getRequestIp(req), details: { bytes: imageBuffer.length, mime: imageMime, duration_ms: Date.now() - scanStartMs, providers_tried: [`gemini×${scanKeys.length}`, aiFallback1Key ? "groq" : null, aiFallback2Key ? "openai" : null].filter(Boolean) } });
  return res.status(503).json({ message: "Document scanning unavailable. Please try again later." });
}
