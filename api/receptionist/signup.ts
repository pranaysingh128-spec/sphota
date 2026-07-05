export const config = { runtime: "nodejs" };

// ── Self-contained: no _shared import so Vercel bundles this cleanly ──────────

// In-memory rate limit: max 5 signup attempts per IP per 15 minutes
const signupAttempts = new Map<string, { count: number; windowStart: number }>();
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;

function checkSignupRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = signupAttempts.get(ip);
  if (!entry || now - entry.windowStart > SIGNUP_WINDOW_MS) {
    signupAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > SIGNUP_LIMIT;
}

function setCors(req: any, res: any): boolean {
  const origin: string = req.headers["origin"] ?? "";
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

// Safe JSON fetch — never throws, always returns { ok, status, data }
async function safeFetch(url: string, options: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const r = await fetch(url, options);
    const text = await r.text().catch(() => "");
    let data: any = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    }
    return { ok: r.ok, status: r.status, data };
  } catch (err: any) {
    console.error("[signup/safeFetch] Network error:", err?.message ?? err);
    return { ok: false, status: 0, data: { _error: err?.message ?? String(err) } };
  }
}

export default async function handler(req: any, res: any) {
  // Wrap entire handler in try/catch so no unhandled exception ever escapes
  try {
    if (setCors(req, res)) return;

    if (req.method !== "POST") {
      return res.status(405).json({ message: "Method not allowed" });
    }

    // Rate limit by IP
    const ip = ((req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "") as string)
      .split(",")[0].trim();
    if (checkSignupRateLimit(ip)) {
      return res.status(429).json({ message: "Too many signup attempts. Please try again in 15 minutes." });
    }

    // Body parsing
    let body: any = {};
    try {
      body = req.body ?? {};
      if (typeof body === "string") {
        body = body.trim() ? JSON.parse(body) : {};
      }
    } catch {
      return res.status(400).json({ message: "Invalid JSON body" });
    }

    const { inviteCode, email, password } = body;

    if (!inviteCode || !email || !password) {
      return res.status(400).json({ message: "Invite code, email and password are required" });
    }
    if (typeof inviteCode !== "string" || typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Invalid request data" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    let url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!url || !key) {
      console.error("[signup] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return res.status(500).json({ message: "Server not configured — missing Supabase credentials. Contact support." });
    }
    if (!url.startsWith("http")) url = "https://" + url;

    const cleanEmail = email.toLowerCase().trim();
    const cleanInviteCode = inviteCode.trim();

    // ── Step 1: Verify invite exists ────────────────────────────────────────
    const inviteRes = await safeFetch(
      `${url}/rest/v1/receptionist_invites?id=eq.${encodeURIComponent(cleanInviteCode)}&email=eq.${encodeURIComponent(cleanEmail)}&used=eq.false&select=id,doctor_user_id`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
          "apikey": key,
          "Accept": "application/json",
        },
      }
    );

    if (!inviteRes.ok) {
      const detail = JSON.stringify(inviteRes.data ?? "").slice(0, 200);
      console.error("[signup] Step1 invite lookup failed:", inviteRes.status, detail);
      if (inviteRes.status === 404) {
        return res.status(500).json({ message: "Invite system not set up on server. Contact support." });
      }
      return res.status(500).json({ message: `Could not verify invite (DB error ${inviteRes.status}). Please try again.` });
    }

    const inviteList = Array.isArray(inviteRes.data) ? inviteRes.data : [];
    const invite = inviteList[0] ?? null;

    if (!invite) {
      return res.status(404).json({ message: "Invite not found or already used. Ask your doctor for a new invite link." });
    }
    const linkedDoctorId = String(invite.doctor_user_id ?? "");
    if (!linkedDoctorId) {
      return res.status(500).json({ message: "Invite is missing doctor reference. Please request a new invite." });
    }

    // ── Step 2: Create the auth user via admin API ───────────────────────────
    const createRes = await safeFetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
        "apikey": key,
      },
      body: JSON.stringify({ email: cleanEmail, password, email_confirm: true }),
    });

    let userId: string | null = createRes.data?.id ?? null;

    if (!createRes.ok || !userId) {
      const errMsg = String(
        createRes.data?.msg ?? createRes.data?.message ?? createRes.data?.error_description ??
        createRes.data?.error ?? createRes.data?._error ?? ""
      );
      console.warn("[signup] Step2 create user failed:", createRes.status, errMsg);

      const alreadyExists =
        errMsg.toLowerCase().includes("already") ||
        errMsg.toLowerCase().includes("registered") ||
        errMsg.toLowerCase().includes("exists") ||
        createRes.status === 422;

      if (alreadyExists) {
        // User already exists — find them by listing
        const listRes = await safeFetch(`${url}/auth/v1/admin/users?page=1&per_page=1000`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
            "apikey": key,
          },
        });

        if (listRes.ok) {
          const users: any[] = listRes.data?.users ?? [];
          const existingUser = users.find(
            (u: any) => (u.email ?? "").toLowerCase() === cleanEmail
          );

          if (existingUser) {
            // Guard: don't overwrite a doctor account
            const doctorCheck = await safeFetch(
              `${url}/rest/v1/doctors?id=eq.${encodeURIComponent(existingUser.id)}&select=role`,
              {
                method: "GET",
                headers: {
                  "Authorization": `Bearer ${key}`,
                  "apikey": key,
                  "Accept": "application/json",
                },
              }
            );
            const existingRole = Array.isArray(doctorCheck.data) ? (doctorCheck.data[0]?.role ?? null) : null;
            if (existingRole === "doctor") {
              return res.status(400).json({
                message: "This email is already registered as a doctor account. Please use a different email.",
              });
            }

            userId = existingUser.id;

            // Update password
            await safeFetch(`${url}/auth/v1/admin/users/${existingUser.id}`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${key}`,
                "apikey": key,
              },
              body: JSON.stringify({ password, email_confirm: true }),
            });
          }
        } else {
          console.error("[signup] Step2 list users failed:", listRes.status, JSON.stringify(listRes.data));
        }
      } else {
        return res.status(400).json({ message: errMsg || "Could not create account. Please try again." });
      }
    }

    if (!userId) {
      return res.status(500).json({ message: "Could not create or find user account. Please try again." });
    }

    // ── Step 3: Upsert doctors row ──────────────────────────────────────────
    const upsertRes = await safeFetch(`${url}/rest/v1/doctors`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
        "apikey": key,
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ id: userId, role: "receptionist", linked_doctor_id: linkedDoctorId }),
    });

    if (!upsertRes.ok) {
      console.warn("[signup] Step3 doctors upsert failed:", upsertRes.status, JSON.stringify(upsertRes.data));
      // Non-fatal: continue — role resolution has a fallback
    }

    // ── Step 4: Mark invite as accepted ────────────────────────────────────
    const patchRes = await safeFetch(
      `${url}/rest/v1/receptionist_invites?id=eq.${encodeURIComponent(cleanInviteCode)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
          "apikey": key,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({ used: true }),
      }
    );

    if (!patchRes.ok) {
      console.warn("[signup] Step4 invite patch failed:", patchRes.status, JSON.stringify(patchRes.data));
      // Non-fatal — user is created successfully
    }

    return res.status(200).json({ ok: true, userId, linkedDoctorId });

  } catch (err: any) {
    // Catch-all: this should never happen but guarantees a JSON response, not an HTML 500
    const msg = err?.message ?? String(err);
    console.error("[signup] Unhandled exception:", msg);
    return res.status(500).json({ message: `Unexpected server error: ${msg}` });
  }
}
