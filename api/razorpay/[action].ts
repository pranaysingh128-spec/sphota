import { createHmac } from "crypto";
import { setCors, getSupabaseEnv, verifySupabaseToken } from "../_shared";

// ── Plan config ──────────────────────────────────────────────────────────────
const PLAN_AMOUNTS: Record<string, number> = {
  starter:  99900,   // ₹999 in paise
  clinical: 249900,  // ₹2499 in paise
  premium:  399900,  // ₹3999 in paise
};
const VALID_PLANS = Object.keys(PLAN_AMOUNTS);

function verifySignature(orderId: string, paymentId: string, signature: string, secret: string): boolean {
  const body = `${orderId}|${paymentId}`;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return expected === signature;
}

export default async function handler(req: any, res: any) {
  if (setCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

  // Route by ?action= query param OR by the last segment of the URL path
  const action: string =
    (req.query?.action as string) ||
    (req.url as string || "").split("?")[0].split("/").pop() ||
    "";

  if (action === "create-order") {
    return handleCreateOrder(req, res);
  } else if (action === "verify") {
    return handleVerify(req, res);
  } else {
    return res.status(400).json({ message: `Unknown action: ${action}` });
  }
}

// ── Create Order ─────────────────────────────────────────────────────────────
async function handleCreateOrder(req: any, res: any) {
  const keyId     = process.env.RAZORPAY_KEY_ID     ?? "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
  if (!keyId || !keySecret) {
    console.error("[razorpay/create-order] Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET");
    return res.status(503).json({ message: "Payment system is not configured. Please contact support." });
  }

  const env = getSupabaseEnv();
  if (!env) return res.status(503).json({ message: "Server configuration error." });

  const token = (req.headers["authorization"] ?? "").replace("Bearer ", "");
  const userId = await verifySupabaseToken(token, env.url, env.key);
  if (!userId) return res.status(401).json({ message: "Unauthorized" });

  const body = req.body ?? {};
  const planId = typeof body.planId === "string" ? body.planId : "";
  if (!PLAN_AMOUNTS[planId]) {
    return res.status(400).json({ message: `Invalid planId: ${planId}` });
  }

  const amount   = PLAN_AMOUNTS[planId];
  const currency = "INR";
  const receipt  = `sphota_${planId}_${userId.slice(0, 8)}_${Date.now()}`;
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  try {
    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({ amount, currency, receipt }),
    });

    if (!rzpRes.ok) {
      const errBody = await rzpRes.text().catch(() => "");
      console.error("[razorpay/create-order] Razorpay error:", rzpRes.status, errBody.slice(0, 300));
      return res.status(502).json({ message: "Failed to create payment order. Please try again." });
    }

    const order = await rzpRes.json() as { id: string; amount: number; currency: string };
    return res.json({
      orderId:  order.id,
      keyId,
      amount:   order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error("[razorpay/create-order] threw:", err instanceof Error ? err.message : err);
    return res.status(502).json({ message: "Payment service unavailable. Please try again later." });
  }
}

// ── Verify Payment ────────────────────────────────────────────────────────────
async function handleVerify(req: any, res: any) {
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
  if (!keySecret) {
    console.error("[razorpay/verify] Missing RAZORPAY_KEY_SECRET");
    return res.status(503).json({ message: "Payment system not configured." });
  }

  const env = getSupabaseEnv();
  if (!env) return res.status(503).json({ message: "Server configuration error." });

  const token = (req.headers["authorization"] ?? "").replace("Bearer ", "");
  const userId = await verifySupabaseToken(token, env.url, env.key);
  if (!userId) return res.status(401).json({ message: "Unauthorized" });

  const body = req.body ?? {};
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = body as {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
    planId: string;
  };

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ message: "Missing payment fields." });
  }
  if (!VALID_PLANS.includes(planId)) {
    return res.status(400).json({ message: "Invalid plan." });
  }

  const valid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature, keySecret);
  if (!valid) {
    console.warn("[razorpay/verify] Signature mismatch for userId:", userId, "orderId:", razorpay_order_id);
    return res.status(400).json({ message: "Payment signature verification failed." });
  }

  const planExpiresAt = new Date();
  planExpiresAt.setMonth(planExpiresAt.getMonth() + 1);

  try {
    const updateRes = await fetch(
      `${env.url}/rest/v1/doctors?id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.key}`,
          apikey: env.key,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          plan: planId,
          plan_expires_at: planExpiresAt.toISOString(),
        }),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text().catch(() => "");
      console.error("[razorpay/verify] Failed to update plan:", updateRes.status, errText.slice(0, 200));
      return res.status(500).json({ message: "Payment verified but plan update failed. Please contact support." });
    }

    // Record in subscriptions table (best-effort)
    fetch(`${env.url}/rest/v1/subscriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.key}`,
        apikey: env.key,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: userId,
        plan: planId,
        razorpay_order_id,
        razorpay_payment_id,
        amount_paise: PLAN_AMOUNTS[planId],
        currency: "INR",
        status: "active",
        current_period_start: new Date().toISOString(),
        current_period_end: planExpiresAt.toISOString(),
      }),
    }).catch(err => console.warn("[razorpay/verify] subscriptions insert failed:", err?.message ?? err));

    return res.json({ success: true, plan: planId, expiresAt: planExpiresAt.toISOString() });
  } catch (err) {
    console.error("[razorpay/verify] threw:", err instanceof Error ? err.message : err);
    return res.status(500).json({ message: "Internal error. Please contact support." });
  }
}
