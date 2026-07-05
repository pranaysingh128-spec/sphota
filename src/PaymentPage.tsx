import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase";

type UserPlan = "starter" | "clinical" | "premium";

interface PlanInfo {
  id: UserPlan;
  name: string;
  price: number;
  desc: string;
  features: string[];
  excluded: string[];
  color: string;
  featured?: boolean;
}

const PLANS: PlanInfo[] = [
  {
    id: "starter",
    name: "Starter",
    price: 999,
    desc: "75 sessions/month for solo practitioners.",
    features: [
      "75 sessions/month",
      "Voice transcription",
      "SOAP · BIRP · DAP · Custom notes",
      "Patient letters (Hindi & English)",
      "Medication tracking",
      "Patient progress tracking (PHQ-9 / GAD-7)",
      "Smart follow-up scheduling",
      "Full report history",
    ],
    excluded: [
      "Paper record scanner",
      "DSM / ICD inline descriptions",
      "Medication mechanism descriptions",
      "WhatsApp patient notifications",
      "Patient letters in other languages",
    ],
    color: "#3b82f6",
  },
  {
    id: "clinical",
    name: "Clinical",
    price: 2499,
    desc: "Unlimited sessions. Full clinical workflow.",
    features: [
      "Unlimited sessions",
      "Everything in Starter",
      "Patient letters in 6 languages",
      "Paper record scanner",
      "WhatsApp patient notifications",
      "Advanced dashboard analytics",
    ],
    excluded: [
      "DSM / ICD inline descriptions",
      "Medication mechanism descriptions",
    ],
    color: "#10b981",
    featured: true,
  },
  {
    id: "premium",
    name: "Premium",
    price: 3999,
    desc: "Everything. No restrictions. Priority support.",
    features: [
      "Everything in Clinical",
      "DSM-5-TR / ICD-11 inline references",
      "Medication mechanism & monitoring notes",
      "Priority support (personal response)",
      "Early access to new features",
    ],
    excluded: [],
    color: "#f59e0b",
  },
];

function loadRazorpayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as Record<string, unknown>)["Razorpay"]) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load payment processor. Check your internet connection."));
    document.body.appendChild(script);
  });
}

