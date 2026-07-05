export const config = { runtime: "nodejs" };

// /api/report-review
//   POST with body { type: "review", sessionId, entryId }
//     → log psychiatrist's "I have reviewed this AI-generated report" confirmation
//   POST with body { type: "client_error", message, stack, context }
//     → log client-side error + send WhatsApp alert to admin

import { sendWhatsAppAlert } from "./_shared";

function setCors(req: any, res: any): boolean {
  const origin: string = req.headers["origin"] ?? "";
  if (!origin) {
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") { res.status(204).end(); return true; }
    return false;
  }
  const allowed = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const isVercelPreview = origin.endsWith(".vercel.app");
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const isAllowed = isLocalhost || process.env.NODE_ENV !== "production" || isVercelPreview || allowed.includes(origin);
  res.setHeader("Access-Control-Allow-Origin", isAllowed ? origin : "null");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

function getRequestIp(req: any): string {
  return ((req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "") as string).split(",")[0].trim();
}

function logAuditEvent(supabaseUrl: string, serviceKey: string, event: any): void {
  fetch(`${supabaseUrl}/rest/v1/audit_logs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: event.userId || null,
      action: event.action,
      resource_type: event.resourceType ?? null,
      resource_id: event.resourceId ?? null,
      ip: event.ip ?? null,
      user_agent: event.userAgent ?? null,
      details: event.details ?? null,
    }),
  }).catch(() => { /* best-effort */ });
}

export default async function handler(req: any, res: any) {
  try {
    if (setCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

    const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "").replace(/^(?!https?:\/\/)/, "https://");
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!supabaseUrl || supabaseUrl === "https://") {
      return res.status(200).json({ ok: true, _warn: "misconfigured" });
    }

    let body: any = {};
    try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {}); } catch { body = {}; }

    const requestType = body.type ?? "review";

    // ── Client-side error report ──────────────────────────────────────────────
    if (requestType === "client_error") {
      const { message = "Unknown error", stack = "", context = {} } = body;
      const ip = getRequestIp(req);
      const userAgent = req.headers["user-agent"] ?? "";

      // Log to Supabase audit_logs if configured
      if (serviceKey) {
        logAuditEvent(supabaseUrl, serviceKey, {
          userId: body.userId ?? null,
          action: "client_error",
          resourceType: "frontend",
          resourceId: null,
          ip,
          userAgent,
          details: { message, stack: stack.slice(0, 2000), context, reportedAt: new Date().toISOString() },
        });
      }

      // Send WhatsApp alert (best-effort)
      const alertText = [
        `Error: ${message.slice(0, 200)}`,
        `User: ${body.userId ?? "unknown"}`,
        `Page: ${context.path ?? "unknown"}`,
        `UA: ${userAgent.slice(0, 80)}`,
        `IP: ${ip}`,
        `Time: ${new Date().toISOString()}`,
      ].join("\n");
      await sendWhatsAppAlert(alertText);

      return res.status(200).json({ ok: true });
    }

    // ── Report review confirmation ────────────────────────────────────────────
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return res.status(401).json({ message: "Unauthenticated" });

    let userId = "";
    try {
      const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: serviceKey || process.env.VITE_SUPABASE_ANON_KEY || "" },
      });
      if (!authRes.ok) return res.status(401).json({ message: "Unauthenticated" });
      const user = await authRes.json() as { id?: string };
      userId = user?.id ?? "";
      if (!userId) return res.status(401).json({ message: "Unauthenticated" });
    } catch {
      return res.status(401).json({ message: "Unauthenticated" });
    }

    const { sessionId, entryId } = body;
    const reviewedAt = new Date().toISOString();

    if (serviceKey) {
      logAuditEvent(supabaseUrl, serviceKey, {
        userId,
        action: "report_review_confirmed",
        resourceType: "report",
        resourceId: entryId ?? sessionId ?? null,
        ip: getRequestIp(req),
        userAgent: req.headers["user-agent"] ?? "",
        details: {
          statement: "I have reviewed this system-generated report, verified its accuracy, and take full clinical responsibility for its contents.",
          sessionId: sessionId ?? null,
          entryId: entryId ?? null,
          reviewedAt,
        },
      });
    }

    return res.status(200).json({ ok: true, reviewedAt });
  } catch (err) {
    console.error("[sphota/report-review] Unhandled error:", err);
    return res.status(200).json({ ok: true, _warn: "unhandled_error" });
  }
}
