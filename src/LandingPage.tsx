import { useState, useEffect } from "react";
import { supabase } from "./supabase";

type Mode = "login" | "signup" | "reset-password";

const COUNTRIES = [
  "India", "United States", "United Kingdom", "Canada", "Australia",
  "Germany", "France", "Netherlands", "Singapore", "UAE", "Saudi Arabia",
  "Brazil", "South Africa", "Other",
];

const AUTH_ATTEMPT_KEY = "vd_auth_attempts";
const AUTH_LOCKOUT_KEY = "vd_auth_lockout";
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

function checkRateLimit(): { blocked: boolean; remaining: number; secondsLeft: number } {
  const lockoutUntil = parseInt(localStorage.getItem(AUTH_LOCKOUT_KEY) ?? "0", 10);
  if (Date.now() < lockoutUntil) {
    return { blocked: true, remaining: 0, secondsLeft: Math.ceil((lockoutUntil - Date.now()) / 1000) };
  }
  const attempts = parseInt(localStorage.getItem(AUTH_ATTEMPT_KEY) ?? "0", 10);
  return { blocked: false, remaining: MAX_ATTEMPTS - attempts, secondsLeft: 0 };
}

function recordFailedAttempt() {
  const attempts = parseInt(localStorage.getItem(AUTH_ATTEMPT_KEY) ?? "0", 10) + 1;
  localStorage.setItem(AUTH_ATTEMPT_KEY, String(attempts));
  if (attempts >= MAX_ATTEMPTS) {
    localStorage.setItem(AUTH_LOCKOUT_KEY, String(Date.now() + LOCKOUT_DURATION_MS));
    localStorage.removeItem(AUTH_ATTEMPT_KEY);
  }
}

function clearRateLimit() {
  localStorage.removeItem(AUTH_ATTEMPT_KEY);
  localStorage.removeItem(AUTH_LOCKOUT_KEY);
}

function extractAuthError(err: unknown): string {
  if (!err) return "Something went wrong. Please try again.";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || "Something went wrong.";
  const obj = err as Record<string, unknown>;
  const msg = obj.message ?? obj.msg ?? obj.error_description ?? obj.error ?? obj.code;
  if (msg && typeof msg === "string" && msg.trim()) return msg;
  try {
    const s = JSON.stringify(err);
    if (s !== "{}" && s !== "null") return s;
  } catch { /* ignore */ }
  return "Something went wrong. Please try again.";
}

