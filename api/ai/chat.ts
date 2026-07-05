// maxDuration: SSE streaming keeps the connection alive for long reports.
// runtime: "nodejs" is NOT a valid Pages API config key — use maxDuration at top level.
// responseLimit: false prevents Vercel truncating large streamed responses.
export const config = { api: { responseLimit: false }, maxDuration: 90 };
// ── Provider routing for ALL non-transcript AI tasks ──────────────────────────
//
// STREAMING VERSION — uses SSE (text/event-stream) so long transcripts never time out.
// The server pipes Gemini/Groq/OpenAI tokens to the client as they arrive.
// Client reads via ReadableStream, so Vercel's function stays alive the whole time.
//
// Chain (strictly in order):
//   1. Gemini  (primary)  — gemini-2.5-flash → gemini-2.5-flash-lite  [streaming]
//   2. Groq    (fallback) — llama-3.3-70b → llama-3.1-8b              [streaming]
//   3. OpenAI  (final fallback) — gpt-4o                               [streaming]
// ─────────────────────────────────────────────────────────────────────────────

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
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
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
    if (expiresAt && expiresAt <= new Date() && plan !== "free" && plan !== "unlimited") {
      fetch(`${supabaseUrl}/rest/v1/doctors?id=eq.${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, Prefer: "return=minimal" },
        body: JSON.stringify({ plan: "free", plan_expires_at: null }),
      }).catch(() => {});
      return "free";
    }
    return plan;
  } catch { return "free"; }
}

const PLAN_MONTHLY_LIMITS: Record<string, number> = {
  free: 30, starter: 75, clinical: 9999, premium: 9999, unlimited: 99999,
};

async function checkPlanRateLimit(
  supabaseUrl: string, serviceKey: string, userId: string, endpoint: string, limit: number
): Promise<{ limited: boolean; remaining: number; count: number }> {
  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_ai_usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
      body: JSON.stringify({ p_user_id: userId, p_endpoint: endpoint, p_window_start: windowStart.toISOString() }),
    });
    if (!res.ok) return { limited: false, remaining: limit, count: 0 };
    const count: number = await res.json();
    return { limited: count > limit, remaining: Math.max(0, limit - count), count };
  } catch { return { limited: false, remaining: limit, count: 0 }; }
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

function isJsonExtractionTask(messages: any[]): boolean {
  const sys = messages.find((m: any) => m.role === "system")?.content ?? "";
  const userContent = messages.find((m: any) => m.role === "user")?.content ?? "";
  return (
    /Return ONLY a valid JSON/i.test(sys) ||
    /return only.*json/i.test(sys) ||
    /respond.*only.*json/i.test(sys) ||
    /output.*only.*json/i.test(sys) ||
    /Output exactly ONE line/i.test(userContent)
  );
}

// ── Detect generic filler in Plan table (Gemini substitution pattern) ─────────
function hasGenericFillerPlan(text: string): boolean {
  const genericPhrases = [
    /continue current coping strategies/i,
    /encourage engagement with psychiatric/i,
    /monitor symptoms as clinically indicated/i,
    // NOTE: "/as clinically indicated/i" intentionally removed — it is a suffix of
    // "monitor symptoms as clinically indicated" above, so ONE occurrence of that phrase
    // would match BOTH regexes simultaneously, pushing fillerCount to 2 and causing
    // every valid clinical report containing that phrase to be rejected.
    /supportive therapy as needed/i,
    /clinical judgment per psychiatry best practice/i,
    /per clinical judgment/i,
  ];
  // Only examine the actual Plan section — do NOT fall back to tail of text.
  // The tail may be a summary or assessment section that legitimately contains
  // clinical language, leading to false rejections of perfectly valid reports.
  const planSection = text.match(/\*\*P\s*[-–]\s*Plan[\s\S]{0,3000}/i)?.[0]
    ?? text.match(/##\s*Plan[\s\S]{0,3000}/i)?.[0];
  if (!planSection) return false; // can't identify plan section — skip filler check
  const fillerCount = genericPhrases.filter(re => re.test(planSection)).length;
  // Require 3+ distinct filler phrases to reject (2 is too aggressive post deduplication)
  return fillerCount >= 3;
}

function isValidClinicalResponse(text: string, skipValidation: boolean): boolean {
  if (skipValidation) return !!text.trim();
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 200) return false;
  // Reject responses with generic filler substituted for "Not indicated"
  if (hasGenericFillerPlan(trimmed)) {
    console.warn("[validation] Rejected: generic filler detected in Plan section — retrying next provider");
    return false;
  }

  // ── Check for SUMMARY section (Section 5) — ensures the report is complete ──
  // Clinical reports must always end with a Summary. If it is absent, the response
  // was truncated mid-generation (e.g. Groq hit max_tokens) and must be rejected.
  const isPatientLetter = /Dear\s+Dr\.|Dear\s+Doctor|what we discussed|your medicines|when to call/i.test(trimmed);
  const isUtilityDoc    = /^##\s+\w/m.test(trimmed) && !/###\s*\d/.test(trimmed);
  // NIMHANS Proforma has its own structure — no numbered ### SUMMARY section
  const isNimhans = /CHIEF\s+COMPLAINTS|MENTAL\s+STATE\s+EXAM|DIAGNOSTIC\s+FORMUL|MANAGEMENT\s+PLAN|PREDISPOSING|PERPETUATING/i.test(trimmed);
  if (!isPatientLetter && !isUtilityDoc && !isNimhans) {
    // This is a clinical report — SUMMARY section is mandatory.
    // Accepts ### 5. SUMMARY (full session reports, which may have PRIORITY FLAG as section 1)
    //     and ### 4. SUMMARY (scan-based reports which have 4 sections only)
    //     and ### SUMMARY (unnumbered fallback)
    const hasSummary = /###\s*[456]\.?\s*SUMMARY|^###\s*SUMMARY/im.test(trimmed);
    if (!hasSummary) {
      console.warn("[validation] Rejected: SUMMARY section (Section 4 or 5) missing — report is likely truncated");
      return false;
    }
  }

  // Must contain at least 2 of the expected clinical report section markers.
  const sectionMarkers = [
    // ── Clinical report sections (SOAP / DAP / BIRP / PIRP / NIMHANS) ──
    /QUICK\s+SCAN/i,
    /RISK\s+ASSESS/i,
    /SUMMARY/i,
    /DIAGNOSIS/i,
    /TREATMENT/i,
    /###\s*\d/,           // numbered markdown sections (### 1, ### 2 …)
    /\*\*S\s*[-–]/i,      // **S - Subjective
    /\*\*O\s*[-–]/i,      // **O - Objective
    /\*\*A\s*[-–]/i,      // **A - Assessment
    /\*\*P\s*[-–]/i,      // **P - Plan
    /\*\*B\s*[-–]/i,      // **B - Behaviour (BIRP)
    /\*\*I\s*[-–]/i,      // **I - Intervention
    /\*\*R\s*[-–]/i,      // **R - Response
    /\*\*D\s*[-–]/i,      // **D - Data (DAP)
    // ── NIMHANS Proforma section markers ──
    /CHIEF\s+COMPLAINTS/i,
    /MENTAL\s+STATE\s+EXAM/i,
    /DIAGNOSTIC\s+FORMUL/i,
    /PERSONAL\s+HISTORY/i,
    /FAMILY\s+HISTORY/i,
    /MANAGEMENT\s+PLAN/i,
    /PREDISPOSING/i,
    /PERPETUATING/i,
    /Dear\s+Dr\./i,
    /Dear\s+Doctor/i,
    /APPOINTMENT/i,
    /DSM-5/i,
    /ICD-1/i,
    /Probable\s+Diagnosis/i,
    // ── Patient letter sections (generatePatientDoc uses ## headings) ──
    // These never appear in raw transcripts so they are safe structural signals.
    /what we discussed/i,   // ## What we discussed today
    /what is happening/i,   // ## What is happening
    /your medicines/i,      // ## Your medicines
    /what to do/i,          // ## What to do
    /when to call/i,        // ## When to call us immediately
    // ── Generic structured document (any ## heading = structured output) ──
    /^##\s+\w/m,
  ];
  const matchCount = sectionMarkers.filter(re => re.test(trimmed)).length;
  // Require at least 2 distinct section markers — single-section hallucinations are rejected
  return matchCount >= 2;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sseWrite(res: any, data: object) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const env = getSupabaseEnv();
  const isDev = process.env.NODE_ENV !== "production";
  let userId: string | null = null;

  if (env && !isDev) {
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (token) {
      userId = await verifySupabaseToken(token, env.url, env.key);
      if (!userId) return res.status(401).json({ message: "Session expired — please sign in again." });
    } else {
      return res.status(401).json({ message: "Unauthorized — please sign in." });
    }
  } else if (env && isDev) {
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (token) userId = await verifySupabaseToken(token, env.url, env.key);
  }

  const { taskType, messages } = req.body ?? {};
  const isTranslationTask = taskType === "translation";
  const isUtilityTask = taskType === "utility" || isTranslationTask;

  // ── Plan-based rate limiting ───────────────────────────────────────────────
  if (env && userId && !isUtilityTask) {
    const doctorPlan = await getDoctorPlan(env.url, env.key, userId);
    const monthlyLimit = PLAN_MONTHLY_LIMITS[doctorPlan] ?? 30;
    const { limited } = await checkPlanRateLimit(env.url, env.key, userId, "chat", monthlyLimit);
    if (limited) {
      const planLabel = doctorPlan === "free" ? "free tier" : `${doctorPlan.charAt(0).toUpperCase() + doctorPlan.slice(1)} plan`;
      const upgradeHint = doctorPlan === "free"
        ? " Upgrade to Starter (₹999/mo) for 75 sessions, or Clinical (₹2,499/mo) for unlimited."
        : doctorPlan === "starter" ? " Upgrade to Clinical (₹2,499/mo) for unlimited sessions." : "";
      return res.status(429).json({
        message: `Monthly session limit reached (${monthlyLimit} sessions on ${planLabel}).${upgradeHint} Your limit resets on the 1st of next month.`,
        retryAfter: "2592000", plan: doctorPlan, limit: monthlyLimit, remaining: 0,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ message: "messages array required" });
  if (messages.length > 50) return res.status(400).json({ message: "Too many messages (max 50)" });

  if (env && userId && !isUtilityTask) {
    logAuditEvent(env.url, env.key, { userId, action: "report_generation_started", resourceType: "report", ip: getRequestIp(req), userAgent: req.headers["user-agent"] ?? "" });
  }

  // Translation calls (taskType:"translation") use the transcribe key pool (GEMINI_TRANSCRIBE_1..8, Keys 1–8).
  // All other tasks (reports, patient letters, ICD/DSM, chat) use the report key pool (GEMINI_REPORT_1..7, Keys 9–15).
  const transcribePoolKeys: string[] = [
    process.env.GEMINI_TRANSCRIBE_1 ?? "",
    process.env.GEMINI_TRANSCRIBE_2 ?? "",
    process.env.GEMINI_TRANSCRIBE_3 ?? "",
    process.env.GEMINI_TRANSCRIBE_4 ?? "",
    process.env.GEMINI_TRANSCRIBE_5 ?? "",
    process.env.GEMINI_TRANSCRIBE_6 ?? "",
    process.env.GEMINI_TRANSCRIBE_7 ?? "",
    process.env.GEMINI_TRANSCRIBE_8 ?? "",
  ].filter(Boolean);
  const reportKeys: string[] = [
    process.env.GEMINI_REPORT_1 ?? process.env.GEMINI_API_KEY_3 ?? process.env.GEMINI_API_KEY ?? process.env.AI_KEY_1 ?? "",
    process.env.GEMINI_REPORT_2 ?? process.env.GEMINI_API_KEY_4 ?? "",
    process.env.GEMINI_REPORT_3 ?? "",
    process.env.GEMINI_REPORT_4 ?? "",
    process.env.GEMINI_REPORT_5 ?? "",
    process.env.GEMINI_REPORT_6 ?? "",
    process.env.GEMINI_REPORT_7 ?? "",
  ].filter(Boolean);
  const activeKeys = isTranslationTask ? transcribePoolKeys : reportKeys;
  const groqKey   = process.env.GROQ_API_KEY   ?? process.env.AI_KEY_2 ?? "";
  const openaiKey = process.env.OPENAI_API_KEY ?? process.env.AI_KEY_3 ?? "";

  if (activeKeys.length === 0 && !groqKey && !openaiKey) {
    return res.status(503).json({ message: "Report generation is not configured. Add at least one AI key in Vercel → Settings → Environment Variables, then redeploy." });
  }

  const skipValidation = isJsonExtractionTask(messages) || isUtilityTask;

  // ── Start SSE stream ───────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Keep-alive ping every 15s so Vercel doesn't close the connection
  const keepAlive = setInterval(() => {
    try { res.write(": keep-alive\n\n"); } catch { clearInterval(keepAlive); }
  }, 15000);

  const chatStartMs = Date.now();
  const errors: string[] = [];
  let gemini429Count = 0;   // track how many Gemini attempts hit rate limits
  let geminiAttempts = 0;   // track total Gemini attempts made

  // ── Attempt 1: Gemini STREAMING ───────────────────────────────────────────
  async function tryGeminiStreaming(apiKey: string, keyLabel: string): Promise<boolean> {
    if (!apiKey) return false;
    const geminiModels = ["gemini-2.5-flash"];
    const system   = messages.find((m: any) => m.role === "system")?.content;
    const userMsgs = messages.filter((m: any) => m.role !== "system");
    // ── Enforcer injection ────────────────────────────────────────────────────
    // Gemini ignores plan-table constraints from system prompt alone.
    // Injecting a hard pre-generation checklist directly into the last user
    // message forces compliance immediately before token generation.
    const isReportTask = !skipValidation;
    const ENFORCER_PREFIX =
      "MANDATORY PRE-GENERATION CHECKLIST — read every point before writing:\n\n" +
      "1. DEMOGRAPHICS: Use ONLY the age and gender provided in the Patient header line that appears at the top of the user message. " +
      "Never infer additional details from name, voice, or context. If a field says \"age not documented\" or \"gender not documented\", write \"Not documented in session\" for that field.\n\n" +
      "2. PLAN TABLE — \"Not indicated\" vs specific action:\n" +
      "   - Write \"Not indicated\" ONLY when that domain was genuinely not discussed and no clinical need exists.\n" +
      "   - When something IS indicated, write a SPECIFIC action: exact drug name + starting dose + " +
      "titration schedule (cite Stahl's or APA/NICE guideline), or exact therapy modality + rationale, " +
      "or exact lab test + reason.\n" +
      "   - FORBIDDEN in the Plan table: \"Monitor symptoms\", \"Continue coping strategies\", " +
      "\"As clinically indicated\", \"Encourage engagement\", \"Per clinical judgment\" alone. " +
      "These are filler, not plans. Replace with a real specific action or write \"Not indicated\".\n\n" +
      "3. SOURCE COLUMN: Every row must cite a NAMED reference — DSM-5-TR, ICD-10-CM, " +
      "Stahl's Essential Psychopharmacology, NICE Guidelines, APA Practice Guidelines, " +
      "Taylor's Prescribing Guidelines, Maudsley Prescribing Guidelines. " +
      "NEVER write \"Clinical judgment\" alone — always pair with a specific guideline or specialty.\n\n" +
      "4. PLAN DOMAIN ORDER — fixed, no exceptions:\n" +
      "   Row 1: Medications | Row 2: Safety/Risk Management | Row 3: Therapy/Psychosocial " +
      "| Row 4: Labs/Medical Workup | Row 5: Follow-up\n" +
      "   Never add rows. Never skip rows. Never reorder.\n\n" +
      "5. SUBJECTIVE/DATA/BEHAVIOUR SECTION: Hard cap 150 words. Bullet points only. " +
      "Max 3 quotes, each under 15 words — count every word in every quote.\n\n" +
      "6. NO HALLUCINATION: If a symptom, finding, or clinical detail is not spoken in the " +
      "transcript, it does not exist. Write \"Not documented in session\".\n\n" +
      "7. SUMMARY: Exactly ONE sentence. No second sentence. No exceptions.\n\n" +
      "NOW GENERATE THE REPORT:\n\n";

    const geminiContents = userMsgs.map((m: any, i: number) => {
      const isLastUser = m.role === "user" && i === userMsgs.length - 1;
      const content = isReportTask && isLastUser
        ? ENFORCER_PREFIX + m.content
        : m.content;
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: content }],
      };
    });

    for (const model of geminiModels) {
      try {
        geminiAttempts++;
        // Use streamGenerateContent for true streaming
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
              contents: geminiContents,
              generationConfig: { maxOutputTokens: 65536, temperature: 0.35, thinkingConfig: { thinkingBudget: 0 } },
            }),
          }
        );

        if (r.status === 429) {
          gemini429Count++;
          errors.push(`Gemini/${keyLabel}/${model} 429 — rate limited`);
          console.warn(`Gemini/${keyLabel}/${model} 429 — waiting 500ms before trying next key`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        if (!r.ok) {
          const errText = await r.text().catch(() => "");
          errors.push(`Gemini/${keyLabel}/${model} ${r.status}: ${errText.slice(0, 120)}`);
          if (r.status === 401 || r.status === 403) return false;
          continue;
        }

        // Stream the SSE response from Gemini to our client
        const reader = r.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";
        let geminiTruncated = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;
            try {
              const chunk = JSON.parse(jsonStr) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
              const blockReason = chunk.promptFeedback?.blockReason;
              if (blockReason) {
                errors.push(`Gemini/${keyLabel}/${model}: blocked (${blockReason})`);
                break;
              }
              const finishReason = chunk.candidates?.[0]?.finishReason;
              if (finishReason === "MAX_TOKENS") {
                geminiTruncated = true;
                console.warn(`Gemini/${keyLabel}/${model}: hit maxOutputTokens — response truncated, skipping to next provider`);
              }
              const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
              if (text) {
                accumulated += text;
                // Stream chunk to client
                sseWrite(res, { chunk: text });
              }
            } catch { /* malformed chunk, skip */ }
          }
        }

        if (geminiTruncated) {
          errors.push(`Gemini/${keyLabel}/${model}: truncated at maxOutputTokens — report incomplete`);
          // Tell the client to discard the partial streamed content before we retry
          sseWrite(res, { reset: true });
          continue;
        }

        if (accumulated && isValidClinicalResponse(accumulated, skipValidation)) {
          if (env && userId && !isUtilityTask) {
            logAuditEvent(env.url, env.key, { userId, action: "report_generation_succeeded", resourceType: "report", ip: getRequestIp(req), details: { provider: "gemini", model, key_label: keyLabel, duration_ms: Date.now() - chatStartMs, response_chars: accumulated.length } });
          }
          sseWrite(res, { done: true, result: accumulated, provider: "gemini", model, key: keyLabel });
          clearInterval(keepAlive);
          res.end();
          return true;
        }

        if (accumulated) {
          errors.push(`Gemini/${keyLabel}/${model}: response too short or missing structure (${accumulated.length} chars)`);
          console.warn(`Gemini/${keyLabel}/${model}: failed validation — resetting client and trying next`);
          // Discard the partial/invalid streamed content on the client before retrying
          sseWrite(res, { reset: true });
        } else {
          errors.push(`Gemini/${keyLabel}/${model}: empty response`);
        }
      } catch (err: any) {
        errors.push(`Gemini/${keyLabel}/${model} threw: ${err?.message ?? String(err)}`);
        console.warn(`Gemini/${keyLabel}/${model} threw — trying next`);
      }
    }
    return false;
  }

  // Try all Gemini keys in order — translation uses TRANSCRIBE pool, everything else uses REPORT pool
  for (let i = 0; i < activeKeys.length; i++) {
    const keyLabel = isTranslationTask ? `GEMINI_TRANSCRIBE_${i + 1}` : `GEMINI_REPORT_${i + 1}`;
    if (await tryGeminiStreaming(activeKeys[i], keyLabel)) return;
    if (i < activeKeys.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // ── Groq STREAMING — fallback after all Gemini keys exhausted ────────────
  if (groqKey) {
    const groqModels = [
      { id: "llama-3.3-70b-versatile", maxTokens: 32768 },
      { id: "llama-3.1-8b-instant",    maxTokens: 8192 },
    ];
    for (const { id: groqModel, maxTokens } of groqModels) {
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
          body: JSON.stringify({ model: groqModel, messages, max_tokens: maxTokens, temperature: 0.35, stream: true }),
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => "");
          errors.push(`Groq/${groqModel} ${r.status}: ${errText.slice(0, 120)}`);
          if (r.status === 401 || r.status === 403) break;
          continue;
        }

        const reader = r.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";
        let truncatedByLength = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;
            try {
              const chunk = JSON.parse(jsonStr) as { choices?: { delta?: { content?: string }; finish_reason?: string }[] };
              const text = chunk.choices?.[0]?.delta?.content ?? "";
              const finishReason = chunk.choices?.[0]?.finish_reason;
              if (text) {
                accumulated += text;
                sseWrite(res, { chunk: text });
              }
              if (finishReason === "length") {
                truncatedByLength = true;
                console.warn(`Groq/${groqModel}: hit max_tokens (${maxTokens}) — response truncated, skipping to next provider`);
              }
            } catch { /* skip */ }
          }
        }

        if (truncatedByLength) {
          errors.push(`Groq/${groqModel}: truncated at max_tokens (${maxTokens}) — report incomplete`);
          // Discard partial content on the client before trying the next model
          sseWrite(res, { reset: true });
          continue;
        }
        if (accumulated && isValidClinicalResponse(accumulated, skipValidation)) {
          if (env && userId && !isUtilityTask) {
            logAuditEvent(env.url, env.key, { userId, action: "report_generation_succeeded", resourceType: "report", ip: getRequestIp(req), details: { provider: "groq", model: groqModel, duration_ms: Date.now() - chatStartMs, response_chars: accumulated.length } });
          }
          sseWrite(res, { done: true, result: accumulated, provider: "groq-fallback", model: groqModel });
          clearInterval(keepAlive);
          res.end();
          return;
        }
        if (accumulated) {
          errors.push(`Groq/${groqModel}: response failed validation (${accumulated.length} chars)`);
          // Discard the partial/invalid streamed content on the client before retrying
          sseWrite(res, { reset: true });
        } else {
          errors.push(`Groq/${groqModel}: empty response`);
        }
      } catch (err: any) {
        errors.push(`Groq/${groqModel} threw: ${err?.message ?? String(err)}`);
        continue;
      }
    }
  } else {
    errors.push("Groq key not configured");
  }

  // ── Attempt 3: OpenAI STREAMING ───────────────────────────────────────────
  if (!openaiKey) {
    clearInterval(keepAlive);
    // Build a specific, actionable error so the doctor knows exactly what to fix.
    const allGeminiRateLimited = geminiAttempts > 0 && gemini429Count === geminiAttempts;
    const noFallbackConfigured = !groqKey && !openaiKey;
    const rateLimitMsg = allGeminiRateLimited && noFallbackConfigured
      ? "Your Gemini AI keys are temporarily rate-limited (too many requests in a short period). " +
        "To keep generating reports, add a GROQ_API_KEY or OPENAI_API_KEY in Vercel → Settings → Environment Variables, then redeploy. " +
        "Groq is free at console.groq.com. Alternatively wait 1–2 minutes and try again."
      : "Report generation temporarily unavailable — all AI services failed. Please try again in a moment.";
    console.error("[sphota/chat] All providers exhausted:", errors.join(" | "));
    if (env && userId && !isUtilityTask) {
      logAuditEvent(env.url, env.key, { userId, action: "report_generation_failed", resourceType: "report", ip: getRequestIp(req), details: { error_summary: "All providers exhausted (no OpenAI key)", providers_tried: errors } });
    }
    sseWrite(res, { error: rateLimitMsg, debug: process.env.NODE_ENV !== "production" ? errors : undefined });
    res.end();
    return;
  }

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: "gpt-4o", messages, max_tokens: 16384, stream: true }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      throw new Error(`OpenAI ${r.status}: ${errText.slice(0, 120)}`);
    }

    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let buffer = "";
    let openaiTruncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const chunk = JSON.parse(jsonStr) as { choices?: { delta?: { content?: string }; finish_reason?: string }[] };
          const text = chunk.choices?.[0]?.delta?.content ?? "";
          const finishReason = chunk.choices?.[0]?.finish_reason;
          if (text) {
            accumulated += text;
            sseWrite(res, { chunk: text });
          }
          if (finishReason === "length") {
            openaiTruncated = true;
            console.warn("OpenAI/gpt-4o: hit max_tokens (16384) — response truncated");
          }
        } catch { /* skip */ }
      }
    }

    if (openaiTruncated) {
      sseWrite(res, { error: "Report generation returned an incomplete response (token limit reached) — please try again." });
    } else if (accumulated && isValidClinicalResponse(accumulated, skipValidation)) {
      if (env && userId && !isUtilityTask) {
        logAuditEvent(env.url, env.key, { userId, action: "report_generation_succeeded", resourceType: "report", ip: getRequestIp(req), details: { provider: "openai", model: "gpt-4o", duration_ms: Date.now() - chatStartMs, response_chars: accumulated.length } });
      }
      sseWrite(res, { done: true, result: accumulated, provider: "openai-fallback" });
    } else {
      sseWrite(res, { error: "Report generation returned an incomplete response — please try again." });
    }
    clearInterval(keepAlive);
    res.end();
  } catch (err: any) {
    errors.push(`OpenAI threw: ${err?.message ?? String(err)}`);
    console.error("[sphota/chat] All providers failed:", errors.join(" | "));
    clearInterval(keepAlive);
    if (env && userId && !isUtilityTask) {
      logAuditEvent(env.url, env.key, { userId, action: "report_generation_failed", resourceType: "report", ip: getRequestIp(req), details: { error_summary: "All providers exhausted (Gemini + Groq + OpenAI)", providers_tried: errors } });
    }
    const allGeminiRateLimited2 = geminiAttempts > 0 && gemini429Count === geminiAttempts;
    const finalMsg = allGeminiRateLimited2
      ? "Your Gemini AI keys are temporarily rate-limited. Add a GROQ_API_KEY or OPENAI_API_KEY in Vercel → Settings → Environment Variables and redeploy. Groq is free at console.groq.com."
      : "Report generation temporarily unavailable — all AI services failed. Please try again in a moment.";
    sseWrite(res, { error: finalMsg, debug: process.env.NODE_ENV !== "production" ? errors : undefined });
    res.end();
  }
}
