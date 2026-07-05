import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase";

// ── SQL to run once in Supabase dashboard ──────────────────────────────────
// CREATE TABLE IF NOT EXISTS beta_feedback (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   role text,
//   ratings jsonb,
//   choices jsonb,
//   pricing_preference text,
//   open_answers jsonb,
//   contact jsonb,
//   submitted_at timestamptz DEFAULT now()
// );
// ALTER TABLE beta_feedback ENABLE ROW LEVEL SECURITY;
// CREATE POLICY "allow_anon_insert" ON beta_feedback FOR INSERT TO anon WITH CHECK (true);
// ──────────────────────────────────────────────────────────────────────────

type Role = "doctor" | "receptionist";

const TEAL   = "#14b8a6";
const NAVY   = "#080c18";
const CARD   = "#0f1624";
const CARD2  = "#121926";
const BORDER = "rgba(255,255,255,0.07)";
const TEXT1  = "#f0f4f8";
const TEXT2  = "#8898aa";
const TEXT3  = "#4a5568";

// ── Star component ─────────────────────────────────────────────────────────
function StarRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState(0);
  return (
    <div style={{ marginBottom: 22 }}>
      <p style={{ color: TEXT1, fontSize: 15, marginBottom: 10, fontWeight: 500 }}>{label}</p>
      <div style={{ display: "flex", gap: 8 }}>
        {[1,2,3,4,5].map(i => {
          const filled = i <= (hover || value);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onChange(i)}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(0)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: 2, transition: "transform 0.12s",
                transform: hover === i ? "scale(1.2)" : "scale(1)",
              }}
            >
              <svg width="30" height="30" viewBox="0 0 24 24" fill={filled ? "#f59e0b" : "none"}
                stroke={filled ? "#f59e0b" : TEXT3} strokeWidth="1.5">
                <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/>
              </svg>
            </button>
          );
        })}
        {value > 0 && (
          <span style={{ alignSelf: "center", color: TEAL, fontSize: 13, fontWeight: 600, marginLeft: 4 }}>
            {["","Poor","Fair","Good","Great","Excellent"][value]}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Pill selector ──────────────────────────────────────────────────────────
function PillGroup({ label, options, value, onChange }: {
  label: string; options: string[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <p style={{ color: TEXT1, fontSize: 15, marginBottom: 12, fontWeight: 500 }}>{label}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {options.map(opt => {
          const sel = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              style={{
                padding: "9px 18px",
                borderRadius: 999,
                border: sel ? `1.5px solid ${TEAL}` : `1.5px solid ${BORDER}`,
                background: sel ? `rgba(20,184,166,0.14)` : CARD2,
                color: sel ? TEAL : TEXT2,
                fontSize: 14,
                fontWeight: sel ? 600 : 400,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >{opt}</button>
          );
        })}
      </div>
    </div>
  );
}

// ── Pricing pill (larger, with subtitle) ──────────────────────────────────
function PricingPill({ plan, subtitle, value, onChange }: {
  plan: string; subtitle: string; value: string; onChange: (v: string) => void;
}) {
  const sel = value === plan;
  return (
    <button
      type="button"
      onClick={() => onChange(plan)}
      style={{
        flex: "1 1 calc(50% - 8px)",
        minWidth: 0,
        padding: "18px 16px",
        borderRadius: 14,
        border: sel ? `2px solid ${TEAL}` : `1.5px solid ${BORDER}`,
        background: sel ? `rgba(20,184,166,0.12)` : CARD2,
        color: sel ? TEXT1 : TEXT2,
        cursor: "pointer",
        textAlign: "left",
        transition: "all 0.15s",
        boxShadow: sel ? `0 0 0 3px rgba(20,184,166,0.08)` : "none",
      }}
    >
      <div style={{ fontSize: 17, fontWeight: 700, color: sel ? TEAL : TEXT1, marginBottom: 4 }}>{plan}</div>
      <div style={{ fontSize: 13, color: sel ? "rgba(20,184,166,0.8)" : TEXT3 }}>{subtitle}</div>
    </button>
  );
}

// ── Textarea ───────────────────────────────────────────────────────────────
function Textarea({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <p style={{ color: TEXT1, fontSize: 15, marginBottom: 10, fontWeight: 500 }}>{label}
      </p>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? "Your thoughts..."}
        rows={4}
        style={{
          width: "100%", background: CARD2, border: `1.5px solid ${BORDER}`,
          borderRadius: 12, padding: "12px 14px", color: TEXT1, fontSize: 14,
          resize: "vertical", outline: "none", fontFamily: "inherit", lineHeight: 1.6,
          transition: "border-color 0.15s",
        }}
        onFocus={e => { e.target.style.borderColor = TEAL; }}
        onBlur={e => { e.target.style.borderColor = BORDER; }}
      />
    </div>
  );
}

// ── Text input ─────────────────────────────────────────────────────────────
function TextInput({ label, value, onChange, placeholder, type = "text", optional = true }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; optional?: boolean;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <p style={{ color: TEXT1, fontSize: 15, marginBottom: 8, fontWeight: 500 }}>{label}
        {optional && <span style={{ color: TEXT3, fontSize: 12, fontWeight: 400, marginLeft: 8 }}>(optional)</span>}
      </p>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", background: CARD2, border: `1.5px solid ${BORDER}`,
          borderRadius: 10, padding: "11px 14px", color: TEXT1, fontSize: 14,
          outline: "none", fontFamily: "inherit",
          transition: "border-color 0.15s",
        }}
        onFocus={e => { e.target.style.borderColor = TEAL; }}
        onBlur={e => { e.target.style.borderColor = BORDER; }}
      />
    </div>
  );
}

