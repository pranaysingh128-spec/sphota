// ── Vercel config ──────────────────────────────────────────────────────────────
// IMPORTANT: Do NOT add `runtime: "nodejs"` — unknown key causes Vercel to
// silently misconfigure the function, making bodyParser: false ineffective.
// maxDuration: Vercel Pro allows up to 300s. Set 60s to cover upload + Gemini poll (30s) + generateContent.
// Without this, Vercel free/hobby defaults to 10s and times out on any audio chunk > ~1MB.
export const config = { api: { bodyParser: false, responseLimit: false }, maxDuration: 90 };

import busboy from "busboy";
import { Readable } from "stream";

interface ParsedFile {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
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

// ── Supabase helpers ───────────────────────────────────────────────────────────
function getSupabaseEnv(): { url: string; key: string } | null {
  let url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url) { console.error("[transcribe][auth] Missing SUPABASE_URL"); return null; }
  if (!key) { console.error("[transcribe][auth] Missing SUPABASE_SERVICE_ROLE_KEY"); return null; }
  if (!url.startsWith("http")) url = "https://" + url;
  return { url, key };
}

async function verifySupabaseToken(token: string, supabaseUrl: string, serviceKey: string): Promise<string | null> {
  if (!token) return null;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? serviceKey;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
    if (!res.ok) { console.warn(`[transcribe][auth] Supabase returned ${res.status}`); return null; }
    const user = await res.json() as { id?: string };
    return user?.id ?? null;
  } catch (e: any) { console.error("[transcribe][auth] verifySupabaseToken threw:", e?.message); return null; }
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

async function checkRateLimit(
  supabaseUrl: string, serviceKey: string, userId: string, endpoint: string, plan?: string
): Promise<{ limited: boolean; remaining: number }> {
  const MONTHLY_LIMITS: Record<string, number> = { chat: 9999, transcribe: 500, scan: 20 };
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
    if (!res.ok) {
      console.warn(`[transcribe][ratelimit] RPC failed (${res.status}) — allowing`);
      return { limited: false, remaining: limit };
    }
    const count: number = await res.json();
    return { limited: count > limit, remaining: Math.max(0, limit - count) };
  } catch (e: any) {
    console.warn("[transcribe][ratelimit] threw — allowing:", e?.message);
    return { limited: false, remaining: limit };
  }
}