export default function LandingPage({ onAuth }: { onAuth?: () => void }) {
  const [mode,        setMode]        = useState<Mode>("login");
  const [email,       setEmail]       = useState("");
  const [password,    setPassword]    = useState("");
  const [country,     setCountry]     = useState("India");
  const [mciNumber,   setMciNumber]   = useState("");
  const [error,       setError]       = useState("");
  const [info,        setInfo]        = useState("");
  const [busy,        setBusy]        = useState(false);
  const [authOpen,    setAuthOpen]    = useState(false);
  const [mfaPending,  setMfaPending]  = useState(false);
  const [mfaCode,     setMfaCode]     = useState("");
  const [mfaFactorId, setMfaFactorId] = useState("");
  const [mfaChallengeId, setMfaChallengeId] = useState("");
  const [mfaError,    setMfaError]    = useState("");

  // Allow body to scroll on landing page
  useEffect(() => {
    const prevBodyOverflow = document.body.style.overflow;
    const prevBodyHeight = document.body.style.height;
    const root = document.getElementById("root");
    const prevRootOverflow = root?.style.overflow ?? "";
    const prevRootHeight = root?.style.height ?? "";
    document.body.style.overflow = "auto";
    document.body.style.height = "auto";
    if (root) { root.style.overflow = "auto"; root.style.height = "auto"; }
    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.height = prevBodyHeight;
      if (root) { root.style.overflow = prevRootOverflow; root.style.height = prevRootHeight; }
    };
  }, []);

  // ── LIVING BRAIN CANVAS (capped FPS, fewer nodes, pauses when hidden) ──
  useEffect(() => {
    const canvas = document.getElementById("sp-brain-canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
    if (prefersReducedMotion) return;

    let W = 0, H = 0, raf = 0;
    let mouse = { x: -9999, y: -9999 };
    let lastFrame = 0;
    const FRAME_MS = 1000 / 30;

    const resize = () => {
      W = canvas.width = canvas.offsetWidth;
      H = canvas.height = canvas.offsetHeight;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    };
    if (!isCoarsePointer) window.addEventListener("mousemove", onMouseMove, { passive: true });

    const NODE_COUNT = 48;
    type Node = { x: number; y: number; vx: number; vy: number; r: number; pulse: number; pulseSpeed: number; };
    const nodes: Node[] = Array.from({ length: NODE_COUNT }, () => ({
      x: Math.random() * 1200,
      y: Math.random() * 800,
      vx: (Math.random() - 0.5) * 0.28,
      vy: (Math.random() - 0.5) * 0.28,
      r: 1.2 + Math.random() * 1.8,
      pulse: Math.random() * Math.PI * 2,
      pulseSpeed: 0.012 + Math.random() * 0.018,
    }));

    type Orb = { x: number; y: number; radius: number; hue: number; phase: number; };
    const orbs: Orb[] = [
      { x: 0.2, y: 0.3, radius: 0.28, hue: 210, phase: 0 },
      { x: 0.75, y: 0.6, radius: 0.22, hue: 175, phase: 1.2 },
      { x: 0.5, y: 0.15, radius: 0.18, hue: 250, phase: 2.4 },
    ];

    const CONNECT_DIST = 120;
    const CONNECT_DIST_SQ = CONNECT_DIST * CONNECT_DIST;
    const sx = () => W / 1200;
    const sy = () => H / 800;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (now - lastFrame < FRAME_MS) return;
      lastFrame = now;

      ctx.clearRect(0, 0, W, H);
      const scaleX = sx(), scaleY = sy();

      orbs.forEach(o => {
        o.phase += 0.005;
        const px = (o.x + Math.sin(o.phase * 0.7) * 0.04) * W;
        const py = (o.y + Math.cos(o.phase * 0.5) * 0.06) * H;
        const rPx = o.radius * Math.min(W, H);
        const grd = ctx.createRadialGradient(px, py, 0, px, py, rPx);
        const alpha = 0.055 + Math.sin(o.phase) * 0.015;
        grd.addColorStop(0, `hsla(${o.hue},80%,65%,${alpha})`);
        grd.addColorStop(1, `hsla(${o.hue},60%,45%,0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(px, py, rPx, 0, Math.PI * 2);
        ctx.fill();
      });

      nodes.forEach(n => {
        n.x += n.vx;
        n.y += n.vy;
        n.pulse += n.pulseSpeed;
        if (n.x < -50) n.x = 1250; if (n.x > 1250) n.x = -50;
        if (n.y < -50) n.y = 850; if (n.y > 850) n.y = -50;

        if (!isCoarsePointer) {
          const mx = mouse.x / scaleX, my = mouse.y / scaleY;
          const dx = mx - n.x, dy = my - n.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 220 && dist > 0) {
            n.vx += (dx / dist) * 0.0012;
            n.vy += (dy / dist) * 0.0012;
          }
        }
        n.vx *= 0.998; n.vy *= 0.998;
        const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (speed > 0.6) { n.vx = (n.vx / speed) * 0.6; n.vy = (n.vy / speed) * 0.6; }
      });

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = (a.x - b.x) * scaleX, dy = (a.y - b.y) * scaleY;
          const dSq = dx * dx + dy * dy;
          if (dSq < CONNECT_DIST_SQ) {
            const d = Math.sqrt(dSq);
            const alpha = (1 - d / CONNECT_DIST) * 0.16;
            const hue = 200 + ((a.x + b.x) / 2400) * 60;
            ctx.strokeStyle = `hsla(${hue},70%,65%,${alpha})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(a.x * scaleX, a.y * scaleY);
            ctx.lineTo(b.x * scaleX, b.y * scaleY);
            ctx.stroke();
          }
        }
      }

      nodes.forEach(n => {
        const px = n.x * scaleX, py = n.y * scaleY;
        const pulseR = n.r + Math.sin(n.pulse) * 0.4;
        const hue = 200 + (n.x / 1200) * 60;
        const alpha = 0.5 + Math.sin(n.pulse) * 0.2;
        ctx.fillStyle = `hsla(${hue},85%,72%,${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, pulseR, 0, Math.PI * 2);
        ctx.fill();
      });
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (!isCoarsePointer) window.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  // ── MAGNETIC CURSOR (desktop only — skipped on touch / reduced-motion) ──
  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
    if (prefersReducedMotion || isCoarsePointer) {
      document.querySelector(".sp-page")?.classList.add("sp-no-custom-cursor");
      return;
    }

    if (!document.getElementById("sp-cursor")) {
      const dot = document.createElement("div"); dot.id = "sp-cursor";
      const ring = document.createElement("div"); ring.id = "sp-cursor-ring";
      document.body.appendChild(dot);
      document.body.appendChild(ring);
    }
    const dot = document.getElementById("sp-cursor")!;
    const ring = document.getElementById("sp-cursor-ring")!;
    let mx = 0, my = 0, rx = 0, ry = 0;
    const onMove = (e: MouseEvent) => {
      mx = e.clientX; my = e.clientY;
      // Dot moves instantly on mousemove — zero lag, feels like native cursor
      dot.style.left = mx + "px"; dot.style.top = my + "px";
    };
    document.addEventListener("mousemove", onMove, { passive: true });
    let raf: number;
    // Ring runs at full refresh rate (60-144fps) with a snappy lerp factor
    const animate = () => {
      raf = requestAnimationFrame(animate);
      if (document.hidden) return;
      rx += (mx - rx) * 0.35; ry += (my - ry) * 0.35;
      ring.style.left = rx + "px"; ring.style.top = ry + "px";
    };
    raf = requestAnimationFrame(animate);
    const grow = () => { ring.style.transform = "translate(-50%,-50%) scale(1.7)"; ring.style.opacity = "0.6"; };
    const shrink = () => { ring.style.transform = "translate(-50%,-50%) scale(1)"; ring.style.opacity = "1"; };
    const interactives = document.querySelectorAll("button,a");
    interactives.forEach(el => {
      el.addEventListener("mouseenter", grow); el.addEventListener("mouseleave", shrink);
    });
    return () => {
      document.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
      interactives.forEach(el => {
        el.removeEventListener("mouseenter", grow); el.removeEventListener("mouseleave", shrink);
      });
    };
  }, [authOpen]);

  // ── WAVEFORM BARS ───────────────────────────────────────────
  useEffect(() => {
    const wf = document.getElementById("sp-waveform");
    if (!wf || wf.children.length > 0) return;
    const heights = [8,16,24,18,30,22,14,28,20,10,26,32,16,12,22,18,28,14,20,16,30,10,18,24,20,12,8,20,16];
    heights.forEach((h, i) => {
      const bar = document.createElement("div");
      bar.className = "sp-wave-bar";
      bar.style.setProperty("--wh", h + "px");
      bar.style.animationDelay = (i * 0.05).toFixed(2) + "s";
      wf.appendChild(bar);
    });
  }, []);

  // ── NAV SCROLL ──────────────────────────────────────────────
  useEffect(() => {
    const nav = document.getElementById("sp-nav");
    if (!nav) return;
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ── SCROLL REVEAL ───────────────────────────────────────────
  useEffect(() => {
    const els = document.querySelectorAll(".sp-reveal");
    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { (e.target as HTMLElement).classList.add("sp-revealed"); obs.unobserve(e.target); } });
    }, { threshold: 0.1 });
    els.forEach(el => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  // ── NUMBER COUNT UP ─────────────────────────────────────────
  useEffect(() => {
    const animate = (el: HTMLElement, target: string) => {
      const isPercent = target.includes("%");
      const isTime = target.includes("m");
      const isLt = target.startsWith("<");
      const num = parseFloat(target.replace(/[^0-9.]/g, ""));
      let start = 0, startTime: number | null = null;
      const duration = 1800;
      const step = (ts: number) => {
        if (!startTime) startTime = ts;
        const p = Math.min((ts - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        const cur = Math.round(eased * num * 10) / 10;
        el.textContent = (isLt ? "<" : "") + (Number.isInteger(cur) ? cur : cur.toFixed(0)) + (isPercent ? "%" : isTime ? "m" : "s");
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = target;
      };
      requestAnimationFrame(step);
    };
    const observer = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          const el = e.target as HTMLElement;
          const target = el.dataset.target ?? "";
          animate(el, target);
          observer.unobserve(el);
        }
      });
    }, { threshold: 0.5 });
    document.querySelectorAll(".sp-count-up").forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // ── AUTH HANDLERS ───────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setInfo("");
    if (mode === "reset-password") {
      if (!email.trim()) { setError("Please enter your email address."); return; }
      setBusy(true);
      try {
        const siteOrigin = (import.meta.env as Record<string,string>).VITE_SITE_URL?.replace(/\/$/, "") || window.location.origin;
        const redirectTo = `${siteOrigin}/?type=recovery`;
        const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
        if (err) throw new Error(err.message ?? "Could not send reset email");
        setInfo("Password reset link sent! Check your inbox (and spam folder).");
        setMode("login");
      } catch (err) { setError(extractAuthError(err)); } finally { setBusy(false); }
      return;
    }
    if (mode === "login") {
      const rateCheck = checkRateLimit();
      if (rateCheck.blocked) {
        const mins = Math.ceil(rateCheck.secondsLeft / 60);
        setError(`Too many failed attempts. Please wait ${mins} minute${mins !== 1 ? "s" : ""} before trying again.`);
        return;
      }
    }
    if (!email.trim() || !password) { setError("Please enter your email and password."); return; }
    setBusy(true);
    try {
      if (mode === "login") {
        const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (err) { recordFailedAttempt(); setError(extractAuthError(err)); return; }
        clearRateLimit();
        const { data: factors } = await supabase.auth.mfa.listFactors();
        const totpFactor = factors?.totp?.[0];
        if (totpFactor && totpFactor.status === "verified") {
          const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId: totpFactor.id });
          if (challengeErr) { setError("MFA challenge failed."); setBusy(false); return; }
          setMfaFactorId(totpFactor.id);
          setMfaChallengeId(challengeData.id);
          setMfaPending(true);
          setBusy(false);
          return;
        }
        onAuth?.();
      } else {
        if (password.length < 8 || !/\d/.test(password)) {
          setError("Password must be at least 8 characters and include a number."); return;
        }
        if (!mciNumber.trim()) {
          setError("MCI/State Medical Council registration number is required."); return;
        }
        const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
          email: email.trim(), password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (signUpErr) { setError(extractAuthError(signUpErr)); return; }
        localStorage.setItem("psych_pending_country", country);
        if (mciNumber.trim()) localStorage.setItem("psych_pending_mci", mciNumber.trim());
        if (!signUpData?.session) {
          setInfo("Account created! Check your inbox for a confirmation email, then sign in.");
          setMode("login"); setPassword(""); return;
        }
        const { error: signInErr } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInErr) { setInfo("Account created! You can now sign in."); setMode("login"); setPassword(""); return; }
        onAuth?.();
      }
    } catch (err) { setError(extractAuthError(err)); } finally { setBusy(false); }
  }

  async function handleMfaVerify(e: React.FormEvent) {
    e.preventDefault(); setMfaError(""); setBusy(true);
    try {
      const { error: verifyErr } = await supabase.auth.mfa.verify({ factorId: mfaFactorId, challengeId: mfaChallengeId, code: mfaCode.trim() });
      if (verifyErr) { setMfaError("Invalid code. Please try again."); return; }
      onAuth?.();
    } catch (err) { setMfaError(extractAuthError(err)); } finally { setBusy(false); }
  }

  function switchMode(m: Mode) { setMode(m); setError(""); setInfo(""); }

  const submitLabel = () => {
    if (busy) {
      if (mode === "login") return "Signing in…";
      if (mode === "signup") return "Creating account…";
      return "Sending…";
    }
    if (mode === "login") return "Sign In →";
    if (mode === "signup") return "Create Account →";
    return "Send Reset Link →";
  };

  return (
    <div data-theme="dark">
      <style>{`
        /* Fonts (Fraunces, DM Sans, Syne) are loaded globally via <link> in index.html — no @import needed here. */

        body, #root { overflow: auto !important; height: auto !important; }

        /* ── BASE ── */
        .sp-page {
          background: #060910;
          color: #e4eaf5;
          font-family: 'DM Sans', sans-serif;
          min-height: 100vh;
          overflow-x: hidden;
          cursor: none;
        }
        .sp-page.sp-no-custom-cursor { cursor: auto; }

        /* ── CUSTOM CURSOR ── */
        #sp-cursor {
          position: fixed; width: 7px; height: 7px;
          background: #4d9fff; border-radius: 50%;
          pointer-events: none; z-index: 99999;
          transform: translate(-50%, -50%);
          mix-blend-mode: screen;
        }
        #sp-cursor-ring {
          position: fixed; width: 32px; height: 32px;
          border: 1px solid rgba(77,159,255,0.5); border-radius: 50%;
          pointer-events: none; z-index: 99998;
          transform: translate(-50%, -50%);
          transition: transform 0.2s ease, opacity 0.2s ease;
        }
        #sp-cursor-trail {
          position: fixed; width: 18px; height: 18px;
          background: radial-gradient(circle, rgba(30,200,160,0.15) 0%, transparent 70%);
          border-radius: 50%; pointer-events: none; z-index: 99997;
          transform: translate(-50%, -50%);
        }

        /* ── BRAIN CANVAS ── */
        #sp-brain-canvas {
          position: absolute; inset: 0; width: 100%; height: 100%;
          display: block; pointer-events: none;
        }

        /* ── NAV ── */
        .sp-nav {
          position: fixed; top: 0; left: 0; right: 0; z-index: 200;
          padding: 22px 52px;
          display: flex; align-items: center; justify-content: space-between;
          transition: all 0.5s cubic-bezier(0.16,1,0.3,1);
        }
        .sp-nav.scrolled {
          padding: 14px 52px;
          background: rgba(6,9,16,0.82);
          backdrop-filter: blur(24px);
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .sp-logo {
          font-family: 'Fraunces', serif;
          font-size: 26px; font-weight: 700;
          color: #e4eaf5; text-decoration: none;
          letter-spacing: -0.5px;
          display: flex; align-items: center; gap: 1px;
        }
        .sp-logo-dot { color: #4d9fff; font-size: 32px; line-height: 1; margin-bottom: 2px; }
        .sp-nav-links { display: flex; gap: 38px; }
        .sp-nav-links a {
          font-size: 13px; font-weight: 500; color: rgba(228,234,245,0.5);
          text-decoration: none; transition: color 0.2s; letter-spacing: 0.02em;
        }
        .sp-nav-links a:hover { color: #e4eaf5; }
        .sp-nav-cta {
          background: transparent;
          border: 1px solid rgba(77,159,255,0.35);
          color: #4d9fff; padding: 10px 24px;
          border-radius: 100px; font-size: 13px; font-weight: 500;
          cursor: none; transition: all 0.25s;
          font-family: 'DM Sans', sans-serif;
          letter-spacing: 0.02em;
        }
        .sp-nav-cta:hover {
          background: rgba(77,159,255,0.12);
          border-color: rgba(77,159,255,0.6);
          box-shadow: 0 0 24px rgba(77,159,255,0.2);
        }

        /* ── HERO ── */
        .sp-hero {
          position: relative; min-height: 100vh;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          text-align: center;
          padding: 130px 24px 100px;
          overflow: hidden;
        }

        /* Bottom fade for hero */
        .sp-hero::after {
          content: '';
          position: absolute; bottom: 0; left: 0; right: 0; height: 200px;
          background: linear-gradient(to bottom, transparent, #060910);
          pointer-events: none; z-index: 2;
        }

        .sp-hero-content { position: relative; z-index: 3; max-width: 900px; }

        /* Chip */
        .sp-chip {
          display: inline-flex; align-items: center; gap: 9px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 100px;
          padding: 8px 18px;
          font-size: 11.5px; font-weight: 500;
          color: rgba(228,234,245,0.6);
          letter-spacing: 0.08em; text-transform: uppercase;
          margin-bottom: 40px;
        }
        .sp-chip-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: #1ec8a0;
          box-shadow: 0 0 8px rgba(30,200,160,0.8);
          animation: sp-pulse 2s ease-in-out infinite;
        }
        @keyframes sp-pulse {
          0%,100% { box-shadow: 0 0 8px rgba(30,200,160,0.8); }
          50% { box-shadow: 0 0 18px rgba(30,200,160,0.4), 0 0 36px rgba(30,200,160,0.15); }
        }

        /* Hero headline */
        .sp-h1 {
          font-family: 'Fraunces', serif;
          font-size: clamp(54px, 7.5vw, 96px);
          font-weight: 800; line-height: 1.0;
          letter-spacing: -3px; color: #e4eaf5;
          margin: 0 0 28px;
        }
        .sp-h1-sub {
          font-style: italic; font-weight: 300;
          background: linear-gradient(135deg, #4d9fff 0%, #1ec8a0 50%, #a78bfa 100%);
          background-size: 200% 200%;
          animation: sp-grad-shift 5s ease-in-out infinite alternate;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        @keyframes sp-grad-shift {
          0% { background-position: 0% 50%; }
          100% { background-position: 100% 50%; }
        }

        .sp-hero-sub {
          font-size: 18px; font-weight: 300;
          color: rgba(228,234,245,0.55);
          max-width: 540px; margin: 0 auto 44px;
          line-height: 1.8;
        }
        .sp-hero-sub strong { color: rgba(228,234,245,0.85); font-weight: 400; }

        /* CTAs */
        .sp-hero-actions { display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap; margin-bottom: 48px; }
        .sp-btn-primary {
          display: inline-flex; align-items: center; gap: 9px;
          background: linear-gradient(135deg, #4d9fff, #1ec8a0);
          color: #060910; padding: 15px 34px;
          border-radius: 100px; font-size: 14px; font-weight: 600;
          border: none; cursor: none; transition: all 0.3s;
          box-shadow: 0 0 40px rgba(77,159,255,0.25), 0 4px 24px rgba(0,0,0,0.4);
          font-family: 'DM Sans', sans-serif; letter-spacing: 0.01em;
          position: relative; overflow: hidden;
        }
        .sp-btn-primary::before {
          content: ''; position: absolute; inset: 0;
          background: linear-gradient(135deg, rgba(255,255,255,0.15), transparent);
          opacity: 0; transition: opacity 0.3s;
        }
        .sp-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 0 60px rgba(77,159,255,0.4), 0 8px 32px rgba(0,0,0,0.5); }
        .sp-btn-primary:hover::before { opacity: 1; }

        .sp-btn-ghost {
          display: inline-flex; align-items: center; gap: 9px;
          background: transparent; color: rgba(228,234,245,0.6);
          padding: 15px 28px; border-radius: 100px; font-size: 14px;
          border: 1px solid rgba(255,255,255,0.1); cursor: none;
          transition: all 0.25s; font-family: 'DM Sans', sans-serif;
          text-decoration: none; letter-spacing: 0.01em;
        }
        .sp-btn-ghost:hover { color: #e4eaf5; border-color: rgba(255,255,255,0.25); background: rgba(255,255,255,0.04); }

        /* Trust row */
        .sp-trust { display: flex; align-items: center; justify-content: center; gap: 20px; flex-wrap: wrap; }
        .sp-trust-item { font-size: 12px; color: rgba(228,234,245,0.3); display: flex; align-items: center; gap: 6px; }
        .sp-trust-item::before { content: ''; display: inline-block; width: 4px; height: 4px; background: #1ec8a0; border-radius: 50%; }
        .sp-trust-sep { color: rgba(255,255,255,0.1); font-size: 16px; }

        /* ── SESSION CARD ── */
        .sp-card {
          position: relative; z-index: 3;
          max-width: 700px; width: 100%;
          margin: 64px auto 0;
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 20px; overflow: hidden;
          backdrop-filter: blur(12px);
          box-shadow: 0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04) inset;
          text-align: left;
        }
        .sp-card::before {
          content: '';
          position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, rgba(77,159,255,0.4), rgba(30,200,160,0.4), transparent);
        }
        .sp-card-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 22px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          background: rgba(255,255,255,0.02);
        }
        .sp-card-tag { font-size: 12px; font-weight: 500; color: rgba(228,234,245,0.5); letter-spacing: 0.01em; }
        .sp-card-live { display: flex; align-items: center; gap: 7px; font-size: 11px; color: #1ec8a0; font-weight: 500; }
        .sp-live-dot { width: 6px; height: 6px; background: #1ec8a0; border-radius: 50%; animation: sp-pulse 1.5s ease-in-out infinite; }

        /* Waveform */
        #sp-waveform { display: flex; align-items: flex-end; gap: 3px; height: 38px; padding: 6px 22px; background: rgba(0,0,0,0.2); }
        .sp-wave-bar { width: 2.5px; border-radius: 2px; background: linear-gradient(to top, #4d9fff, #1ec8a0); opacity: 0.7; animation: sp-wave 1.3s ease-in-out infinite alternate; height: var(--wh, 12px); }
        @keyframes sp-wave { 0% { height: 3px; } 100% { height: var(--wh, 12px); } }

        .sp-transcript { padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; }
        .sp-tline { font-size: 13px; line-height: 1.65; color: rgba(228,234,245,0.6); }
        .sp-spk { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; margin-right: 8px; letter-spacing: 0.04em; }
        .sp-spk-dr { background: rgba(77,159,255,0.12); color: #6db3ff; }
        .sp-spk-pt { background: rgba(30,200,160,0.12); color: #1ec8a0; }
        .sp-card-footer { display: flex; align-items: center; gap: 10px; padding: 12px 22px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 11px; color: rgba(228,234,245,0.3); }
        .sp-spinner { width: 12px; height: 12px; border: 1.5px solid rgba(77,159,255,0.2); border-top-color: #4d9fff; border-radius: 50%; animation: sp-spin 0.9s linear infinite; flex-shrink: 0; }
        @keyframes sp-spin { to { transform: rotate(360deg); } }

        /* ── CONTAINER ── */
        .sp-container { max-width: 1100px; margin: 0 auto; padding: 0 52px; }

        /* ── REVEAL ANIMATION ── */
        .sp-reveal { opacity: 0; transform: translateY(28px); transition: opacity 0.8s cubic-bezier(0.16,1,0.3,1), transform 0.8s cubic-bezier(0.16,1,0.3,1); }
        .sp-reveal.sp-revealed { opacity: 1; transform: translateY(0); }
        .sp-reveal-delay-1 { transition-delay: 0.1s; }
        .sp-reveal-delay-2 { transition-delay: 0.2s; }
        .sp-reveal-delay-3 { transition-delay: 0.3s; }

        /* ── STATS BAND ── */
        .sp-stats {
          padding: 0;
          position: relative;
        }
        .sp-stats-inner {
          display: grid; grid-template-columns: repeat(3, 1fr);
          border-top: 1px solid rgba(255,255,255,0.06);
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .sp-stat-item {
          padding: 52px 40px;
          border-right: 1px solid rgba(255,255,255,0.06);
          position: relative; overflow: hidden;
        }
        .sp-stat-item:last-child { border-right: none; }
        .sp-stat-item::before {
          content: '';
          position: absolute; top: 0; left: 0; right: 0; height: 2px;
          background: linear-gradient(90deg, transparent, var(--stat-color, #4d9fff), transparent);
          opacity: 0; transition: opacity 0.4s;
        }
        .sp-stat-item:hover::before { opacity: 1; }
        .sp-stat-num {
          font-family: 'Fraunces', serif;
          font-size: 52px; font-weight: 800;
          color: var(--stat-color, #4d9fff);
          letter-spacing: -2px; line-height: 1;
          margin-bottom: 12px;
        }
        .sp-stat-label { font-size: 14px; color: rgba(228,234,245,0.4); line-height: 1.6; font-weight: 300; }
        .sp-stat-label strong { color: rgba(228,234,245,0.7); font-weight: 500; display: block; }

        /* ── SECTION COMMON ── */
        .sp-section { padding: 130px 0; }
        .sp-section-eyebrow {
          font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase;
          color: #4d9fff; font-weight: 600; margin-bottom: 16px;
          display: flex; align-items: center; gap: 10px;
        }
        .sp-section-eyebrow::before { content: ''; display: block; width: 24px; height: 1px; background: #4d9fff; }
        .sp-section-title {
          font-family: 'Fraunces', serif;
          font-size: clamp(36px, 4.5vw, 56px); font-weight: 700;
          line-height: 1.1; letter-spacing: -1.5px;
          color: #e4eaf5; margin-bottom: 18px;
        }
        .sp-section-sub { font-size: 17px; color: rgba(228,234,245,0.45); max-width: 500px; line-height: 1.8; font-weight: 300; }

        /* ── FEATURES ── */
        .sp-feat-grid {
          display: grid; grid-template-columns: repeat(3, 1fr);
          gap: 1px; background: rgba(255,255,255,0.04);
          border-radius: 20px; overflow: hidden;
          border: 1px solid rgba(255,255,255,0.06);
          margin-top: 60px;
        }
        .sp-feat-card {
          background: rgba(255,255,255,0.018);
          padding: 38px 32px;
          transition: background 0.3s;
          position: relative; overflow: hidden;
        }
        .sp-feat-card::after {
          content: ''; position: absolute; inset: 0;
          background: radial-gradient(ellipse at bottom right, rgba(77,159,255,0.06), transparent 60%);
          opacity: 0; transition: opacity 0.4s;
        }
        .sp-feat-card:hover { background: rgba(255,255,255,0.03); }
        .sp-feat-card:hover::after { opacity: 1; }
        .sp-feat-icon { font-size: 26px; margin-bottom: 18px; display: block; }
        .sp-feat-title { font-family: 'Fraunces', serif; font-size: 18px; font-weight: 700; color: #e4eaf5; margin-bottom: 10px; }
        .sp-feat-desc { font-size: 13.5px; color: rgba(228,234,245,0.45); line-height: 1.75; font-weight: 300; }
        .sp-feat-tag { display: inline-block; margin-top: 16px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #1ec8a0; font-weight: 600; }

        /* ── HOW IT WORKS ── */
        .sp-how-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 72px; align-items: start; }
        .sp-steps { display: flex; flex-direction: column; gap: 4px; }
        .sp-step {
          display: flex; gap: 22px; padding: 24px 20px;
          border-radius: 14px;
          position: relative; transition: all 0.3s;
          cursor: default;
        }
        .sp-step:hover {
          background: rgba(255,255,255,0.03);
          transform: translateX(6px);
        }
        .sp-step-line {
          position: absolute; left: 34px; top: 58px; bottom: -4px; width: 1px;
          background: linear-gradient(to bottom, rgba(77,159,255,0.3), transparent);
        }
        .sp-step:last-child .sp-step-line { display: none; }
        .sp-step-num {
          font-family: 'Fraunces', serif; font-size: 36px; font-weight: 800;
          color: rgba(77,159,255,0.2); line-height: 1; flex-shrink: 0;
          transition: color 0.3s; width: 28px;
        }
        .sp-step:hover .sp-step-num { color: #4d9fff; }
        .sp-step-title { font-size: 15px; font-weight: 600; color: #e4eaf5; margin-bottom: 6px; }
        .sp-step-desc { font-size: 13.5px; color: rgba(228,234,245,0.45); line-height: 1.7; font-weight: 300; }

        /* Report card */
        .sp-report-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 20px; padding: 28px;
          backdrop-filter: blur(12px);
          box-shadow: 0 40px 80px rgba(0,0,0,0.4);
          position: relative; overflow: hidden;
        }
        .sp-report-card::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, rgba(30,200,160,0.5), transparent);
        }
        .sp-report-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 22px; padding-bottom: 18px; border-bottom: 1px solid rgba(255,255,255,0.06); }
        .sp-report-title { font-family: 'Fraunces', serif; font-size: 14px; font-weight: 700; color: #e4eaf5; }
        .sp-report-meta { font-size: 11px; color: rgba(228,234,245,0.3); margin-top: 3px; }
        .sp-report-section { margin-bottom: 18px; }
        .sp-report-label { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #4d9fff; font-weight: 600; margin-bottom: 10px; }
        .sp-chips { display: flex; flex-wrap: wrap; gap: 7px; }
        .sp-chip-item { font-size: 12px; padding: 4px 12px; border-radius: 6px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: rgba(228,234,245,0.55); }
        .sp-chip-blue { background: rgba(77,159,255,0.1); border-color: rgba(77,159,255,0.2); color: #6db3ff; }
        .sp-chip-amber { background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.18); color: #f5a623; }
        .sp-risk-bar { height: 3px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; margin-top: 10px; }
        .sp-risk-fill { height: 100%; width: 42%; background: linear-gradient(90deg, #1ec8a0, #f5a623); border-radius: 4px; }

        /* ── SECURITY ── */
        .sp-security { padding: 80px 0; border-top: 1px solid rgba(255,255,255,0.04); border-bottom: 1px solid rgba(255,255,255,0.04); }
        .sp-sec-row { display: flex; align-items: center; justify-content: center; gap: 56px; flex-wrap: wrap; }
        .sp-sec-item { display: flex; align-items: center; gap: 16px; }
        .sp-sec-icon {
          width: 42px; height: 42px;
          background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px; display: flex; align-items: center; justify-content: center;
          font-size: 18px; flex-shrink: 0;
        }
        .sp-sec-title { font-size: 13.5px; font-weight: 500; color: rgba(228,234,245,0.75); }
        .sp-sec-sub { font-size: 11.5px; color: rgba(228,234,245,0.3); margin-top: 2px; }

        /* ── PRICING ── */
        .sp-pricing-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 20px; margin-top: 60px; }
        .sp-price-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 20px; padding: 32px;
          transition: all 0.3s; position: relative; overflow: hidden;
        }
        .sp-price-card:hover { transform: translateY(-6px); border-color: rgba(255,255,255,0.12); }
        .sp-price-card-featured {
          border-color: rgba(77,159,255,0.3);
          box-shadow: 0 0 60px rgba(77,159,255,0.08);
        }
        .sp-price-card-featured::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, #4d9fff, #1ec8a0, transparent);
        }
        .sp-price-badge { display: inline-block; background: rgba(77,159,255,0.15); border: 1px solid rgba(77,159,255,0.3); color: #4d9fff; font-size: 11px; font-weight: 600; padding: 3px 12px; border-radius: 100px; letter-spacing: 0.06em; margin-bottom: 16px; }
        .sp-price-name { font-family: 'Fraunces', serif; font-size: 22px; font-weight: 700; color: #e4eaf5; margin-bottom: 10px; }
        .sp-price-amount { display: flex; align-items: baseline; gap: 2px; margin-bottom: 8px; }
        .sp-price-cur { font-size: 18px; color: rgba(228,234,245,0.4); }
        .sp-price-num { font-family: 'Fraunces', serif; font-size: 50px; font-weight: 800; color: #e4eaf5; letter-spacing: -2px; line-height: 1; }
        .sp-price-per { font-size: 14px; color: rgba(228,234,245,0.3); }
        .sp-price-desc { font-size: 13px; color: rgba(228,234,245,0.35); margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid rgba(255,255,255,0.05); line-height: 1.6; }
        .sp-price-feats { display: flex; flex-direction: column; gap: 10px; margin-bottom: 28px; }
        .sp-pf { font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
        .sp-pf-on { color: rgba(228,234,245,0.65); }
        .sp-pf-off { color: rgba(228,234,245,0.18); }
        .sp-pf-check { color: #1ec8a0; font-size: 12px; flex-shrink: 0; }
        .sp-pf-x { color: rgba(228,234,245,0.15); font-size: 12px; flex-shrink: 0; }
        .sp-price-btn {
          display: block; width: 100%; padding: 13px;
          border-radius: 100px; font-size: 13.5px; font-weight: 500;
          border: none; cursor: none; font-family: 'DM Sans', sans-serif;
          transition: all 0.25s; letter-spacing: 0.02em;
        }
        .sp-price-btn-primary {
          background: linear-gradient(135deg, #4d9fff, #1ec8a0);
          color: #060910;
          box-shadow: 0 0 30px rgba(77,159,255,0.2);
        }
        .sp-price-btn-primary:hover { box-shadow: 0 0 50px rgba(77,159,255,0.35); transform: translateY(-1px); }
        .sp-price-btn-ghost {
          background: transparent; color: rgba(228,234,245,0.5);
          border: 1px solid rgba(255,255,255,0.1);
        }
        .sp-price-btn-ghost:hover { color: #e4eaf5; border-color: rgba(255,255,255,0.2); }

        /* ── CTA SECTION ── */
        .sp-cta {
          padding: 140px 0; text-align: center;
          position: relative; overflow: hidden;
        }
        .sp-cta-orb {
          position: absolute; border-radius: 50%; pointer-events: none;
          filter: blur(80px);
        }
        .sp-cta-orb-1 { width: 600px; height: 400px; background: radial-gradient(ellipse, rgba(77,159,255,0.07), transparent); top: 50%; left: 50%; transform: translate(-50%, -60%); }
        .sp-cta-orb-2 { width: 300px; height: 300px; background: radial-gradient(ellipse, rgba(167,139,250,0.06), transparent); top: 20%; right: 15%; }
        .sp-cta-title {
          font-family: 'Fraunces', serif;
          font-size: clamp(40px, 5.5vw, 68px); font-weight: 800;
          line-height: 1.05; letter-spacing: -2px; color: #e4eaf5; margin-bottom: 18px;
        }
        .sp-cta-sub { font-size: 17px; color: rgba(228,234,245,0.4); margin-bottom: 44px; font-weight: 300; }
        .sp-cta-note { font-size: 12px; color: rgba(228,234,245,0.2); margin-top: 18px; }

        /* ── CONTACT ── */
        .sp-contact { padding: 100px 0; border-top: 1px solid rgba(255,255,255,0.04); }
        .sp-contact-inner { display: grid; grid-template-columns: 1fr 1fr; gap: 72px; align-items: center; }
        .sp-contact-title { font-family: 'Fraunces', serif; font-size: clamp(30px, 4vw, 46px); font-weight: 700; color: #e4eaf5; letter-spacing: -1px; margin: 0 0 14px; line-height: 1.1; }
        .sp-contact-sub { font-size: 15px; color: rgba(228,234,245,0.4); line-height: 1.75; font-weight: 300; margin: 0; }
        .sp-contact-cards { display: flex; flex-direction: column; gap: 14px; }
        .sp-contact-card {
          display: flex; align-items: center; gap: 18px;
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px; padding: 20px 22px;
          text-decoration: none; transition: all 0.3s;
        }
        .sp-contact-card:hover { border-color: rgba(255,255,255,0.12); transform: translateX(6px); background: rgba(255,255,255,0.04); }
        .sp-contact-card-icon { width: 46px; height: 46px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
        .sp-contact-card-icon-email { background: rgba(77,159,255,0.1); border: 1px solid rgba(77,159,255,0.18); }
        .sp-contact-card-icon-wa { background: rgba(37,211,102,0.1); border: 1px solid rgba(37,211,102,0.18); }
        .sp-contact-card-label { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: rgba(228,234,245,0.25); margin-bottom: 3px; }
        .sp-contact-card-value { font-size: 14.5px; font-weight: 500; color: #e4eaf5; }
        .sp-contact-card-sub { font-size: 11.5px; color: rgba(228,234,245,0.3); margin-top: 2px; }

        /* ── FOOTER ── */
        .sp-footer {
          padding: 40px 52px;
          border-top: 1px solid rgba(255,255,255,0.04);
          display: flex; align-items: center; justify-content: space-between;
          flex-wrap: wrap; gap: 16px;
        }
        .sp-foot-logo { font-family: 'Fraunces', serif; font-size: 22px; font-weight: 700; color: rgba(228,234,245,0.7); letter-spacing: -0.5px; }
        .sp-foot-logo span { color: #4d9fff; }
        .sp-foot-links { display: flex; gap: 26px; }
        .sp-foot-links a { font-size: 12.5px; color: rgba(228,234,245,0.25); text-decoration: none; transition: color 0.2s; }
        .sp-foot-links a:hover { color: rgba(228,234,245,0.6); }
        .sp-foot-copy { font-size: 12px; color: rgba(228,234,245,0.18); }

        /* ── AUTH MODAL ── */
        .sp-modal-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.8);
          backdrop-filter: blur(16px); z-index: 1000;
          display: flex; align-items: center; justify-content: center;
          padding: 16px; animation: sp-fade-in 0.25s ease;
        }
        @keyframes sp-fade-in { from { opacity: 0; } to { opacity: 1; } }
        .sp-modal {
          background: rgba(12,16,26,0.95);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 22px; padding: 36px;
          width: 100%; max-width: 420px;
          position: relative;
          animation: sp-slide-up 0.3s cubic-bezier(0.16,1,0.3,1);
          max-height: 90vh; overflow-y: auto;
          box-shadow: 0 40px 120px rgba(0,0,0,0.8), 0 0 0 1px rgba(77,159,255,0.05) inset;
        }
        .sp-modal::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, rgba(77,159,255,0.5), transparent);
        }
        @media (max-width: 480px) {
          .sp-modal { padding: 24px 18px; border-radius: 18px; }
          .sp-modal-overlay { align-items: flex-end; padding: 0 0 env(safe-area-inset-bottom,0); }
        }
        @keyframes sp-slide-up { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        .sp-modal-close {
          position: absolute; top: 16px; right: 16px;
          background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
          border-radius: 8px; width: 32px; height: 32px;
          display: flex; align-items: center; justify-content: center;
          cursor: none; color: rgba(228,234,245,0.4); transition: all 0.2s;
        }
        .sp-modal-close:hover { background: rgba(255,255,255,0.1); color: #e4eaf5; }
        .sp-modal-secure { font-size: 10px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #4d9fff; margin-bottom: 22px; }
        .sp-modal-recept { margin-top: 16px; padding: 14px 16px; border-radius: 12px; border: 1px solid rgba(30,200,160,0.2); background: rgba(30,200,160,0.05); }

        /* Responsive */
        @media (max-width: 900px) {
          .sp-nav { padding: 16px 24px; }
          .sp-nav-links { display: none; }
          .sp-container { padding: 0 24px; }
          .sp-stats-inner, .sp-how-grid, .sp-pricing-grid { grid-template-columns: 1fr; }
          .sp-feat-grid { grid-template-columns: 1fr; }
          .sp-contact-inner { grid-template-columns: 1fr; gap: 36px; }
          .sp-footer { padding: 28px 24px; flex-direction: column; align-items: flex-start; gap: 14px; }
          .sp-stats-inner .sp-stat-item { border-right: none; border-bottom: 1px solid rgba(255,255,255,0.06); }
          .sp-stats-inner .sp-stat-item:last-child { border-bottom: none; }
          .sp-section { padding: 80px 0; }
          .sp-trust { flex-direction: column; gap: 8px; }
          .sp-trust-sep { display: none; }
          .sp-hero-actions { flex-direction: column; align-items: stretch; }
          .sp-btn-primary, .sp-btn-ghost { justify-content: center; }
          .sp-sec-row { flex-direction: column; align-items: flex-start; gap: 28px; }
          .sp-cta { padding: 80px 0; }
        }
        @media (max-width: 480px) {
          .sp-nav { padding: 12px 18px; }
          .sp-hero { padding: 100px 18px 60px; }
          .sp-h1 { letter-spacing: -2px; }
          .sp-card { border-radius: 14px; }
          .sp-section { padding: 64px 0; }
        }
      `}</style>

      {/* ── CURSOR ── */}
      <div id="sp-cursor" />
      <div id="sp-cursor-ring" />
      <div id="sp-cursor-trail" />

      <div className="sp-page">

        {/* ── NAV ── */}
        <nav className="sp-nav" id="sp-nav">
          <a href="#" className="sp-logo">Sphota<span className="sp-logo-dot">.</span></a>
          <div className="sp-nav-links">
            <a href="#sp-features">Features</a>
            <a href="#sp-how">How it works</a>
            <a href="#sp-pricing">Pricing</a>
            <a href="#sp-contact">Contact</a>
          </div>
          <button className="sp-nav-cta" onClick={() => setAuthOpen(true)}>Request access</button>
        </nav>

        {/* ── HERO ── */}
        <section className="sp-hero">
          <canvas id="sp-brain-canvas" />

          <div className="sp-hero-content">
            <div className="sp-chip">
              <span className="sp-chip-dot" />
              Early access — India
            </div>

            <h1 className="sp-h1">
              Be present.<br />
              <span className="sp-h1-sub">We'll remember.</span>
            </h1>

            <p className="sp-hero-sub">
              Sphota listens to every session and turns it into{" "}
              <strong>clinical-grade documentation</strong> — so your attention stays where it matters.
            </p>

            <div className="sp-hero-actions">
              <button className="sp-btn-primary" onClick={() => setAuthOpen(true)}>
                Get early access
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <a href="#sp-how" className="sp-btn-ghost">See how it works</a>
            </div>

            <div className="sp-trust">
              <span className="sp-trust-item">DPDP Act 2023</span>
              <span className="sp-trust-sep">·</span>
              <span className="sp-trust-item">AES-256 encrypted</span>
              <span className="sp-trust-sep">·</span>
              <span className="sp-trust-item">6 Indian languages</span>
              <span className="sp-trust-sep">·</span>
              <span className="sp-trust-item">Built for Indian psychiatry</span>
            </div>
          </div>

          {/* Session card */}
          <div className="sp-card sp-reveal" style={{ animationDelay: "0.3s" }}>
            <div className="sp-card-header">
              <span className="sp-card-tag">Live session — Arjun K. · Follow-up</span>
              <span className="sp-card-live">
                <span className="sp-live-dot" /> Recording
              </span>
            </div>
            <div id="sp-waveform" />
            <div className="sp-transcript">
              <div className="sp-tline"><span className="sp-spk sp-spk-dr">Dr.</span>How have you been managing the medication schedule this week?</div>
              <div className="sp-tline"><span className="sp-spk sp-spk-pt">Pt.</span>Morning one I take regularly. Evening one I skip — makes me heavy next morning.</div>
              <div className="sp-tline"><span className="sp-spk sp-spk-dr">Dr.</span>When you skip it, do the thoughts get louder after a few days?</div>
              <div className="sp-tline"><span className="sp-spk sp-spk-pt">Pt.</span>Yes. Around day three or four. The commentary starts again.</div>
            </div>
            <div className="sp-card-footer">
              <div className="sp-spinner" />
              Generating SOAP documentation in background — your session continues uninterrupted
            </div>
          </div>
        </section>

        {/* ── STATS ── */}
        <section className="sp-stats">
          <div className="sp-stats-inner sp-reveal">
            <div className="sp-stat-item" style={{ "--stat-color": "#4d9fff" } as React.CSSProperties}>
              <div className="sp-stat-num sp-count-up" data-target="40%">40%</div>
              <div className="sp-stat-label"><strong>of clinical time</strong>lost to writing notes after sessions</div>
            </div>
            <div className="sp-stat-item sp-reveal-delay-1" style={{ "--stat-color": "#f5a623" } as React.CSSProperties}>
              <div className="sp-stat-num sp-count-up" data-target="23m">23m</div>
              <div className="sp-stat-label"><strong>average documentation time</strong>per 30-minute session</div>
            </div>
            <div className="sp-stat-item sp-reveal-delay-2" style={{ "--stat-color": "#1ec8a0" } as React.CSSProperties}>
              <div className="sp-stat-num sp-count-up" data-target="<90s">&lt;90s</div>
              <div className="sp-stat-label"><strong>with Sphota</strong>review, edit, sign. Done.</div>
            </div>
          </div>
        </section>

        {/* ── FEATURES ── */}
        <section className="sp-section" id="sp-features">
          <div className="sp-container">
            <div className="sp-reveal">
              <p className="sp-section-eyebrow">What Sphota does</p>
              <h2 className="sp-section-title">Everything a psychiatrist needs.<br />Nothing they don't.</h2>
              <p className="sp-section-sub">Built specifically for the Indian clinical context — joint families, code-switching, paper records, and all.</p>
            </div>
            <div className="sp-feat-grid sp-reveal" style={{ transitionDelay: "0.1s" }}>
              {[
                { icon: "⏱", title: "Real-time transcription", desc: "Sessions transcribed as they happen. Review before generating — nothing processed without your approval.", tag: "Live · Editable" },
                { icon: "📋", title: "SOAP · BIRP · DAP notes", desc: "Choose your format. Generates structured clinical documentation with DSM-5-TR coding and risk stratification.", tag: "ICD-10 · DSM-5" },
                { icon: "🌐", title: "Patient letters in 6 languages", desc: "Plain-language letters in Hindi, Marathi, Bengali, Tamil, Telugu, and English — ready in seconds.", tag: "हिंदी · মराठী · বাংলা · தமிழ்" },
                { icon: "📷", title: "Paper record scanner", desc: "Photograph old paper files. Sphota extracts structured clinical history — turning years of paper into searchable data.", tag: "India-first feature" },
                { icon: "💊", title: "Medication intelligence", desc: "Auto-populated medication cards with mechanism of action, drug class, and monitoring parameters.", tag: "Premium" },
                { icon: "🚨", title: "Priority risk flags", desc: "Every session screened for suicidal ideation, command hallucinations, and medication non-adherence patterns.", tag: "Always-on" },
              ].map((f, i) => (
                <div className="sp-feat-card" key={i}>
                  <span className="sp-feat-icon">{f.icon}</span>
                  <div className="sp-feat-title">{f.title}</div>
                  <div className="sp-feat-desc">{f.desc}</div>
                  <span className="sp-feat-tag">↳ {f.tag}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── HOW IT WORKS ── */}
        <section className="sp-section" id="sp-how" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
          <div className="sp-container">
            <div className="sp-how-grid">
              <div className="sp-reveal">
                <p className="sp-section-eyebrow">How it works</p>
                <h2 className="sp-section-title">Three steps.<br />Zero paperwork.</h2>
                <p className="sp-section-sub" style={{ marginBottom: 40 }}>From first word spoken to signed clinical note — in under two minutes.</p>
                <div className="sp-steps">
                  {[
                    { n: "01", title: "Record the session", desc: "Hit record when the patient walks in. Sphota transcribes in real time. You stay fully present." },
                    { n: "02", title: "Review the transcript", desc: "The transcript is editable before the note is generated. Confirm accuracy, correct anything." },
                    { n: "03", title: "Sign off in 90 seconds", desc: "Sphota generates the full clinical note. Review, edit if needed, sign. Patient letter ready in your chosen language." },
                  ].map((s, i) => (
                    <div className="sp-step" key={i}>
                      <div className="sp-step-line" />
                      <div className="sp-step-num">{s.n}</div>
                      <div>
                        <div className="sp-step-title">{s.title}</div>
                        <div className="sp-step-desc">{s.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="sp-report-card sp-reveal sp-reveal-delay-2">
                <div className="sp-report-header">
                  <div>
                    <div className="sp-report-title">SOAP Report — Arjun K., 19M</div>
                    <div className="sp-report-meta">Generated in 14 seconds · June 3, 2026</div>
                  </div>
                </div>
                <div className="sp-report-section">
                  <div className="sp-report-label">Probable diagnosis</div>
                  <div className="sp-chips">
                    <span className="sp-chip-item sp-chip-blue">Schizophrenia F20.0</span>
                    <span className="sp-chip-item sp-chip-blue">Partial remission</span>
                    <span className="sp-chip-item">DSM-5-TR 295.90</span>
                  </div>
                </div>
                <div className="sp-report-section">
                  <div className="sp-report-label">Key signals</div>
                  <div className="sp-chips">
                    <span className="sp-chip-item">Commentary hallucinations</span>
                    <span className="sp-chip-item sp-chip-amber">Med non-adherence</span>
                    <span className="sp-chip-item">Ideas of reference</span>
                    <span className="sp-chip-item sp-chip-amber">Akathisia</span>
                  </div>
                </div>
                <div className="sp-report-section">
                  <div className="sp-report-label">Risk level</div>
                  <div className="sp-risk-bar"><div className="sp-risk-fill" /></div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "rgba(228,234,245,0.25)", marginTop: 6 }}>
                    <span>Low — current</span><span style={{ color: "#1ec8a0" }}>Mitigated</span>
                  </div>
                </div>
                <div className="sp-report-section">
                  <div className="sp-report-label">Patient letter ready in</div>
                  <div className="sp-chips">
                    {["English","हिंदी","मराठी","বাংলা","தமிழ்"].map(l => (
                      <span className="sp-chip-item" key={l}>{l}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── DEMO VIDEO ── */}
        <section className="sp-section sp-reveal" style={{ borderTop: "1px solid rgba(255,255,255,0.04)", paddingTop: 80, paddingBottom: 80 }}>
          <div className="sp-container" style={{ maxWidth: 860 }}>
            <p className="sp-section-eyebrow" style={{ textAlign: "center" }}>See it in action</p>
            <h2 className="sp-section-title" style={{ textAlign: "center", marginBottom: 12 }}>Your notes write themselves. Watch.</h2>
            <p className="sp-section-sub" style={{ textAlign: "center", marginBottom: 40 }}>A real session. A real report. Under 60 seconds.</p>
            <div style={{
              position: "relative",
              width: "100%",
              borderRadius: 20,
              overflow: "hidden",
              boxShadow: "0 0 60px rgba(30,200,160,0.12), 0 24px 64px rgba(0,0,0,0.5)",
              border: "1px solid rgba(255,255,255,0.06)",
              background: "#000",
            }}>
              <video
                src="/sphota_demo_FINAL.mp4"
                controls
                playsInline
                preload="metadata"
                style={{
                  display: "block",
                  width: "100%",
                  height: "auto",
                  maxHeight: "520px",
                  borderRadius: 20,
                }}
              >
                Your browser does not support the video tag.
              </video>
            </div>
          </div>
        </section>

        {/* ── SECURITY ── */}
        <section className="sp-security sp-reveal">
          <div className="sp-container">
            <div className="sp-sec-row">
              {[
                { icon: "🔐", title: "AES-256 encryption", sub: "Patient data encrypted at field level" },
                { icon: "⚖️", title: "DPDP Act 2023", sub: "India's data protection law compliant" },
                { icon: "🛡️", title: "PII stripping", sub: "Identifiers removed before any AI processing" },
                { icon: "📝", title: "Full audit log", sub: "Every access event recorded and exportable" },
              ].map((s, i) => (
                <div className="sp-sec-item" key={i}>
                  <div className="sp-sec-icon">{s.icon}</div>
                  <div>
                    <div className="sp-sec-title">{s.title}</div>
                    <div className="sp-sec-sub">{s.sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── PRICING ── */}
        <section className="sp-section" id="sp-pricing">
          <div className="sp-container">
            <div className="sp-reveal" style={{ textAlign: "center" }}>
              <p className="sp-section-eyebrow" style={{ justifyContent: "center" }}>Pricing</p>
              <h2 className="sp-section-title" style={{ textAlign: "center" }}>Simple. Honest.<br />Built for Indian practice.</h2>
              <p className="sp-section-sub" style={{ margin: "0 auto" }}>No per-session charges. No hidden processing costs. Flat monthly rate.</p>
            </div>
            <div className="sp-pricing-grid sp-reveal sp-reveal-delay-1" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
              {/* ── FREE TIER ── */}
              <div className="sp-price-card">
                <div className="sp-price-name">Free</div>
                <div className="sp-price-amount"><span className="sp-price-num" style={{ fontSize: 28 }}>₹0</span><span className="sp-price-per">/month</span></div>
                <div className="sp-price-desc">Try Sphota free — 30 reports/month. All features included.</div>
                <div className="sp-price-feats">
                  {["30 reports/month","All note formats (SOAP · BIRP · DAP)","DSM-5-TR / ICD-11 references","Medication intelligence","Patient letters (6 languages)","All features unlocked"].map(f => <div className="sp-pf sp-pf-on" key={f}><span className="sp-pf-check">✓</span>{f}</div>)}
                  {["Feedback bonus: +10 extra reports"].map(f => <div className="sp-pf sp-pf-on" key={f} style={{ color: "#f59e0b" }}><span className="sp-pf-check" style={{ color: "#f59e0b" }}>★</span>{f}</div>)}
                </div>
                <button className="sp-price-btn sp-price-btn-ghost" onClick={() => { localStorage.removeItem("sphota_pending_plan"); setMode("signup"); setAuthOpen(true); }}>Start free →</button>
              </div>
              <div className="sp-price-card">
                <div className="sp-price-name">Starter</div>
                <div className="sp-price-amount"><span className="sp-price-cur">₹</span><span className="sp-price-num">999</span><span className="sp-price-per">/month</span></div>
                <div className="sp-price-desc">For solo practitioners — 75 sessions a month.</div>
                <div className="sp-price-feats">
                  {["75 sessions/month","SOAP · BIRP · DAP notes","Patient letters (Hindi & English)","Medication tracking","Progress tracking (PHQ-9 / GAD-7)"].map(f => <div className="sp-pf sp-pf-on" key={f}><span className="sp-pf-check">✓</span>{f}</div>)}
                  {["Paper record scanner","DSM/ICD inline references","Medication descriptions","WhatsApp notifications"].map(f => <div className="sp-pf sp-pf-off" key={f}><span className="sp-pf-x">✗</span>{f}</div>)}
                </div>
                <button className="sp-price-btn sp-price-btn-ghost" onClick={() => { localStorage.setItem("sphota_pending_plan","starter"); setMode("signup"); setAuthOpen(true); }}>Get started</button>
              </div>
              <div className="sp-price-card sp-price-card-featured">
                <div className="sp-price-badge">Most popular</div>
                <div className="sp-price-name">Clinical</div>
                <div className="sp-price-amount"><span className="sp-price-cur">₹</span><span className="sp-price-num">2499</span><span className="sp-price-per">/month</span></div>
                <div className="sp-price-desc">For active practices. Unlimited sessions, full workflow.</div>
                <div className="sp-price-feats">
                  {["Unlimited sessions","All note formats","Patient letters (6 languages)","Paper record scanner","WhatsApp patient notifications","Advanced analytics"].map(f => <div className="sp-pf sp-pf-on" key={f}><span className="sp-pf-check">✓</span>{f}</div>)}
                  {["DSM/ICD inline references","Medication descriptions"].map(f => <div className="sp-pf sp-pf-off" key={f}><span className="sp-pf-x">✗</span>{f}</div>)}
                </div>
                <button className="sp-price-btn sp-price-btn-primary" onClick={() => { localStorage.setItem("sphota_pending_plan","clinical"); setMode("signup"); setAuthOpen(true); }}>Get started</button>
              </div>
              <div className="sp-price-card">
                <div className="sp-price-name">Premium</div>
                <div className="sp-price-amount"><span className="sp-price-cur">₹</span><span className="sp-price-num">3999</span><span className="sp-price-per">/month</span></div>
                <div className="sp-price-desc">Everything. No restrictions. Priority support.</div>
                <div className="sp-price-feats">
                  {["Everything in Clinical","DSM-5-TR / ICD-11 inline references","Medication MOA + monitoring notes","Priority support","Early access to new features"].map(f => <div className="sp-pf sp-pf-on" key={f}><span className="sp-pf-check">✓</span>{f}</div>)}
                </div>
                <button className="sp-price-btn sp-price-btn-ghost" onClick={() => { localStorage.setItem("sphota_pending_plan","premium"); setMode("signup"); setAuthOpen(true); }}>Get started</button>
              </div>
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="sp-cta">
          <div className="sp-cta-orb sp-cta-orb-1" />
          <div className="sp-cta-orb sp-cta-orb-2" />
          <div className="sp-container sp-reveal" style={{ position: "relative", zIndex: 1 }}>
            <h2 className="sp-cta-title">Your next session<br />deserves your full attention.</h2>
            <p className="sp-cta-sub">Join the early access waitlist — limited spots for Indian psychiatrists.</p>
            <button className="sp-btn-primary" style={{ margin: "0 auto" }} onClick={() => setAuthOpen(true)}>
              Request early access →
            </button>
            <p className="sp-cta-note">No spam. No obligation. We'll reach out personally.</p>
          </div>
        </section>

        {/* ── CONTACT ── */}
        <section className="sp-contact" id="sp-contact">
          <div className="sp-container">
            <div className="sp-contact-inner sp-reveal">
              <div>
                <p className="sp-section-eyebrow">Get in touch</p>
                <h2 className="sp-contact-title">Have questions?<br />We'd love to hear from you.</h2>
                <p className="sp-contact-sub" style={{ marginTop: 14 }}>We're a small team and respond personally — whether you're a psychiatrist curious about early access, a clinic looking to try it, or just want to know more.</p>
              </div>
              <div className="sp-contact-cards">
                <a href="mailto:getsphota@gmail.com" className="sp-contact-card">
                  <div className="sp-contact-card-icon sp-contact-card-icon-email">✉️</div>
                  <div>
                    <div className="sp-contact-card-label">Email us</div>
                    <div className="sp-contact-card-value">getsphota@gmail.com</div>
                    <div className="sp-contact-card-sub">We reply within 24 hours</div>
                  </div>
                </a>
                <a href="https://wa.me/79998408871" target="_blank" rel="noopener noreferrer" className="sp-contact-card">
                  <div className="sp-contact-card-icon sp-contact-card-icon-wa">💬</div>
                  <div>
                    <div className="sp-contact-card-label">WhatsApp</div>
                    <div className="sp-contact-card-value">Chat with us</div>
                    <div className="sp-contact-card-sub">Quick questions welcome</div>
                  </div>
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ── FOOTER ── */}
        <footer className="sp-footer">
          <div className="sp-foot-logo">Sphota<span>.</span></div>
          <div className="sp-foot-links">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="mailto:getsphota@gmail.com">Contact</a>
          </div>
          <div className="sp-foot-copy">© 2026 Sphota — Built for Indian psychiatry.</div>
        </footer>

      </div>

      {/* ── AUTH MODAL ── */}
      {authOpen && (
        <div className="sp-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setAuthOpen(false); }}>
          <div className="sp-modal">
            <button className="sp-modal-close" onClick={() => setAuthOpen(false)} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
            <div className="sp-modal-secure">🔒 Secure workspace</div>
            {mfaPending ? (
              <div>
                <h2 className="landing-login-title">Two-factor verification</h2>
                <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>Enter the 6-digit code from your authenticator app.</p>
                <form onSubmit={handleMfaVerify} className="landing-form">
                  <input type="text" inputMode="numeric" placeholder="000000" maxLength={6} value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/\D/g, ""))} disabled={busy} className="landing-input" autoComplete="one-time-code" style={{ letterSpacing: "0.3em", textAlign: "center", fontSize: 22 }} autoFocus />
                  {mfaError && <p className="landing-msg landing-msg--error">{mfaError}</p>}
                  <button type="submit" disabled={busy || mfaCode.length !== 6} className="landing-login-btn">{busy ? "Verifying…" : "Verify →"}</button>
                  <button type="button" className="landing-forgot-btn" onClick={() => { setMfaPending(false); setMfaCode(""); setMfaError(""); }}>← Back to sign in</button>
                </form>
              </div>
            ) : (
              <>
                {mode !== "reset-password" && (
                  <div className="landing-tabs">
                    <button className={`landing-tab-btn${mode === "login" ? " active" : ""}`} onClick={() => switchMode("login")} type="button">Sign in</button>
                    <button className={`landing-tab-btn${mode === "signup" ? " active" : ""}`} onClick={() => switchMode("signup")} type="button">Create account</button>
                  </div>
                )}
                <h2 className="landing-login-title">
                  {mode === "login" && "Welcome back"}
                  {mode === "signup" && "Create account"}
                  {mode === "reset-password" && "Reset your password"}
                </h2>
                {mode === "reset-password" && (
                  <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>Enter your email and we'll send a password reset link.</p>
                )}
                <form onSubmit={handleSubmit} className="landing-form">
                  <input type="email" placeholder="Email address" value={email} onChange={e => setEmail(e.target.value)} disabled={busy} className="landing-input" autoComplete="email" />
                  {mode !== "reset-password" && (
                    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} className="landing-input" autoComplete={mode === "login" ? "current-password" : "new-password"} />
                  )}
                  {mode === "login" && (
                    <button type="button" className="landing-forgot-btn" onClick={() => switchMode("reset-password")} disabled={busy}>Forgot password?</button>
                  )}
                  {mode === "signup" && (
                    <div className="landing-field">
                      <label className="landing-field-label">Country / Data Region</label>
                      <select value={country} onChange={e => setCountry(e.target.value)} disabled={busy} className="landing-select">
                        {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  )}
                  {mode === "signup" && (
                    <div className="landing-field">
                      <label className="landing-field-label">MCI / State Medical Council Registration No. <span style={{ color: "#ef4444" }}>*</span></label>
                      <input type="text" placeholder="e.g. MH-12345 or 123456" value={mciNumber} onChange={e => setMciNumber(e.target.value)} disabled={busy} className="landing-input" autoComplete="off" maxLength={30} />
                      <p style={{ fontSize: 11, color: "#64748b", margin: "4px 0 0", lineHeight: 1.4 }}>Required for clinical use. Format varies by state council.</p>
                    </div>
                  )}
                  {error && <p className="landing-msg landing-msg--error">{error}</p>}
                  {info  && <p className="landing-msg landing-msg--info">{info}</p>}
                  <button type="submit" disabled={busy} className="landing-login-btn">{submitLabel()}</button>
                  {mode === "reset-password" && (
                    <button type="button" className="landing-forgot-btn" onClick={() => switchMode("login")} style={{ textAlign: "center", width: "100%", marginTop: 4 }}>← Back to sign in</button>
                  )}
                </form>
              </>
            )}
            {!mfaPending && (
              <>
                <div className="landing-lock-note">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                    <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  End-to-end encrypted · Patient data never leaves your control
                </div>
                <div className="sp-modal-recept">
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1ec8a0" }}>Reception staff</p>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b", lineHeight: 1.4 }}>Already have an account? Sign in above — you'll land on the reception dashboard.</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
