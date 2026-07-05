export const config = { runtime: "nodejs" };

// Single dynamic route for all Command Log operations (owner-only).
// All helpers are INLINED — no _shared import (Vercel ESM cannot reliably
// resolve sibling files from a subdirectory at runtime).
//
// Dispatches on the URL segment captured as req.query.action:
//   GET  /api/command-log/entries        list entries
//   POST /api/command-log/entry          save + AI-classify
//   PATCH /api/command-log/update-entry  inline edit
//   GET  /api/command-log/snapshot       admin stats
//   GET  /api/command-log/gmail-auth     start OAuth URL
//   GET  /api/command-log/gmail-callback OAuth callback (redirect)
//   GET  /api/command-log/gmail-emails   fetch inbox

import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ── Inlined helpers ───────────────────────────────────────────────────────────
function setCors(req: any, res: any): boolean {
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

function getSupabaseEnv(): { url: string; key: string } | null {
  let url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url) { console.error("[cl] Missing SUPABASE_URL"); return null; }
  if (!key) { console.error("[cl] Missing SUPABASE_SERVICE_ROLE_KEY"); return null; }
  if (!url.startsWith("http")) url = "https://" + url;
  return { url, key };
}

async function verifyToken(token: string, url: string, key: string): Promise<string | null> {
  if (!token) return null;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? key;
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
    if (!r.ok) return null;
    const u = await r.json() as { id?: string };
    return u?.id ?? null;
  } catch { return null; }
}

// ── Env constants ─────────────────────────────────────────────────────────────
const OWNER_ID      = process.env.OWNER_DOCTOR_ID      ?? "";
const CLIENT_ID     = process.env.GMAIL_CLIENT_ID      ?? "";
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET  ?? "";
const REDIRECT_URI  = process.env.GMAIL_REDIRECT_URI   ?? "";
const APP_BASE      = (process.env.APP_BASE_URL        ?? "").replace(/\/$/, "");
const ENC_KEY_HEX   = process.env.FIELD_ENCRYPTION_KEY ?? "";

// ── Encryption ────────────────────────────────────────────────────────────────
function encKey(): Buffer {
  if (ENC_KEY_HEX.length >= 64) return Buffer.from(ENC_KEY_HEX.slice(0, 64), "hex");
  const raw = Buffer.from(ENC_KEY_HEX || "fallback-32-byte-key-for-dev-only!!!");
  const pad = Buffer.alloc(32); raw.copy(pad); return pad;
}
function encrypt(plain: string): { enc: string; iv: string; tag: string } {
  const iv  = randomBytes(12);
  const c   = createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { enc: enc.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
function decrypt(enc: string, iv: string, tag: string): string {
  const d = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return d.update(enc, "base64", "utf8") + d.final("utf8");
}

// ── Separate Gemini keys (never shared with clinical AI) ──────────────────────
const ADMIN_KEYS = [
  process.env.GEMINI_ADMIN_1 ?? "",
  process.env.GEMINI_ADMIN_2 ?? "",
  process.env.GEMINI_ADMIN_3 ?? "",
].filter(Boolean);

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function callAdminGemini(prompt: string): Promise<string | null> {
  for (const key of ADMIN_KEYS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
            }),
          }
        );
        if (!res.ok) { if (res.status === 429 || res.status >= 500) { await sleep(1200); continue; } break; }
        const j = await res.json() as any;
        const text: string = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (text) return text;
      } catch { await sleep(600); }
    }
  }
  return null;
}

function buildAIPrompt(raw: string): string {
  return `You are a personal notes organizer for a doctor-founder building a medical SaaS.
Classify the following note into exactly one category and extract structured fields.
Return ONLY valid JSON with no markdown fences.

Note: """
${raw.slice(0, 4000)}
"""

Categories and their fields:
- "doctor": { "name": string, "city": string|null, "contact_method": "email"|"LinkedIn"|"Reddit"|"referral"|"other"|null, "summary": string, "stage": "contacted"|"replied"|"signed-up"|"tried-app"|"gave-feedback"|"ghosted", "follow_up_needed": boolean, "follow_up_what": string|null }
  Default stage to "contacted" if unclear.
- "build": { "what_changed": string, "deployed": boolean, "verified_working": boolean }
  Set verified_working=false if note says "still broken", "not fixed", "failed", etc.
- "learning": { "topic": string, "day_number": number|null, "completed": boolean }
- "note": { "title": string, "content": string }

Also include: "category": "doctor"|"build"|"learning"|"note"
If category is "doctor", also include: "doctor_name_normalized": string (lowercase trimmed name only, no titles)

Respond with a single JSON object only.`;
}