function logAuditEvent(supabaseUrl: string, serviceKey: string, event: any): void {
  fetch(`${supabaseUrl}/rest/v1/audit_logs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: event.userId, action: event.action, resource_type: event.resourceType ?? null, resource_id: event.resourceId ?? null, ip: event.ip ?? null, user_agent: event.userAgent ?? null, details: event.details ?? null }),
  }).catch((err) => console.warn("[transcribe][audit] Failed:", err?.message ?? err));
}

function getRequestIp(req: any): string {
  return ((req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "") as string).split(",")[0].trim();
}

// ── Multipart parser (busboy) ──────────────────────────────────────────────────
function parseMultipartFile(req: any): Promise<ParsedFile | null> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] ?? "";
    console.log("[transcribe][busboy] content-type:", contentType);

    if (!contentType.includes("multipart/form-data")) {
      console.error("[transcribe][busboy] NOT multipart/form-data:", contentType);
      return resolve(null);
    }

    let bb: any;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
    } catch (e: any) {
      console.error("[transcribe][busboy] Failed to create busboy:", e?.message);
      return reject(e);
    }

    let resolved = false;
    const chunks: Buffer[] = [];
    let fileMime = "audio/webm";
    let fileName = "audio.webm";
    let fileFound = false;

    bb.on("file", (fieldname: string, stream: Readable, info: any) => {
      const { filename, mimeType } = info;
      console.log(`[transcribe][busboy] Field="${fieldname}" filename="${filename}" mimeType="${mimeType}"`);
      fileFound = true;
      fileMime = mimeType ?? "audio/webm";
      fileName = filename ?? "audio.webm";
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => console.log(`[transcribe][busboy] stream end, chunks=${chunks.length}`));
      stream.on("error", (err: any) => { if (!resolved) { resolved = true; reject(err); } });
      (stream as any).on("limit", () => { if (!resolved) { resolved = true; reject(new Error("Audio file too large (max 25 MB)")); } });
    });

    bb.on("finish", () => {
      if (!resolved) {
        resolved = true;
        if (!fileFound || chunks.length === 0) { resolve(null); }
        else {
          const buffer = Buffer.concat(chunks);
          console.log(`[transcribe][busboy] Assembled: ${buffer.length} bytes, mime=${fileMime}`);
          resolve({ buffer, mimetype: fileMime, filename: fileName });
        }
      }
    });

    bb.on("error", (err: any) => {
      console.error("[transcribe][busboy] Parser error:", err?.message);
      if (!resolved) { resolved = true; reject(err); }
    });

    try { req.pipe(bb); }
    catch (e: any) { if (!resolved) { resolved = true; reject(e); } }
  });
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const ALLOWED_AUDIO_MIMES = [
  "audio/webm", "audio/mp4", "audio/m4a", "audio/ogg",
  "audio/wav", "audio/mpeg", "audio/x-m4a", "audio/aac", "audio/flac",
];

// Gemini generateContent inline data supports these (NOT webm).
const GEMINI_INLINE_MIMES = new Set([
  "audio/ogg", "audio/mp4", "audio/m4a", "audio/x-m4a",
  "audio/wav", "audio/mpeg", "audio/aac", "audio/flac",
]);

function mimeToExt(baseMime: string): string {
  if (baseMime.includes("mp4") || baseMime.includes("m4a")) return "mp4";
  if (baseMime.includes("ogg"))  return "ogg";
  if (baseMime.includes("wav"))  return "wav";
  if (baseMime.includes("mpeg")) return "mp3";
  if (baseMime.includes("aac"))  return "aac";
  if (baseMime.includes("flac")) return "flac";
  return "webm";
}

function toGeminiMime(baseMime: string): string {
  if (baseMime.includes("mpeg")) return "audio/mpeg";
  if (baseMime.includes("ogg"))  return "audio/ogg";
  if (baseMime.includes("wav"))  return "audio/wav";
  if (baseMime.includes("aac"))  return "audio/aac";
  if (baseMime.includes("flac")) return "audio/flac";
  return baseMime;
}

// ── Gemini Files API (supports webm!) ─────────────────────────────────────────
// The Files API is a two-step process:
//   1. Upload the audio file to files.googleapis.com — get back a file URI
//   2. Call generateContent with that URI instead of inline base64
// This path supports webm, mp4, and everything else Gemini can handle.
// It is used as the PRIMARY path for webm (where inline doesn't work).
async function transcribeWithGeminiFiles(
  audioBuffer: Buffer, baseMime: string, geminiKey: string, keyLabel: string, speakerInstruction?: string
): Promise<string | null> {
  const ext = mimeToExt(baseMime);
  // Map to Gemini-accepted MIME for the Files API upload
  // Gemini Files API accepts: audio/webm, audio/mp4, audio/ogg, audio/wav, audio/mpeg, audio/aac, audio/flac
  let uploadMime = baseMime;
  if (baseMime.includes("webm")) uploadMime = "audio/webm";
  else if (baseMime.includes("mp4") || baseMime.includes("m4a")) uploadMime = "audio/mp4";

  try {
    console.log(`[transcribe][gemini-files] ${keyLabel}: Uploading ${audioBuffer.length} bytes as ${uploadMime}`);

    // Step 1: Upload file
    const uploadRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key=${geminiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": uploadMime,
          "X-Goog-Upload-Content-Type": uploadMime,
          "X-Goog-Upload-Protocol": "raw",
        },
        body: new Uint8Array(audioBuffer),
      }
    );

    const uploadText = await uploadRes.text();
    console.log(`[transcribe][gemini-files] ${keyLabel}: Upload HTTP ${uploadRes.status}, response_length=${uploadText.length}`);

    if (!uploadRes.ok) {
      console.warn(`[transcribe][gemini-files] ${keyLabel}: Upload failed ${uploadRes.status}: ${uploadText.slice(0, 300)}`);
      return null;
    }

    let uploadData: any;
    try { uploadData = JSON.parse(uploadText); }
    catch { console.warn(`[transcribe][gemini-files] ${keyLabel}: Upload non-JSON response`); return null; }

    const fileUri = uploadData?.file?.uri;
    const fileName2 = uploadData?.file?.name;
    let fileState: string = uploadData?.file?.state ?? "PROCESSING";
    console.log(`[transcribe][gemini-files] ${keyLabel}: Uploaded as uri=${fileUri}, name=${fileName2}, state=${fileState}`);

    if (!fileUri) {
      console.warn(`[transcribe][gemini-files] ${keyLabel}: No file URI in upload response`);
      return null;
    }

    // CRITICAL: Poll until file is ACTIVE before calling generateContent.
    // Gemini Files API returns state=PROCESSING immediately after upload.
    // Calling generateContent with a PROCESSING file returns an error or
    // empty response — for large audio files this processing can take up
    // to 20 seconds. We poll every 2 seconds for up to 30 seconds.
    if (fileState !== "ACTIVE" && fileName2) {
      console.log(`[transcribe][gemini-files] ${keyLabel}: File is PROCESSING — polling for ACTIVE state…`);
      const maxPolls = 15; // 15 × 2s = 30s max wait
      for (let i = 0; i < maxPolls && fileState !== "ACTIVE" && fileState !== "FAILED"; i++) {
        await new Promise<void>(r => setTimeout(r, 2000));
        try {
          const pollRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${geminiKey}`
          );
          if (pollRes.ok) {
            const pollData: any = await pollRes.json();
            fileState = pollData?.state ?? fileState;
            console.log(`[transcribe][gemini-files] ${keyLabel}: Poll ${i + 1}: state=${fileState}`);
          } else {
            console.warn(`[transcribe][gemini-files] ${keyLabel}: Poll ${i + 1} HTTP ${pollRes.status}`);
          }
        } catch (pe: any) {
          console.warn(`[transcribe][gemini-files] ${keyLabel}: Poll ${i + 1} threw: ${pe?.message}`);
        }
      }
    }

    if (fileState !== "ACTIVE") {
      console.warn(`[transcribe][gemini-files] ${keyLabel}: File never became ACTIVE (final state=${fileState}) — skipping generateContent`);
      if (fileName2) {
        fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${geminiKey}`, { method: "DELETE" }).catch(() => {});
      }
      return null;
    }

    console.log(`[transcribe][gemini-files] ${keyLabel}: File is ACTIVE — proceeding to generateContent`);

    // Step 2: Transcribe using the uploaded file URI
    const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    for (const model of models) {
      try {
        console.log(`[transcribe][gemini-files] ${keyLabel}/${model}: Generating content from file URI`);
        const genRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                role: "user",
                parts: [
                  { fileData: { mimeType: uploadMime, fileUri } },
                  { text: speakerInstruction ?? "Label each speaker as 'Doctor:' or 'Patient:'. Annotate non-verbal cues inline using these markers: [pause], [long pause], [laughs], [sighs], [voice break], [quietly]. Return only the transcription with these annotations — no commentary, no extra formatting." },
                ],
              }],
              generationConfig: { maxOutputTokens: 8192, temperature: 0 },
            }),
          }
        );

        const genText = await genRes.text();
        console.log(`[transcribe][gemini-files] ${keyLabel}/${model}: HTTP ${genRes.status}, response_length=${genText.length}`);

        if (!genRes.ok) {
          console.warn(`[transcribe][gemini-files] ${keyLabel}/${model}: ${genRes.status}: ${genText.slice(0, 300)}`);
          if (genRes.status === 404) continue;
          break; // 429, 400, 500 — stop trying models for this key
        }

        let genData: any;
        try { genData = JSON.parse(genText); }
        catch { console.warn(`[transcribe][gemini-files] ${keyLabel}/${model}: non-JSON`); continue; }

        const blockReason = genData?.promptFeedback?.blockReason;
        if (blockReason) { console.warn(`[transcribe][gemini-files] ${keyLabel}/${model}: blocked: ${blockReason}`); break; }

        const transcript = (genData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
        const finishReason = genData?.candidates?.[0]?.finishReason;
        console.log(`[transcribe][gemini-files] ${keyLabel}/${model}: finishReason=${finishReason}, transcript_length=${transcript.length}`);

        if (transcript) {
          console.log(`[transcribe][gemini-files] SUCCESS via ${keyLabel}/${model}`);
          // Clean up uploaded file asynchronously (best-effort, don't await)
          if (fileName2) {
            fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${geminiKey}`, { method: "DELETE" })
              .catch(() => {});
          }
          return transcript;
        }

        console.warn(`[transcribe][gemini-files] ${keyLabel}/${model}: empty transcript`);
        break;
      } catch (e: any) {
        console.warn(`[transcribe][gemini-files] ${keyLabel}/${model}: threw: ${e?.message}`);
        continue;
      }
    }

    // Clean up even on failure
    if (fileName2) {
      fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${geminiKey}`, { method: "DELETE" })
        .catch(() => {});
    }
    return null;
  } catch (e: any) {
    console.warn(`[transcribe][gemini-files] ${keyLabel}: outer threw: ${e?.message}`);
    return null;
  }
}

// ── Gemini inline (for non-webm formats) ──────────────────────────────────────
async function transcribeWithGeminiInline(
  audioBuffer: Buffer, geminiMimeType: string, geminiKey: string, keyLabel: string, speakerInstruction?: string
): Promise<string | null> {
  const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
  for (const model of models) {
    try {
      console.log(`[transcribe][gemini] ${keyLabel}/${model}: bytes=${audioBuffer.length}, mime=${geminiMimeType}`);
      const audioBase64 = audioBuffer.toString("base64");
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { inline_data: { mime_type: geminiMimeType, data: audioBase64 } },
                { text: speakerInstruction ?? "Label each speaker as 'Doctor:' or 'Patient:'. Annotate non-verbal cues inline using these markers: [pause], [long pause], [laughs], [sighs], [voice break], [quietly]. Return only the transcription with these annotations — no commentary, no extra formatting." },
              ],
            }],
            generationConfig: { maxOutputTokens: 8192, temperature: 0 },
          }),
        }
      );
      const responseText = await r.text();
      console.log(`[transcribe][gemini] ${keyLabel}/${model}: HTTP ${r.status}, length=${responseText.length}`);
      if (!r.ok) {
        console.warn(`[transcribe][gemini] ${keyLabel}/${model}: ${r.status}: ${responseText.slice(0, 300)}`);
        if (r.status === 404) continue;
        return null;
      }
      let data: any;
      try { data = JSON.parse(responseText); } catch { continue; }
      const blockReason = data?.promptFeedback?.blockReason;
      if (blockReason) { console.warn(`[transcribe][gemini] ${keyLabel}/${model}: blocked: ${blockReason}`); return null; }
      const transcript = (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
      if (transcript) { console.log(`[transcribe][gemini] SUCCESS via ${keyLabel}/${model}`); return transcript; }
      console.warn(`[transcribe][gemini] ${keyLabel}/${model}: empty transcript`);
      return null;
    } catch (e: any) {
      console.warn(`[transcribe][gemini] ${keyLabel}/${model}: threw: ${e?.message}`);
      continue;
    }
  }
  return null;
}

// ── Groq Whisper ───────────────────────────────────────────────────────────────
async function transcribeWithGroq(
  audioBuffer: Buffer, baseMime: string, ext: string, groqKey: string
): Promise<string | null> {
  // Validate audio buffer before sending
  const firstBytes = audioBuffer.slice(0, 4).toString("hex").toUpperCase();
  const isValidWebm = firstBytes.startsWith("1A45"); // WebM EBML magic bytes
  const isValidOgg  = firstBytes.startsWith("4F676753"); // OggS
  const isValidMp4  = audioBuffer.length > 8 && audioBuffer.slice(4, 8).toString("ascii") === "ftyp";
  console.log(`[transcribe][groq] bytes=${audioBuffer.length}, mime=${baseMime}, first4=${firstBytes}, validWebm=${isValidWebm}, validOgg=${isValidOgg}, validMp4=${isValidMp4}, prefix=${groqKey.slice(0, 8)}`);

  if (audioBuffer.length < 1000) {
    console.warn("[transcribe][groq] Buffer too small to be valid audio — skipping");
    return null;
  }

  // Try both Groq Whisper models (turbo first — faster, same quality for most audio)
  const models = ["whisper-large-v3-turbo", "whisper-large-v3"];
  for (const model of models) {
    try {
      console.log(`[transcribe][groq] Trying model=${model}`);
      const form = new FormData();
      // Pass the Buffer directly — Buffer IS a Uint8Array subclass in Node.js
      // and avoids potential issues with shared ArrayBuffer pool offsets.
      const audioBlob = new Blob([Uint8Array.from(audioBuffer)], { type: baseMime });
      form.append("file", audioBlob, `audio.${ext}`);
      form.append("model", model);
      form.append("response_format", "json");
      // Do NOT force language — let Whisper auto-detect (supports Hindi, English, mixed)
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${groqKey}` },
        body: form,
      });
      const responseText = await r.text();
      console.log(`[transcribe][groq] model=${model}: HTTP ${r.status}, preview=${responseText.slice(0, 300)}`);
      if (!r.ok) {
        console.warn(`[transcribe][groq] model=${model}: HTTP ${r.status}: ${responseText.slice(0, 400)}`);
        if (r.status === 400) continue; // bad request for this model — try next
        return null; // 401/429/500 — don't retry
      }
      let data: { text?: string };
      try { data = JSON.parse(responseText); } catch { continue; }
      const transcript = (data.text ?? "").trim();
      if (transcript) { console.log(`[transcribe][groq] SUCCESS model=${model}, length=${transcript.length}`); return transcript; }
      console.warn(`[transcribe][groq] model=${model}: empty transcript`);
    } catch (e: any) {
      console.warn(`[transcribe][groq] model=${model} threw:`, e?.message);
    }
  }
  return null;
}