function FeedbackPopup({ onDismiss }: { onDismiss: () => void }) {
  const [secsLeft, setSecsLeft] = useState(7);
  useEffect(() => {
    const interval = setInterval(() => {
      setSecsLeft(s => {
        if (s <= 1) { clearInterval(interval); onDismiss(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [onDismiss]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)",
      padding: 16,
    }}>
      <div style={{
        background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
        border: "1px solid rgba(16,185,129,0.4)",
        borderRadius: 20,
        padding: "32px 28px 24px",
        maxWidth: 420,
        width: "100%",
        textAlign: "center",
        position: "relative",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(16,185,129,0.2)",
      }}>
        <button
          onClick={onDismiss}
          style={{
            position: "absolute", top: 12, right: 12,
            background: "rgba(255,255,255,0.08)", border: "none", color: "#94a3b8",
            width: 32, height: 32, borderRadius: "50%", cursor: "pointer",
            fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          ×
        </button>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
        <h2 style={{ color: "#f1f5f9", fontSize: 20, fontWeight: 800, margin: "0 0 12px", lineHeight: 1.3 }}>
          Congratulations on upgrading!
        </h2>
        <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.7, margin: "0 0 20px" }}>
          As a valued early user, if you fill the{" "}
          <strong style={{ color: "#10b981" }}>feedback form</strong> with honesty,
          you will get{" "}
          <strong style={{ color: "#f59e0b" }}>unlimited access till 9th July</strong>{" "}
          — completely on us. 🙏
        </p>
        <div style={{
          background: "rgba(16,185,129,0.1)",
          border: "1px solid rgba(16,185,129,0.25)",
          borderRadius: 10,
          padding: "10px 16px",
          fontSize: 12,
          color: "#6ee7b7",
          marginBottom: 8,
        }}>
          This message will close in <strong>{secsLeft}s</strong>
        </div>
      </div>
    </div>
  );
}

export default function PaymentPage({
  doctorId: _doctorId,
  onSuccess,
  onBack,
}: {
  doctorId: string;
  onSuccess: (plan: UserPlan, expiresAt: string) => void;
  onBack: () => void;
}) {
  const [selectedPlan, setSelectedPlan] = useState<UserPlan>(() => {
    const stored = localStorage.getItem("sphota_pending_plan") ?? sessionStorage.getItem("sphota_pending_plan_session");
    return stored === "starter" || stored === "clinical" || stored === "premium" ? stored : "clinical";
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showFeedbackPopup, setShowFeedbackPopup] = useState(false);

  const plan = PLANS.find(p => p.id === selectedPlan)!;

  function handlePlanSelect(planId: UserPlan) {
    setSelectedPlan(planId);
    setShowFeedbackPopup(true);
  }

  async function handlePay() {
    setLoading(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";

      const orderRes = await fetch("/api/razorpay/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ planId: selectedPlan, amount: plan.price * 100, currency: "INR" }),
      });

      if (!orderRes.ok) {
        const errText = await orderRes.text().catch(() => "");
        let errMsg = "Failed to create payment order. Please try again.";
        try { const p = JSON.parse(errText) as { message?: string }; if (p.message) errMsg = p.message; } catch { /* use default */ }
        if (orderRes.status === 503) errMsg = "Payments are not yet active. Please contact support at getsphota@gmail.com.";
        throw new Error(errMsg);
      }

      const { orderId, keyId, amount, currency } = await orderRes.json() as {
        orderId: string; keyId: string; amount: number; currency: string;
      };

      await loadRazorpayScript();

      const options = {
        key: keyId,
        amount,
        currency,
        name: "Sphota",
        description: `${plan.name} Plan — Monthly`,
        order_id: orderId,
        handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          const verifyRes = await fetch("/api/razorpay/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              planId: selectedPlan,
            }),
          });
          if (!verifyRes.ok) {
            setError("Payment verification failed. Please contact support at getsphota@gmail.com.");
            setLoading(false);
            return;
          }
          const verifyData = await verifyRes.json().catch(() => ({})) as { plan?: string; expiresAt?: string };
          localStorage.removeItem("sphota_pending_plan");
          sessionStorage.removeItem("sphota_pending_plan_session");
          onSuccess(selectedPlan, verifyData.expiresAt ?? "");
        },
        prefill: {},
        theme: { color: plan.color },
        modal: {
          ondismiss: () => setLoading(false),
        },
      };

      const rzpCtor = (window as unknown as Record<string, unknown>)["Razorpay"] as new (o: typeof options) => { open(): void };
      const rzp = new rzpCtor(options);
      rzp.open();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Payment failed. Please try again.";
      setError(msg);
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#060910",
      color: "#e4eaf5",
      fontFamily: "'DM Sans', 'Inter', sans-serif",
      display: "flex",
      flexDirection: "column",
      overflowY: "auto",
    }}>
      {showFeedbackPopup && (
        <FeedbackPopup onDismiss={() => setShowFeedbackPopup(false)} />
      )}

      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 32px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(6,9,16,0.95)",
        backdropFilter: "blur(12px)",
        position: "sticky",
        top: 0,
        zIndex: 50,
        flexShrink: 0,
      }}>
        <button
          onClick={onBack}
          style={{
            background: "none", border: "none", color: "#94a3b8",
            cursor: "pointer", fontSize: 13, display: "flex",
            alignItems: "center", gap: 6, padding: "8px 0",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M12 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to App
        </button>
        <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", color: "#f1f5f9" }}>
          Sphota<span style={{ color: "#4d9fff" }}>.</span>
        </span>
        <div style={{ width: 90 }} />
      </header>

      <div style={{
        flex: 1,
        padding: "40px 24px",
        maxWidth: 960,
        margin: "0 auto",
        width: "100%",
        boxSizing: "border-box",
      }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8, color: "#f1f5f9" }}>
            Choose your plan
          </h1>
          <p style={{ color: "#94a3b8", fontSize: 15 }}>
            No per-session charges. Flat monthly rate. Cancel anytime.
          </p>
        </div>

        {/* Plans grid — scrollable on mobile */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          gap: 16,
          marginBottom: 36,
        }}>
          {PLANS.map(p => {
            const isSelected = selectedPlan === p.id;
            return (
              <div
                key={p.id}
                onClick={() => handlePlanSelect(p.id)}
                style={{
                  border: isSelected
                    ? `2px solid ${p.color}`
                    : "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 16,
                  padding: "24px 20px",
                  background: isSelected
                    ? `rgba(${p.color === "#3b82f6" ? "59,130,246" : p.color === "#10b981" ? "16,185,129" : "245,158,11"}, 0.06)`
                    : "rgba(255,255,255,0.02)",
                  cursor: "pointer",
                  position: "relative",
                  transition: "all 0.18s",
                  boxShadow: isSelected ? `0 0 0 3px ${p.color}22` : "none",
                }}
              >
                {p.featured && (
                  <div style={{
                    position: "absolute",
                    top: -13,
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: p.color,
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "3px 16px",
                    borderRadius: 20,
                    whiteSpace: "nowrap",
                  }}>
                    Most popular
                  </div>
                )}

                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4, color: "#f1f5f9" }}>{p.name}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 2, marginBottom: 10 }}>
                  <span style={{ fontSize: 13, color: p.color, fontWeight: 600 }}>₹</span>
                  <span style={{ fontSize: 30, fontWeight: 800, color: "#f1f5f9" }}>
                    {p.price.toLocaleString("en-IN")}
                  </span>
                  <span style={{ fontSize: 12, color: "#64748b" }}>/mo</span>
                </div>
                <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16, lineHeight: 1.5 }}>{p.desc}</p>

                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {p.features.map(f => (
                    <div key={f} style={{ display: "flex", gap: 8, fontSize: 12, color: "#94a3b8", alignItems: "flex-start" }}>
                      <span style={{ color: p.color, flexShrink: 0, fontWeight: 700, marginTop: 1 }}>✓</span>
                      {f}
                    </div>
                  ))}
                  {p.excluded.map(f => (
                    <div key={f} style={{ display: "flex", gap: 8, fontSize: 12, color: "#3a4558", alignItems: "flex-start" }}>
                      <span style={{ flexShrink: 0, marginTop: 1 }}>✗</span>
                      {f}
                    </div>
                  ))}
                </div>

                {isSelected && (
                  <div style={{ marginTop: 14, textAlign: "center", fontSize: 11, fontWeight: 700, color: p.color }}>
                    ✓ Selected
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16,
          padding: "24px 28px",
          maxWidth: 480,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#f1f5f9" }}>{plan.name} Plan</div>
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Billed monthly · Cancel anytime</div>
            </div>
            <div style={{ fontWeight: 800, fontSize: 24, color: "#f1f5f9" }}>
              ₹{plan.price.toLocaleString("en-IN")}
              <span style={{ fontSize: 13, fontWeight: 400, color: "#64748b" }}>/mo</span>
            </div>
          </div>

          {error && (
            <div style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13,
              color: "#f87171",
            }}>
              {error}
            </div>
          )}

          <button
            onClick={handlePay}
            disabled={loading}
            style={{
              padding: "14px",
              borderRadius: 10,
              border: "none",
              background: loading ? "#1e2940" : plan.color,
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.7 : 1,
              transition: "all 0.2s",
              boxShadow: loading ? "none" : `0 8px 24px ${plan.color}40`,
            }}
          >
            {loading ? "Processing…" : `Pay ₹${plan.price.toLocaleString("en-IN")} →`}
          </button>

          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            fontSize: 11,
            color: "#475569",
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Secured by Razorpay · 256-bit SSL encryption
          </div>
        </div>

        <p style={{ textAlign: "center", marginTop: 24, fontSize: 12, color: "#334155", lineHeight: 1.6 }}>
          Payments are processed and settled by Razorpay to your registered bank account.<br />
          Questions? Email <a href="mailto:getsphota@gmail.com" style={{ color: "#64748b" }}>getsphota@gmail.com</a>
        </p>
      </div>
    </div>
  );
}