// ── Owner-auth helper ─────────────────────────────────────────────────────────
async function ownerAuth(req: any): Promise<{ sb: any } | null> {
  const env = getSupabaseEnv();
  if (!env || !OWNER_ID) return null;
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  const userId = await verifyToken(token, env.url, env.key);
  if (!userId || userId !== OWNER_ID) return null;
  const sb = createClient(env.url, env.key, { auth: { persistSession: false } });
  return { sb };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleEntries(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const ctx = await ownerAuth(req);
  if (!ctx) return res.status(404).json({ error: "Not found" });
  const { data, error } = await ctx.sb
    .from("command_log_entries").select("*")
    .eq("doctor_id", OWNER_ID).order("created_at", { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ entries: data ?? [] });
}

async function handleEntry(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const ctx = await ownerAuth(req);
  if (!ctx) return res.status(404).json({ error: "Not found" });
  const { raw_input } = req.body ?? {};
  if (!raw_input || typeof raw_input !== "string" || !raw_input.trim())
    return res.status(400).json({ error: "raw_input required" });

  const { data: row, error: insertErr } = await ctx.sb
    .from("command_log_entries")
    .insert({ doctor_id: OWNER_ID, raw_input: raw_input.trim(), category: null, status: "pending" })
    .select("id").single();
  if (insertErr || !row) return res.status(500).json({ error: insertErr?.message ?? "Insert failed" });

  const entryId: string = row.id;
  let aiError: string | null = null;
  try {
    const aiRaw = await callAdminGemini(buildAIPrompt(raw_input));
    if (!aiRaw) throw new Error("All admin AI keys exhausted");
    let parsed: any;
    try { parsed = JSON.parse(aiRaw); } catch { throw new Error("AI returned invalid JSON"); }
    const category = parsed.category as string;
    const normalized = category === "doctor" ? (parsed.doctor_name_normalized ?? null) : null;
    const { category: _c, doctor_name_normalized: _n, ...structuredFields } = parsed;
    await ctx.sb.from("command_log_entries").update({
      category: ["doctor","build","learning","note"].includes(category) ? category : "note",
      structured_data: structuredFields,
      doctor_name_normalized: normalized,
      status: null,
    }).eq("id", entryId);
  } catch (e: any) {
    aiError = e?.message ?? "AI classification failed";
    await ctx.sb.from("command_log_entries").update({ category: "note", status: "ai_failed" }).eq("id", entryId);
  }

  const { data: final } = await ctx.sb.from("command_log_entries").select("*").eq("id", entryId).single();
  return res.status(200).json({ entry: final, aiError });
}

async function handleUpdateEntry(req: any, res: any) {
  if (req.method !== "PATCH") return res.status(405).json({ error: "Method not allowed" });
  const ctx = await ownerAuth(req);
  if (!ctx) return res.status(404).json({ error: "Not found" });
  const { id, category, structured_data, status, doctor_name_normalized } = req.body ?? {};
  if (!id) return res.status(400).json({ error: "id required" });
  const patch: Record<string, any> = {};
  if (category          !== undefined) patch.category = category;
  if (structured_data   !== undefined) patch.structured_data = structured_data;
  if (status            !== undefined) patch.status = status;
  if (doctor_name_normalized !== undefined) patch.doctor_name_normalized = doctor_name_normalized;
  if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });
  const { data, error } = await ctx.sb
    .from("command_log_entries").update(patch)
    .eq("id", id).eq("doctor_id", OWNER_ID).select("*").single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ entry: data });
}

async function handleSnapshot(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const ctx = await ownerAuth(req);
  if (!ctx) return res.status(404).json({ error: "Not found" });
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [signupsRes, activeRes, usageRes] = await Promise.all([
    ctx.sb.from("doctors").select("id", { count: "exact", head: true }),
    ctx.sb.from("report_entries").select("doctor_id", { count: "exact", head: true }).gte("created_at", weekAgo),
    ctx.sb.from("report_usage").select("count"),
  ]);
  const totalReportsGenerated = ((usageRes.data ?? []) as any[]).reduce((s: number, r: any) => s + (r.count ?? 0), 0);
  return res.status(200).json({
    totalSignups:          signupsRes.count  ?? 0,
    totalReportsGenerated,
    activeThisWeek:        activeRes.count   ?? 0,
  });
}

async function handleGmailAuth(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const env = getSupabaseEnv();
  if (!env || !OWNER_ID) return res.status(404).json({ error: "Not found" });
  if (!CLIENT_ID || !REDIRECT_URI) return res.status(500).json({ error: "Gmail OAuth not configured" });
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  const userId = await verifyToken(token, env.url, env.key);
  if (!userId || userId !== OWNER_ID) return res.status(404).json({ error: "Not found" });
  const state = Buffer.from(token).toString("base64url");
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline", prompt: "consent", state,
  });
  return res.status(200).json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
}