// ── Main handler ───────────────────────────────────────────────────────────────
// ── Health-check helpers (used by GET /api/ai/transcribe) ─────────────────────
interface ProviderResult {
  configured: boolean; reachable: boolean | null; status: number | null;
  latencyMs: number | null; detail: string;
}

async function checkGeminiHealth(apiKey: string, label: string): Promise<ProviderResult> {
  if (!apiKey) return { configured: false, reachable: null, status: null, latencyMs: null, detail: `${label} not set` };
  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const latencyMs = Date.now() - t0;
    const body = await res.text();
    if (res.ok) {
      const genT0 = Date.now();
      const genRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word: OK" }] }], generationConfig: { maxOutputTokens: 5, temperature: 0 } }),
          signal: AbortSignal.timeout(10000),
        }
      );
      const genMs = Date.now() - genT0;
      const genBody = await genRes.text();
      let genData: any; try { genData = JSON.parse(genBody); } catch { genData = null; }
      const genText = (genData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
      const genOk = genRes.ok && !!genText;
      return { configured: true, reachable: genOk, status: genRes.status, latencyMs: latencyMs + genMs,
        detail: genOk ? `Key valid · gemini-2.5-flash responded in ${latencyMs + genMs}ms` : `Key valid but generateContent failed (HTTP ${genRes.status}): ${genBody.slice(0, 120)}` };
    }
    return { configured: true, reachable: false, status: res.status, latencyMs,
      detail: res.status === 400 ? "API key invalid or restricted" : `HTTP ${res.status}: ${body.slice(0, 120)}` };
  } catch (e: any) {
    return { configured: true, reachable: false, status: null, latencyMs: Date.now() - t0, detail: `Request failed: ${e?.message ?? String(e)}` };
  }
}