// ── Checkmark SVG for closing screen ──────────────────────────────────────
function AnimatedCheck() {
  return (
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <div style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 72, height: 72, borderRadius: "50%",
        background: "rgba(20,184,166,0.15)", border: `2px solid ${TEAL}`,
        animation: "pop 0.4s cubic-bezier(0.175,0.885,0.32,1.275) both",
      }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
          <path d="M5 13l4 4L19 7" stroke={TEAL} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ strokeDasharray: 30, strokeDashoffset: 0, animation: "draw 0.4s 0.2s ease both" }}/>
        </svg>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function FeedbackPage() {
  const role: Role = (new URLSearchParams(window.location.search).get("role") as Role) ?? "doctor";

  type Screen = "intro" | "questions" | "closing";
  const [screen,       setScreen]       = useState<Screen>("intro");
  const [sectionIdx,   setSectionIdx]   = useState(0);
  const [animDir,      setAnimDir]      = useState<"fwd"|"back">("fwd");
  const [animating,    setAnimating]    = useState(false);

  const [ratings,      setRatings]      = useState<Record<string,number>>({});
  const [choices,      setChoices]      = useState<Record<string,string>>({});
  const [pricingChoice,setPricingChoice] = useState("");
  const [openAnswers,  setOpenAnswers]  = useState<Record<string,string>>({});
  const [contact,      setContact]      = useState({ name:"", whatsapp:"", email:"", canContact:"" });
  const [busy,         setBusy]         = useState(false);
  const [error,        setError]        = useState("");
  const [sectionError, setSectionError] = useState("");

  const TOTAL_SECTIONS = 5;

  const ratingQuestions = [
    { key: "overall",    label: "Overall experience with Sphota" },
    { key: "ease",       label: "Ease of use and navigation" },
    { key: "speed",      label: "Speed and performance of the app" },
    ...(role === "doctor" ? [
      { key: "ai_quality",  label: "Quality of smart-generated clinical reports" },
      { key: "waiting_room",label: "Usefulness of the waiting room feature" },
    ] : [
      { key: "checkin",     label: "Ease of checking in patients" },
    ]),
    { key: "workflow",   label: "How well it fits into your daily workflow" },
  ];

  const choiceQuestions = [
    { key: "frequency",  label: "How often do you use Sphota?",
      options: ["Daily","Few times a week","Weekly","Rarely"] },
    { key: "speed_compare", label: "Compared to your old documentation method, Sphota is:",
      options: ["Much faster","Slightly faster","Same","Slower"] },
    { key: "recommend",  label: "Would you recommend Sphota to a colleague?",
      options: ["Definitely","Probably","Not sure","No"] },
    { key: "pay",        label: "If Sphota launched officially, would you pay for it?",
      options: ["Yes, happily","Yes if priced right","Maybe","No"] },
  ];

  const pricingPlans = [
    { plan: "₹999/month",  subtitle: "Basic" },
    { plan: "₹1999/month", subtitle: "Standard" },
    { plan: "₹2999/month", subtitle: "Pro" },
    { plan: "₹3999/month", subtitle: "Full Suite" },
  ];

  const openQuestions = [
    { key: "likes",    label: "What do you like most about Sphota?",    placeholder: "The things that work well for you..." },
    { key: "improve",  label: "What frustrates you or needs improvement?",    placeholder: "Be honest — it helps!" },
    { key: "feature",  label: "What one feature would make you use this every single day?", placeholder: "Your dream feature..." },
    { key: "other",    label: "Anything else you want to tell the developer?",placeholder: "Anything at all..." },
  ];

  function validateCurrentSection(): string {
    if (sectionIdx === 0) {
      // All star ratings must be filled
      const missing = ratingQuestions.filter(q => !(ratings[q.key] > 0));
      if (missing.length > 0) {
        return `Please rate all areas before continuing. Missing: ${missing.map(q => q.label).join(", ")}.`;
      }
    }
    if (sectionIdx === 1) {
      // All quick-choice questions must be answered
      const missing = choiceQuestions.filter(q => !choices[q.key]);
      if (missing.length > 0) {
        return `Please answer all questions before continuing. Missing: ${missing.map(q => q.label).join(", ")}.`;
      }
    }
    if (sectionIdx === 2) {
      if (!pricingChoice) {
        return "Please select a pricing plan before continuing.";
      }
    }
    if (sectionIdx === 3) {
      // All open-text answers must be filled
      const missing = openQuestions.filter(q => !(openAnswers[q.key] ?? "").trim());
      if (missing.length > 0) {
        return `Please fill in all fields before continuing. Missing: ${missing.map(q => q.label).join(", ")}.`;
      }
    }
    if (sectionIdx === 4) {
      // All contact fields must be filled
      if (!contact.name.trim())        return "Please enter your name before submitting.";
      if (!contact.whatsapp.trim())    return "Please enter your WhatsApp number before submitting.";
      if (!contact.email.trim())       return "Please enter your email address before submitting.";
      if (!contact.canContact)         return "Please answer whether we can contact you before submitting.";
    }
    return "";
  }

  function navigate(dir: "fwd" | "back") {
    if (animating) return;
    setAnimDir(dir);
    setAnimating(true);
    setTimeout(() => {
      setSectionIdx(i => dir === "fwd" ? i + 1 : i - 1);
      setAnimating(false);
    }, 220);
  }

  async function handleSubmit() {
    setBusy(true);
    setError("");
    try {
      const { error: dbErr } = await supabase.from("beta_feedback").insert({
        role,
        ratings,
        choices,
        pricing_preference: pricingChoice,
        open_answers: openAnswers,
        contact,
        submitted_at: new Date().toISOString(),
      });
      if (dbErr) throw new Error(dbErr.message);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await supabase.from("report_usage").upsert(
            { user_id: user.id, feedback_bonus_used: true },
            { onConflict: "user_id" }
          );
        }
      } catch (_) {}
      setScreen("closing");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Something went wrong. Please try again.";
      // Common cause: beta_feedback table not created in Supabase yet
      if (msg.includes("relation") || msg.includes("does not exist") || msg.includes("42P01")) {
        setError("Submission table not found. Please ask the admin to run the database setup SQL in Supabase.");
      } else if (msg.includes("row-level security") || msg.includes("violates") || msg.includes("42501")) {
        setError("Permission error. Please ask the admin to enable anon insert policy on beta_feedback table in Supabase.");
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  const progress = Math.round(((sectionIdx + 1) / TOTAL_SECTIONS) * 100);

  // ── Styles ────────────────────────────────────────────────────────────────
  const pageStyle: React.CSSProperties = {
    minHeight: "100vh", background: NAVY, display: "flex",
    flexDirection: "column", alignItems: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "0 16px 60px",
    overflowY: "auto",
  };

  const cardStyle: React.CSSProperties = {
    width: "100%", maxWidth: 600,
    background: CARD, borderRadius: 20,
    border: `1px solid ${BORDER}`,
    boxShadow: "0 24px 80px rgba(0,0,0,0.4)",
    overflow: "hidden",
  };

  // ── Intro screen ──────────────────────────────────────────────────────────
  if (screen === "intro") {
    return (
      <div style={pageStyle}>
        <style>{`
          @keyframes fadeUp { from { opacity:0; transform:translateY(24px); } to { opacity:1; transform:translateY(0); } }
          @keyframes pop { from { transform:scale(0.5); opacity:0; } to { transform:scale(1); opacity:1; } }
          @keyframes draw { from { stroke-dashoffset:30; } to { stroke-dashoffset:0; } }
          @keyframes shimmer { 0%,100%{opacity:0.7} 50%{opacity:1} }
        `}</style>

        <div style={{ paddingTop: 48, animation: "fadeUp 0.5s ease both", width: "100%", maxWidth: 600 }}>
          {/* Logo */}
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <div style={{ display:"inline-flex", alignItems:"center", gap:10 }}>
              <div style={{ width:32,height:32, borderRadius:8, background:`rgba(20,184,166,0.2)`,
                display:"flex",alignItems:"center",justifyContent:"center" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <rect x="9" y="2" width="6" height="13" rx="3" stroke={TEAL} strokeWidth="2"/>
                  <path d="M5 10a7 7 0 0 0 14 0M12 19v3M9 22h6" stroke={TEAL} strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </div>
              <span style={{ color: TEXT1, fontSize: 18, fontWeight: 700, letterSpacing: "-0.3px" }}>Sphota</span>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ padding: "48px 40px", textAlign: "center" }}>
              <div style={{ fontSize: 40, marginBottom: 16 }}>🩺</div>
              <h1 style={{ color: TEXT1, fontSize: 26, fontWeight: 700, marginBottom: 16, lineHeight: 1.3 }}>
                Share your honest feedback
              </h1>
              <p style={{ color: TEXT2, fontSize: 16, lineHeight: 1.7, marginBottom: 12 }}>
                You've been one of our first users.
              </p>
              <p style={{ color: TEXT2, fontSize: 16, lineHeight: 1.7, marginBottom: 32 }}>
                Your honest feedback shapes the future of Sphota.<br/>
                <span style={{ color: TEAL, fontWeight: 600 }}>This takes 3 minutes.</span>
              </p>
              <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(20,184,166,0.08)",
                border:`1px solid rgba(20,184,166,0.2)`, borderRadius:999, padding:"6px 14px", marginBottom:32 }}>
                <div style={{ width:6,height:6, borderRadius:"50%", background:TEAL, animation:"shimmer 2s infinite" }}/>
                <span style={{ color: TEAL, fontSize: 13, fontWeight: 600 }}>
                  {role === "doctor" ? "Doctor feedback form" : "Receptionist feedback form"}
                </span>
              </div>
              <br/>
              <button
                onClick={() => setScreen("questions")}
                style={{
                  background: TEAL, color: "#fff", border: "none",
                  borderRadius: 12, padding: "14px 40px",
                  fontSize: 16, fontWeight: 700, cursor: "pointer",
                  boxShadow: `0 0 24px rgba(20,184,166,0.3)`,
                  transition: "transform 0.12s, box-shadow 0.12s",
                }}
                onMouseEnter={e => { (e.target as HTMLElement).style.transform = "scale(1.03)"; }}
                onMouseLeave={e => { (e.target as HTMLElement).style.transform = "scale(1)"; }}
              >
                Start →
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Closing screen ────────────────────────────────────────────────────────
  if (screen === "closing") {
    return (
      <div style={pageStyle}>
        <style>{`
          @keyframes fadeUp { from { opacity:0; transform:translateY(24px); } to { opacity:1; transform:translateY(0); } }
          @keyframes pop { from { transform:scale(0.5); opacity:0; } to { transform:scale(1); opacity:1; } }
          @keyframes draw { from { stroke-dashoffset:30; } to { stroke-dashoffset:0; } }
        `}</style>
        <div style={{ paddingTop: 80, animation: "fadeUp 0.5s ease both", width: "100%", maxWidth: 600 }}>
          <div style={cardStyle}>
            <div style={{ padding: "56px 40px", textAlign: "center" }}>
              <AnimatedCheck />
              <h1 style={{ color: TEXT1, fontSize: 24, fontWeight: 700, marginBottom: 16 }}>
                Feedback submitted — thank you! 🙏
              </h1>
              <p style={{ color: TEXT2, fontSize: 16, lineHeight: 1.7, marginBottom: 24 }}>
                Your 10 bonus reports for this month have been unlocked. You can close this tab and return to Sphota.
              </p>
              <button
                onClick={() => { try { window.close(); } catch(e) { window.history.back(); } }}
                style={{ background:"#14b8a6", border:"none", borderRadius:12, padding:"13px 24px", color:"#fff", fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}
              >
                ← Back to Sphota
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Questions screen ──────────────────────────────────────────────────────
  const sectionTitles = ["Experience ratings","Quick questions","Pricing","Your thoughts","Stay in touch"];
  const sectionIcons  = ["⭐","✅","💰","💬","📞"];

  const slideStyle: React.CSSProperties = {
    transition: "opacity 0.22s ease, transform 0.22s ease",
    opacity: animating ? 0 : 1,
    transform: animating
      ? (animDir === "fwd" ? "translateX(40px)" : "translateX(-40px)")
      : "translateX(0)",
  };

  return (
    <div style={pageStyle}>
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(24px); } to { opacity:1; transform:translateY(0); } }
        @keyframes pop { from { transform:scale(0.5); opacity:0; } to { transform:scale(1); opacity:1; } }
        @keyframes draw { from { stroke-dashoffset:30; } to { stroke-dashoffset:0; } }
        textarea:focus, input:focus { outline: none !important; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a3a50; border-radius: 2px; }
      `}</style>

      <div style={{ paddingTop: 32, width: "100%", maxWidth: 600, animation: "fadeUp 0.4s ease both" }}>

        {/* Logo */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:24 }}>
          <div style={{ width:28,height:28, borderRadius:7, background:"rgba(20,184,166,0.15)",
            display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <rect x="9" y="2" width="6" height="13" rx="3" stroke={TEAL} strokeWidth="2"/>
              <path d="M5 10a7 7 0 0 0 14 0M12 19v3M9 22h6" stroke={TEAL} strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <span style={{ color: TEXT2, fontSize: 15, fontWeight: 600 }}>Sphota Feedback</span>
        </div>

        {/* Progress bar */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
            <span style={{ color: TEXT2, fontSize: 13 }}>
              {sectionIcons[sectionIdx]} {sectionTitles[sectionIdx]}
            </span>
            <span style={{ color: TEAL, fontSize: 13, fontWeight: 600 }}>{progress}%</span>
          </div>
          <div style={{ height:4, background:"rgba(255,255,255,0.06)", borderRadius:2 }}>
            <div style={{
              height:"100%", borderRadius:2, background:TEAL,
              width:`${progress}%`, transition:"width 0.4s ease",
              boxShadow:`0 0 8px rgba(20,184,166,0.5)`,
            }}/>
          </div>
        </div>

        {/* Dots */}
        <div style={{ display:"flex", gap:6, justifyContent:"center", marginBottom:20 }}>
          {Array.from({length: TOTAL_SECTIONS}).map((_,i) => (
            <div key={i} style={{
              width: i === sectionIdx ? 20 : 6, height: 6, borderRadius: 3,
              background: i <= sectionIdx ? TEAL : "rgba(255,255,255,0.1)",
              transition: "all 0.3s ease",
            }}/>
          ))}
        </div>

        {/* Card */}
        <div style={cardStyle}>
          <div style={{ padding: "32px 32px 28px", ...slideStyle }}>

            {/* ── Section 0: Star ratings ────────────────────────────── */}
            {sectionIdx === 0 && (
              <>
                <h2 style={{ color: TEXT1, fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
                  Rate your experience
                </h2>
                <p style={{ color: TEXT2, fontSize: 14, marginBottom: 28 }}>
                  Click the stars to rate each area.
                </p>
                {ratingQuestions.map(q => (
                  <StarRow
                    key={q.key}
                    label={q.label}
                    value={ratings[q.key] ?? 0}
                    onChange={v => {
                      setRatings(r => ({ ...r, [q.key]: v }));
                      setSectionError("");
                    }}
                  />
                ))}
              </>
            )}

            {/* ── Section 1: Quick choices ───────────────────────────── */}
            {sectionIdx === 1 && (
              <>
                <h2 style={{ color: TEXT1, fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
                  Quick questions
                </h2>
                <p style={{ color: TEXT2, fontSize: 14, marginBottom: 28 }}>
                  Pick one answer for each.
                </p>
                {choiceQuestions.map(q => (
                  <PillGroup
                    key={q.key}
                    label={q.label}
                    options={q.options}
                    value={choices[q.key] ?? ""}
                    onChange={v => { setChoices(c => ({ ...c, [q.key]: v })); setSectionError(""); }}
                  />
                ))}
              </>
            )}

            {/* ── Section 2: Pricing ────────────────────────────────── */}
            {sectionIdx === 2 && (
              <>
                <h2 style={{ color: TEXT1, fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
                  Pricing preference
                </h2>
                <p style={{ color: TEXT2, fontSize: 14, marginBottom: 28 }}>
                  Which pricing plan would you consider for Sphota?
                </p>
                <div style={{ display:"flex", flexWrap:"wrap", gap:12 }}>
                  {pricingPlans.map(p => (
                    <PricingPill
                      key={p.plan}
                      plan={p.plan}
                      subtitle={p.subtitle}
                      value={pricingChoice}
                      onChange={v => {
                        setPricingChoice(v);
                        setSectionError("");
                      }}
                    />
                  ))}
                </div>
                {!pricingChoice && (
                  <p style={{ color: TEXT3, fontSize: 13, marginTop: 16 }}>
                    Select the plan that feels right for you.
                  </p>
                )}
                {pricingChoice && (
                  <p style={{ color: TEAL, fontSize: 13, fontWeight: 600, marginTop: 16 }}>
                    ✓ You selected {pricingChoice}
                  </p>
                )}
              </>
            )}

            {/* ── Section 3: Open text ──────────────────────────────── */}
            {sectionIdx === 3 && (
              <>
                <h2 style={{ color: TEXT1, fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
                  Your thoughts
                </h2>
                <p style={{ color: TEXT2, fontSize: 14, marginBottom: 28 }}>
                  Please fill in all fields — your thoughts are important.
                </p>
                {openQuestions.map(q => (
                  <Textarea
                    key={q.key}
                    label={q.label}
                    placeholder={q.placeholder}
                    value={openAnswers[q.key] ?? ""}
                    onChange={v => { setOpenAnswers(a => ({ ...a, [q.key]: v })); setSectionError(""); }}
                  />
                ))}
              </>
            )}

            {/* ── Section 4: Contact ────────────────────────────────── */}
            {sectionIdx === 4 && (
              <>
                <h2 style={{ color: TEXT1, fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
                  Stay in touch
                </h2>
                <p style={{ color: TEXT2, fontSize: 14, marginBottom: 28 }}>
                  All fields below are required. We'll only reach out if you say yes.
                </p>
                <TextInput label="Your name" value={contact.name} optional={false}
                  onChange={v => { setContact(c=>({...c,name:v})); setSectionError(""); }} placeholder="Dr. Priya Sharma" />
                <TextInput label="WhatsApp number" value={contact.whatsapp} type="tel" optional={false}
                  onChange={v => { setContact(c=>({...c,whatsapp:v})); setSectionError(""); }} placeholder="+91 98765 43210" />
                <TextInput label="Email address" value={contact.email} type="email" optional={false}
                  onChange={v => { setContact(c=>({...c,email:v})); setSectionError(""); }} placeholder="you@example.com" />
                <PillGroup
                  label="Can we contact you for a 10 minute call?"
                  options={["Yes","No"]}
                  value={contact.canContact}
                  onChange={v => setContact(c=>({...c,canContact:v}))}
                />
                {error && (
                  <div style={{ background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.25)",
                    borderRadius:10, padding:"12px 14px", color:"#f87171", fontSize:14, marginTop:8 }}>
                    {error}
                  </div>
                )}
              </>
            )}

          </div>

          {sectionError && (
            <p style={{ color: "#f87171", fontSize: 13, textAlign: "center", margin: "0 0 8px" }}>
              {sectionError}
            </p>
          )}

          {/* ── Navigation ──────────────────────────────────────────── */}
          <div style={{
            display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"16px 32px 24px",
            borderTop:`1px solid ${BORDER}`,
          }}>
            <button
              type="button"
              onClick={() => {
                if (sectionIdx === 0) { setScreen("intro"); return; }
                navigate("back");
              }}
              style={{
                background:"transparent", border:`1px solid ${BORDER}`,
                borderRadius:10, padding:"10px 20px", color:TEXT2,
                fontSize:14, cursor:"pointer", transition:"all 0.15s",
              }}
              onMouseEnter={e => { (e.target as HTMLElement).style.borderColor=TEXT2; }}
              onMouseLeave={e => { (e.target as HTMLElement).style.borderColor=BORDER; }}
            >
              ← Back
            </button>

            {sectionIdx < TOTAL_SECTIONS - 1 ? (
              <button
                type="button"
                onClick={() => {
                  const err = validateCurrentSection();
                  if (err) { setSectionError(err); return; }
                  setSectionError("");
                  navigate("fwd");
                }}
                style={{
                  background:TEAL, border:"none", borderRadius:10,
                  padding:"10px 24px", color:"#fff",
                  fontSize:14, fontWeight:600, cursor:"pointer",
                  boxShadow:`0 0 16px rgba(20,184,166,0.25)`,
                  transition:"transform 0.12s",
                }}
                onMouseEnter={e => { (e.target as HTMLElement).style.transform="scale(1.03)"; }}
                onMouseLeave={e => { (e.target as HTMLElement).style.transform="scale(1)"; }}
              >
                Continue →
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  const err = validateCurrentSection();
                  if (err) { setSectionError(err); return; }
                  setSectionError("");
                  void handleSubmit();
                }}
                disabled={busy}
                style={{
                  background: busy ? "#0d7a6d" : TEAL,
                  border:"none", borderRadius:10,
                  padding:"10px 28px", color:"#fff",
                  fontSize:14, fontWeight:700, cursor: busy ? "not-allowed" : "pointer",
                  boxShadow:`0 0 16px rgba(20,184,166,0.25)`,
                  opacity: busy ? 0.8 : 1,
                  transition:"transform 0.12s",
                }}
              >
                {busy ? "Submitting…" : "Submit feedback ✓"}
              </button>
            )}
          </div>
        </div>

        {/* Skip note */}
        <p style={{ textAlign:"center", color:TEXT3, fontSize:12, marginTop:16 }}>
          All fields are required — please complete each section fully.
        </p>
      </div>
    </div>
  );
}
