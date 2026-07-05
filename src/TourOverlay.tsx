import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";

interface TourStep {
  targetId: string;
  title: string;
  desc: string;
}

const STEPS: TourStep[] = [
  {
    targetId: "tour-sidebar",
    title: "Your Navigation",
    desc: "Welcome to Sphota! This is your navigation — patients, sessions, reports, and settings are all right here.",
  },
  {
    targetId: "tour-patients",
    title: "Manage Patients",
    desc: "Add and manage your patients here. Each patient keeps their full history, medications, session notes, and documents in one place.",
  },
  {
    targetId: "tour-sessions",
    title: "Sessions & Notes",
    desc: "Record session notes here. Our service transcribes your conversation and structures it automatically into clinical notes.",
  },
  {
    targetId: "tour-generate",
    title: "Smart Clinical Reports",
    desc: "Generate professional SOAP, DAP, BIRP, or PIRP reports and patient letters in one click automatically — no typing required.",
  },
  {
    targetId: "tour-overview",
    title: "Your Dashboard",
    desc: "Your dashboard gives you a live overview of your clinic — waiting room, upcoming appointments, recent activity, and quick actions.",
  },
];

interface SpotRect { top: number; left: number; width: number; height: number; }

function getRect(id: string): SpotRect | null {
  const el = document.getElementById(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export default function TourOverlay({ doctorId, onDone }: { doctorId: string; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<SpotRect | null>(null);
  const [visible, setVisible] = useState(false);
  const stepRef = useRef(0);

  const PAD = 10;

  const refresh = useCallback(() => {
    const s = stepRef.current;
    if (s >= STEPS.length) return;
    const r = getRect(STEPS[s].targetId);
    setRect(r);
  }, []);

  useEffect(() => {
    refresh();
    const t = setTimeout(() => setVisible(true), 50);
    window.addEventListener("resize", refresh);
    return () => { clearTimeout(t); window.removeEventListener("resize", refresh); };
  }, [step, refresh]);

  function finish() {
    localStorage.setItem(`psych_tour_done_${doctorId}`, "true");
    // Also persist in DB so tour never shows again on any device for this account
    supabase.from("doctors").update({ tour_done: true }).eq("id", doctorId).then();
    onDone();
  }

  function next() {
    setVisible(false);
    setTimeout(() => {
      if (stepRef.current >= STEPS.length - 1) {
        finish();
        return;
      }
      stepRef.current += 1;
      setStep(stepRef.current);
      setTimeout(() => setVisible(true), 60);
    }, 200);
  }

  const current = STEPS[Math.min(step, STEPS.length - 1)];
  const spotTop    = rect ? rect.top    - PAD : window.innerHeight / 2 - 60;
  const spotLeft   = rect ? rect.left   - PAD : window.innerWidth  / 2 - 120;
  const spotW      = rect ? rect.width  + PAD * 2 : 240;
  const spotH      = rect ? rect.height + PAD * 2 : 120;

  // Position tooltip above or below the spotlight
  const inBottomHalf = spotTop > window.innerHeight * 0.55;
  const tooltipTop   = inBottomHalf ? spotTop - 160 : spotTop + spotH + 16;
  const tooltipLeft  = Math.max(16, Math.min(spotLeft, window.innerWidth - 356));

  const TEAL = "#14b8a6";

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 99990, pointerEvents: "none" }}>
      {/* Dark overlay — rendered as 4 rects around the spotlight */}
      {rect && (
        <>
          {/* top */}
          <div style={{ position:"fixed", top:0, left:0, right:0, height: Math.max(0, spotTop), background:"rgba(0,0,0,0.78)", pointerEvents:"auto" }} onClick={next} />
          {/* bottom */}
          <div style={{ position:"fixed", top: spotTop+spotH, left:0, right:0, bottom:0, background:"rgba(0,0,0,0.78)", pointerEvents:"auto" }} onClick={next} />
          {/* left */}
          <div style={{ position:"fixed", top: spotTop, left:0, width: Math.max(0, spotLeft), height: spotH, background:"rgba(0,0,0,0.78)", pointerEvents:"auto" }} onClick={next} />
          {/* right */}
          <div style={{ position:"fixed", top: spotTop, left: spotLeft+spotW, right:0, height: spotH, background:"rgba(0,0,0,0.78)", pointerEvents:"auto" }} onClick={next} />
        </>
      )}
      {!rect && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)", pointerEvents:"auto" }} onClick={next} />
      )}

      {/* Spotlight ring */}
      {rect && (
        <div style={{
          position: "fixed",
          top: spotTop, left: spotLeft, width: spotW, height: spotH,
          borderRadius: 10,
          border: `2px solid rgba(20,184,166,0.6)`,
          boxShadow: `0 0 0 3px rgba(20,184,166,0.15), 0 0 24px rgba(20,184,166,0.2)`,
          transition: visible ? "all 0.35s cubic-bezier(0.4,0,0.2,1)" : "none",
          pointerEvents: "none",
          zIndex: 99991,
        }} />
      )}

      {/* Tooltip card */}
      <div style={{
        position: "fixed",
        top: tooltipTop,
        left: tooltipLeft,
        width: 340,
        background: "#111827",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 16,
        padding: "20px 22px 18px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 0.25s ease, transform 0.25s ease",
        pointerEvents: "auto",
        zIndex: 99992,
      }}>
        {/* Progress dots */}
        <div style={{ display:"flex", gap:5, marginBottom:14 }}>
          {STEPS.map((_,i) => (
            <div key={i} style={{
              width: i === step ? 18 : 6, height:6, borderRadius:3,
              background: i <= step ? TEAL : "rgba(255,255,255,0.12)",
              transition: "all 0.3s ease",
            }}/>
          ))}
          <span style={{ marginLeft:"auto", fontSize:12, color:"rgba(255,255,255,0.35)", alignSelf:"center" }}>
            {step + 1} of {STEPS.length}
          </span>
        </div>

        {/* Content */}
        <div style={{ display:"flex", alignItems:"flex-start", gap:10, marginBottom:14 }}>
          <div style={{
            width:32, height:32, borderRadius:8, background:`rgba(20,184,166,0.12)`,
            border:`1px solid rgba(20,184,166,0.25)`,
            display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
          }}>
            {step === 0 && <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" stroke={TEAL} strokeWidth="2"/><rect x="3" y="14" width="7" height="7" rx="1" stroke={TEAL} strokeWidth="2"/><rect x="14" y="3" width="7" height="7" rx="1" stroke={TEAL} strokeWidth="2"/><rect x="14" y="14" width="7" height="7" rx="1" stroke={TEAL} strokeWidth="2"/></svg>}
            {step === 1 && <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke={TEAL} strokeWidth="2" strokeLinecap="round"/><circle cx="9" cy="7" r="4" stroke={TEAL} strokeWidth="2"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke={TEAL} strokeWidth="2" strokeLinecap="round"/></svg>}
            {step === 2 && <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="2" width="6" height="13" rx="3" stroke={TEAL} strokeWidth="2"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3M9 22h6" stroke={TEAL} strokeWidth="2" strokeLinecap="round"/></svg>}
            {step === 3 && <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke={TEAL} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            {step === 4 && <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke={TEAL} strokeWidth="2"/><path d="M3 9h18M9 21V9" stroke={TEAL} strokeWidth="2" strokeLinecap="round"/></svg>}
          </div>
          <div>
            <p style={{ color:"#f0f4f8", fontWeight:700, fontSize:15, margin:"0 0 5px" }}>{current.title}</p>
            <p style={{ color:"#94a3b8", fontSize:13, lineHeight:1.55, margin:0 }}>{current.desc}</p>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <button
            onClick={finish}
            style={{
              background:"none", border:"none", color:"rgba(255,255,255,0.3)",
              fontSize:12, cursor:"pointer", padding:"4px 0",
              transition:"color 0.15s",
            }}
            onMouseEnter={e => { (e.target as HTMLElement).style.color="rgba(255,255,255,0.6)"; }}
            onMouseLeave={e => { (e.target as HTMLElement).style.color="rgba(255,255,255,0.3)"; }}
          >
            Skip tour
          </button>
          <button
            onClick={next}
            style={{
              background: TEAL, border:"none", borderRadius:9,
              padding:"9px 20px", color:"#fff",
              fontSize:13, fontWeight:700, cursor:"pointer",
              boxShadow:`0 0 14px rgba(20,184,166,0.3)`,
              transition:"transform 0.12s",
            }}
            onMouseEnter={e => { (e.target as HTMLElement).style.transform="scale(1.04)"; }}
            onMouseLeave={e => { (e.target as HTMLElement).style.transform="scale(1)"; }}
          >
            {step >= STEPS.length - 1 ? "Get started! 🚀" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}