async function checkGroqHealth(apiKey: string): Promise<ProviderResult> {
  if (!apiKey) return { configured: false, reachable: null, status: null, latencyMs: null, detail: "GROQ_API_KEY not set" };
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - t0;
    const body = await res.text();
    if (res.ok) {
      let data: any; try { data = JSON.parse(body); } catch { data = null; }
      const models: string[] = (data?.data ?? []).map((m: any) => m.id as string);
      const hasWhisper = models.some(m => m.includes("whisper"));
      const whisperModels = models.filter(m => m.includes("whisper")).join(", ") || "none found";
      return { configured: true, reachable: true, status: res.status, latencyMs,
        detail: hasWhisper ? `Key valid · Whisper models: ${whisperModels} · ${latencyMs}ms` : `Key valid but NO whisper models found. Available: ${models.slice(0, 6).join(", ")}` };
    }
    return { configured: true, reachable: false, status: res.status, latencyMs,
      detail: res.status === 401 ? "API key invalid" : `HTTP ${res.status}: ${body.slice(0, 120)}` };
  } catch (e: any) {
    return { configured: true, reachable: false, status: null, latencyMs: Date.now() - t0, detail: `Request failed: ${e?.message ?? String(e)}` };
  }
}

export default async function handler(req: any, res: any) {
  console.log(`[transcribe] ===== ${req.method} content-type=${req.headers["content-type"]}`);
  if (setCors(req, res)) return;

  // ── GET /api/ai/transcribe → health check (merged from transcribe-health.ts) ─
  if (req.method === "GET") {
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ message: "Unauthorized" });
    const env = getSupabaseEnv();
    if (!env) return res.status(500).json({ message: "Server misconfigured — Supabase env missing" });
    const userId = await verifySupabaseToken(token, env.url, env.key);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const startMs = Date.now();
    // Build health-check key pool same way as POST handler
    const healthKeys: Array<{ key: string; label: string }> = [
      { key: process.env.GEMINI_TRANSCRIBE_1 ?? process.env.GEMINI_API_KEY   ?? process.env.AI_KEY_1 ?? "", label: "GEMINI_TRANSCRIBE_1" },
      { key: process.env.GEMINI_TRANSCRIBE_2 ?? process.env.GEMINI_API_KEY_2 ?? "",                         label: "GEMINI_TRANSCRIBE_2" },
      { key: process.env.GEMINI_TRANSCRIBE_3 ?? "",                                                          label: "GEMINI_TRANSCRIBE_3" },
      { key: process.env.GEMINI_TRANSCRIBE_4 ?? "",                                                          label: "GEMINI_TRANSCRIBE_4" },
      { key: process.env.GEMINI_TRANSCRIBE_5 ?? "",                                                          label: "GEMINI_TRANSCRIBE_5" },
      { key: process.env.GEMINI_TRANSCRIBE_6 ?? "",                                                          label: "GEMINI_TRANSCRIBE_6" },
      { key: process.env.GEMINI_TRANSCRIBE_7 ?? "",                                                          label: "GEMINI_TRANSCRIBE_7" },
      { key: process.env.GEMINI_TRANSCRIBE_8 ?? "",                                                          label: "GEMINI_TRANSCRIBE_8" },
    ].filter(e => !!e.key);
    const groqKey    = process.env.GROQ_API_KEY    ?? "";
    const openaiKey  = process.env.OPENAI_API_KEY  ?? "";

    const geminiResults = await Promise.all(healthKeys.map(e => checkGeminiHealth(e.key, e.label)));
    const groq = await checkGroqHealth(groqKey);

    const openaiConfigured = !!openaiKey;
    const totalMs = Date.now() - startMs;
    const anyGeminiReachable = geminiResults.some(r => r.reachable);
    const anyReachable = anyGeminiReachable || groq.reachable;
    const overall = anyReachable ? "ok" : "degraded";

    const firstGoodGemini = healthKeys[geminiResults.findIndex(r => r.reachable)];
    let expectedRoute: string;
    if (firstGoodGemini) expectedRoute = `${firstGoodGemini.label} → gemini-2.5-flash`;
    else if (groq.reachable) expectedRoute = "GROQ_API_KEY → whisper-large-v3-turbo";
    else if (openaiConfigured) expectedRoute = "OPENAI_API_KEY → whisper-1 (fallback)";
    else expectedRoute = "NO PROVIDER AVAILABLE — transcription will fail";

    const geminiProviders: Record<string, ProviderResult> = {};
    healthKeys.forEach((e, i) => { geminiProviders[e.label] = geminiResults[i]; });

    return res.status(overall === "ok" ? 200 : 503).json({
      overall, checkedAt: new Date().toISOString(), totalCheckMs: totalMs, expectedRoute,
      providers: {
        ...geminiProviders,
        GROQ_API_KEY:  groq,
        OPENAI_API_KEY: { configured: openaiConfigured, reachable: null, status: null, latencyMs: null, detail: openaiConfigured ? "Present (not checked — paid key)" : "Not configured" },
      },
    });
  }

  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

  // Role param — determines speaker label style for diarization at the Gemini prompt level
  const role = (req.query?.role as string) ?? "patient";
  const pauseInstruction = "Listen to the actual gaps of silence in the audio itself — do not guess pauses from sentence structure or punctuation. Ordinary conversational thinking time is under 3 seconds and should NOT be tagged at all. Insert [pause] only for a silence of roughly 3–10 seconds between words or turns. Insert [long pause] only for a silence of roughly 10 seconds or more, since this is what stands out as clinically notable (e.g. possible psychomotor retardation) rather than normal hesitation.";
  const speakerInstruction = role === "collateral"
    ? `Transcribe this audio exactly as spoken. Label each speaker as 'Doctor:' or 'Family:' at the start of each speaker turn. The Doctor is the psychiatrist asking questions. Family refers to the patient's family member or informant providing history about the patient. ${pauseInstruction} Also annotate these non-verbal cues inline where you hear them: [laughs], [sighs], [voice break], [quietly], [crying]. Do not add timestamps or time markers of any kind. Return only the transcription — no commentary, no extra formatting.`
    : `Transcribe this audio exactly as spoken. Label each speaker as 'Doctor:' or 'Patient:' at the start of each speaker turn. ${pauseInstruction} Also annotate these non-verbal cues inline where you hear them: [laughs], [sighs], [voice break], [quietly], [crying]. Do not add timestamps or time markers of any kind. Return only the transcription — no commentary, no extra formatting.`;
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ message: "Unauthorized" });
  const env = getSupabaseEnv();
  if (!env) return res.status(500).json({ message: "Server misconfigured" });
  const userId = await verifySupabaseToken(token, env.url, env.key);
  if (!userId) return res.status(401).json({ message: "Unauthorized" });
  console.log(`[transcribe] Auth OK userId=${userId.slice(0, 8)}`);

  // Keys — GEMINI_TRANSCRIBE_1..5 are the new pool (slots you add keys into one by one).
  // Falls back to the old GEMINI_API_KEY / GEMINI_API_KEY_2 names so existing deployments
  // keep working without any env variable changes.
  const transcribeKeys: string[] = [
    process.env.GEMINI_TRANSCRIBE_1 ?? process.env.GEMINI_API_KEY   ?? process.env.AI_KEY_1 ?? "",
    process.env.GEMINI_TRANSCRIBE_2 ?? process.env.GEMINI_API_KEY_2 ?? "",
    process.env.GEMINI_TRANSCRIBE_3 ?? "",
    process.env.GEMINI_TRANSCRIBE_4 ?? "",
    process.env.GEMINI_TRANSCRIBE_5 ?? "",
    process.env.GEMINI_TRANSCRIBE_6 ?? "",
    process.env.GEMINI_TRANSCRIBE_7 ?? "",
    process.env.GEMINI_TRANSCRIBE_8 ?? "",
  ].filter(Boolean); // remove empty slots — only configured keys are used
  const groqKey   = process.env.GROQ_API_KEY   ?? "";
  const openaiKey = process.env.OPENAI_API_KEY ?? "";
  console.log(`[transcribe] Keys: transcribePool=${transcribeKeys.length}, GROQ=${!!groqKey}(${groqKey.slice(0,8)}), OPENAI=${!!openaiKey}`);

  if (transcribeKeys.length === 0 && !groqKey && !openaiKey) {
    return res.status(503).json({ message: "No API keys configured. Add GEMINI_TRANSCRIBE_1 (or GEMINI_API_KEY) in Vercel environment variables." });
  }

  // Rate limit — check doctor plan first; unlimited/clinical/premium bypass caps
  const doctorPlan = await getDoctorPlan(env.url, env.key, userId);
  const { limited } = await checkRateLimit(env.url, env.key, userId, "transcribe", doctorPlan);
  if (limited) return res.status(429).json({ message: "Monthly transcription limit reached." });

  // Parse audio
  console.log("[transcribe] Parsing multipart...");
  let parsedFile: ParsedFile | null = null;
  try { parsedFile = await parseMultipartFile(req); }
  catch (e: any) { return res.status(400).json({ message: e?.message ?? "Failed to parse upload" }); }

  if (!parsedFile || parsedFile.buffer.length === 0) {
    return res.status(400).json({ message: "No audio received. Ensure the form field is named 'file'." });
  }

  const audioBuffer = parsedFile.buffer;
  const rawMime = parsedFile.mimetype || "audio/webm";
  const baseMime = rawMime.split(";")[0].trim().toLowerCase();
  const ext = mimeToExt(baseMime);
  // Log first 8 bytes as hex — helps diagnose corrupt/truncated uploads in Vercel logs.
  // Valid WebM starts with 1A 45 DF A3; OggS starts with 4F 67 67 53; MP4 has 66 74 79 70 at offset 4.
  const hexPrefix = audioBuffer.slice(0, 8).toString("hex").toUpperCase();
  console.log(`[transcribe] Audio: ${audioBuffer.length} bytes, baseMime=${baseMime}, ext=${ext}, hex=${hexPrefix}`);

  if (!ALLOWED_AUDIO_MIMES.includes(baseMime)) {
    return res.status(400).json({ message: `Unsupported audio format: ${baseMime}` });
  }

  const transcribeStartMs = Date.now();
  logAuditEvent(env.url, env.key, {
    userId, action: "ai_transcribe", resourceType: "audio",
    ip: getRequestIp(req), userAgent: req.headers["user-agent"] ?? "",
    details: { bytes: audioBuffer.length, mime: baseMime },
  });

  const canUseInline = GEMINI_INLINE_MIMES.has(baseMime);
  const isWebm = baseMime.includes("webm");

  console.log(`[transcribe] Routing: baseMime=${baseMime}, isWebm=${isWebm}, canUseInline=${canUseInline}`);

  // ── STRATEGY:
  // webm (Chrome/Edge) → Gemini Files API pool first, then Groq, then OpenAI
  // ogg/wav/mp3/mp4    → Gemini inline pool first, then Files API pool, then Groq, then OpenAI
  // Both paths iterate through ALL configured transcribeKeys before falling through.

  let result: string | null = null;
  const triedProviders: string[] = [];

  function logSuccess(provider: string, model: string, keyLabel: string | null, transcript: string) {
    logAuditEvent(env!.url, env!.key, {
      userId: userId!, action: "transcription_succeeded", resourceType: "audio",
      ip: getRequestIp(req), userAgent: req.headers["user-agent"] ?? "",
      details: { provider, model, key_label: keyLabel, audio_bytes: audioBuffer.length, mime: baseMime, transcript_chars: transcript.length, duration_ms: Date.now() - transcribeStartMs },
    });
  }

  if (isWebm) {
    console.log(`[transcribe] webm path: Gemini Files API pool(${transcribeKeys.length} keys) → Groq → OpenAI`);
    for (let i = 0; i < transcribeKeys.length; i++) {
      const label = `GEMINI_TRANSCRIBE_${i + 1}`;
      triedProviders.push(`gemini-files(${label})`);
      result = await transcribeWithGeminiFiles(audioBuffer, baseMime, transcribeKeys[i], label, speakerInstruction);
      if (result) { logSuccess("gemini", `gemini-files (${label})`, label, result); return res.json({ transcript: result, model: `gemini-files (${label})` }); }
    }
    if (groqKey) {
      triedProviders.push("groq-whisper");
      result = await transcribeWithGroq(audioBuffer, baseMime, ext, groqKey);
      if (result) { logSuccess("groq", "groq-whisper-large-v3", null, result); return res.json({ transcript: result, model: "groq-whisper-large-v3" }); }
    }
    if (openaiKey) {
      triedProviders.push("openai-whisper-1");
      try {
        const form = new FormData();
        form.append("file", new Blob([Uint8Array.from(audioBuffer)], { type: baseMime }), `audio.${ext}`);
        form.append("model", "whisper-1");
        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: `Bearer ${openaiKey}` }, body: form,
        });
        if (r.ok) {
          const data = await r.json() as { text?: string };
          const t = (data.text ?? "").trim();
          if (t) { logSuccess("openai", "whisper-1", null, t); return res.json({ transcript: t, model: "openai-whisper-1" }); }
        }
      } catch (e: any) { console.warn("[transcribe][openai] threw:", e?.message); }
    }
  } else {
    console.log(`[transcribe] non-webm path: Gemini inline pool(${transcribeKeys.length} keys) → Files API → Groq → OpenAI`);
    const geminiMime = toGeminiMime(baseMime);

    if (canUseInline) {
      for (let i = 0; i < transcribeKeys.length; i++) {
        const label = `GEMINI_TRANSCRIBE_${i + 1}`;
        triedProviders.push(`gemini-inline(${label})`);
        result = await transcribeWithGeminiInline(audioBuffer, geminiMime, transcribeKeys[i], label, speakerInstruction);
        if (result) { logSuccess("gemini", `gemini-inline (${label})`, label, result); return res.json({ transcript: result, model: `gemini-inline (${label})` }); }
      }
    }
    for (let i = 0; i < transcribeKeys.length; i++) {
      const label = `GEMINI_TRANSCRIBE_${i + 1}`;
      triedProviders.push(`gemini-files(${label})`);
      result = await transcribeWithGeminiFiles(audioBuffer, baseMime, transcribeKeys[i], label, speakerInstruction);
      if (result) { logSuccess("gemini", `gemini-files (${label})`, label, result); return res.json({ transcript: result, model: `gemini-files (${label})` }); }
    }
    if (groqKey) {
      triedProviders.push("groq-whisper");
      result = await transcribeWithGroq(audioBuffer, baseMime, ext, groqKey);
      if (result) { logSuccess("groq", "groq-whisper-large-v3", null, result); return res.json({ transcript: result, model: "groq-whisper-large-v3" }); }
    }
    if (openaiKey) {
      triedProviders.push("openai-whisper-1");
      try {
        const form = new FormData();
        form.append("file", new Blob([Uint8Array.from(audioBuffer)], { type: baseMime }), `audio.${ext}`);
        form.append("model", "whisper-1");
        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: `Bearer ${openaiKey}` }, body: form,
        });
        if (r.ok) {
          const data = await r.json() as { text?: string };
          const t = (data.text ?? "").trim();
          if (t) { logSuccess("openai", "whisper-1", null, t); return res.json({ transcript: t, model: "openai-whisper-1" }); }
        }
      } catch (e: any) { console.warn("[transcribe][openai] threw:", e?.message); }
    }
  }

  const configured = transcribeKeys.length > 0 ? `GEMINI_TRANSCRIBE pool(${transcribeKeys.length})` : "none";
  console.error(`[transcribe] ALL PROVIDERS FAILED. baseMime=${baseMime}, configured=${configured}, groq=${!!groqKey}`);
  logAuditEvent(env!.url, env!.key, {
    userId: userId!, action: "transcription_failed", resourceType: "audio",
    ip: getRequestIp(req), userAgent: req.headers["user-agent"] ?? "",
    details: { audio_bytes: audioBuffer.length, mime: baseMime, providers_tried: triedProviders, duration_ms: Date.now() - transcribeStartMs },
  });
  return res.status(503).json({
    message: "Transcription temporarily unavailable — all providers failed. Please check Vercel logs for the specific error from each provider.",
  });
}