async function handleGmailCallback(req: any, res: any) {
  const fail = `${APP_BASE}/xlog?gmail_error=oauth_failed`;
  if (req.method !== "GET") return res.redirect(302, fail);
  const { code, state, error: oauthError } = req.query as Record<string, string>;
  if (oauthError || !code || !state) return res.redirect(302, fail);
  const env = getSupabaseEnv();
  if (!env || !OWNER_ID || !CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) return res.redirect(302, fail);
  let jwt = "";
  try { jwt = Buffer.from(state, "base64url").toString("utf8"); } catch { return res.redirect(302, fail); }
  const userId = await verifyToken(jwt, env.url, env.key);
  if (!userId || userId !== OWNER_ID) return res.redirect(302, fail);
  try {
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }).toString(),
    });
    if (!tr.ok) return res.redirect(302, fail);
    const tj = await tr.json() as any;
    if (!tj.refresh_token) return res.redirect(302, `${APP_BASE}/xlog?gmail_error=no_refresh_token`);
    const { enc, iv, tag } = encrypt(tj.refresh_token);
    const sb = createClient(env.url, env.key, { auth: { persistSession: false } });
    const { error: ue } = await sb.from("gmail_tokens").upsert(
      { doctor_id: OWNER_ID, enc_token: enc, enc_iv: iv, enc_tag: tag, updated_at: new Date().toISOString() },
      { onConflict: "doctor_id" }
    );
    if (ue) return res.redirect(302, `${APP_BASE}/xlog?gmail_error=store_failed`);
    return res.redirect(302, `${APP_BASE}/xlog?gmail_connected=1`);
  } catch { return res.redirect(302, fail); }
}

async function handleGmailEmails(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const env = getSupabaseEnv();
  if (!env || !OWNER_ID || !CLIENT_ID || !CLIENT_SECRET) return res.status(404).json({ error: "Not found" });
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  const userId = await verifyToken(token, env.url, env.key);
  if (!userId || userId !== OWNER_ID) return res.status(404).json({ error: "Not found" });
  const sb = createClient(env.url, env.key, { auth: { persistSession: false } });
  const { data: tr, error: te } = await sb.from("gmail_tokens").select("enc_token,enc_iv,enc_tag").eq("doctor_id", OWNER_ID).single();
  if (te || !tr) return res.status(200).json({ connected: false });
  let refreshToken: string;
  try { refreshToken = decrypt(tr.enc_token, tr.enc_iv, tr.enc_tag); }
  catch { return res.status(200).json({ connected: false, error: "token_decrypt_failed" }); }
  let accessToken: string;
  try {
    const ar = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
    });
    if (!ar.ok) throw new Error("refresh_failed");
    const aj = await ar.json() as any;
    if (!aj.access_token) throw new Error("no_access_token");
    accessToken = aj.access_token;
  } catch { return res.status(200).json({ connected: true, expired: true }); }
  try {
    const q = String(req.query.q ?? "");
    const lp = new URLSearchParams({ maxResults: "50", q: q || "in:inbox" });
    const lr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${lp}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!lr.ok) throw new Error("list_failed");
    const lj = await lr.json() as any;
    const ids: { id: string }[] = lj.messages ?? [];
    const details = await Promise.all(ids.slice(0, 50).map(async (m) => {
      try {
        const r = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!r.ok) return null;
        const d = await r.json() as any;
        const hdr: { name: string; value: string }[] = d?.payload?.headers ?? [];
        const get = (n: string) => hdr.find(h => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
        return { id: m.id, sender: get("From"), subject: get("Subject"), snippet: d.snippet ?? "", receivedAt: get("Date") };
      } catch { return null; }
    }));
    return res.status(200).json({ connected: true, expired: false, emails: details.filter(Boolean) });
  } catch { return res.status(200).json({ connected: true, expired: false, emails: [], error: "fetch_failed" }); }
}

// ── Main router ───────────────────────────────────────────────────────────────
export default async function handler(req: any, res: any) {
  const action = String(req.query?.action ?? "");
  // Gmail callback is a browser redirect — no CORS headers needed
  if (action !== "gmail-callback") {
    if (setCors(req, res)) return;
  }
  switch (action) {
    case "entries":        return handleEntries(req, res);
    case "entry":          return handleEntry(req, res);
    case "update-entry":   return handleUpdateEntry(req, res);
    case "snapshot":       return handleSnapshot(req, res);
    case "gmail-auth":     return handleGmailAuth(req, res);
    case "gmail-callback": return handleGmailCallback(req, res);
    case "gmail-emails":   return handleGmailEmails(req, res);
    default:               return res.status(404).json({ error: "Not found" });
  }
}
