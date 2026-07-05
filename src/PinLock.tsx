import { useState, useEffect, useRef } from "react";
import * as db from "./db";
import bcrypt from "bcryptjs";
import { supabase } from "./supabase";

const PIN_LEN = 6;

// ── Dot indicators ─────────────────────────────────────────────
function PinDots({ filled }: { filled: number }) {
  return (
    <div className="pin-dots">
      {Array.from({ length: PIN_LEN }).map((_, i) => (
        <div key={i} className={`pin-dot ${i < filled ? "filled" : ""}`} />
      ))}
    </div>
  );
}

// ── Number pad ────────────────────────────────────────────────
const KEY_LETTERS: Record<string, string> = {
  "2": "abc", "3": "def", "4": "ghi", "5": "jkl",
  "6": "mno", "7": "pqrs", "8": "tuv", "9": "wxyz", "0": "+"
};

function PinPad({ onDigit, onBack, disabled }: {
  onDigit: (d: string) => void; onBack: () => void; disabled?: boolean;
}) {
  const keys = ["1","2","3","4","5","6","7","8","9","","0","back"];
  return (
    <div className={`pin-pad ${disabled ? "pin-pad--disabled" : ""}`}>
      {keys.map((k, i) =>
        k === "" ? <div key={i} /> :
        k === "back" ? (
          <button key={i} className="pin-key pin-key-back" onClick={onBack} disabled={disabled} aria-label="Delete">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="18" y1="9" x2="12" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="9" x2="18" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        ) : (
          <button key={i} className="pin-key" onClick={() => onDigit(k)} disabled={disabled}>
            <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{k}</span>
            {KEY_LETTERS[k] && <span className="pin-key-letters">{KEY_LETTERS[k]}</span>}
          </button>
        )
      )}
    </div>
  );
}

// ── Step progress bar ──────────────────────────────────────────
function PinSteps({ current }: { current: number }) {
  return (
    <div className="pin-step-bar">
      {[0, 1, 2].map(i => (
        <div key={i} className={`pin-step-seg ${i < current ? "done" : i === current ? "active" : ""}`} />
      ))}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// PIN SETUP SCREEN (first launch)
// ═════════════════════════════════════════════════════════════
export function PinSetup({ onDone }: { onDone: () => void }) {
  const [phase,    setPhase]    = useState<"create" | "confirm">("create");
  const [firstPin, setFirstPin] = useState("");
  const [entry,    setEntry]    = useState("");
  const [error,    setError]    = useState("");
  const [shake,    setShake]    = useState(false);
  const [saving,   setSaving]   = useState(false);

  function doShake() { setShake(true); setTimeout(() => setShake(false), 500); }

  function handleDigit(d: string) {
    if (entry.length >= PIN_LEN || saving) return;
    const next = entry + d;
    setEntry(next);

    if (next.length === PIN_LEN) {
      setTimeout(async () => {
        if (phase === "create") {
          setFirstPin(next);
          setEntry("");
          setPhase("confirm");
          setError("");
        } else {
          if (next === firstPin) {
            setSaving(true);
            try {
              const hash = await bcrypt.hash(next, 12);
              await db.setPinHash(hash);
              onDone();
            } catch {
              setError("Failed to save PIN. Please try again.");
              setEntry("");
              setSaving(false);
            }
          } else {
            doShake();
            setEntry("");
            setError("PINs don't match — try again.");
          }
        }
      }, 120);
    }
  }

  function handleBack() { setEntry(e => e.slice(0, -1)); }

  return (
    <div className="pin-screen" data-theme="dark">
      <div className="pin-card">
        <div className="pin-brand">Sphota</div>
        <div className="pin-avatar-wrap">
          <div className="pin-ring" />
          <div className="pin-avatar-inner" style={{ fontSize: 28 }}>🔐</div>
        </div>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h1 className="pin-heading">Secure your<br /><em>workspace</em></h1>
          <p className="pin-sub" style={{ marginBottom: 0 }}>
            {phase === "create"
              ? "Choose a 6-digit PIN to protect your patients’ privacy."
              : "Re-enter your PIN to confirm"}
          </p>
        </div>
        <PinSteps current={phase === "create" ? 0 : 1} />
        <div className={shake ? "pin-shake" : ""}>
          <PinDots filled={entry.length} />
        </div>
        {error
          ? <p className="pin-error-msg">{error}</p>
          : <p className="pin-label">{phase === "create" ? "Choose PIN" : "Confirm PIN"}</p>
        }
        <PinPad onDigit={handleDigit} onBack={handleBack} disabled={saving} />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// PIN ENTRY SCREEN (every session start)
// ═════════════════════════════════════════════════════════════
export function PinEntry({ onUnlock, onForgotPin }: {
  onUnlock: () => void; onForgotPin: () => void;
}) {
  const [entry,         setEntry]         = useState("");
  const [error,         setError]         = useState("");
  const [shake,         setShake]         = useState(false);
  const [forgotConfirm, setForgotConfirm] = useState(false);
  const [verifying,     setVerifying]     = useState(false);

  const MAX_TRIES = 5;
  const LOCKOUT   = 30;

  // Read persisted attempts and lockout from localStorage on mount
  const storedAttempts = parseInt(localStorage.getItem("sphota_pin_attempts") ?? "0", 10) || 0;
  const storedLockedUntil = parseInt(localStorage.getItem("sphota_pin_locked_until") ?? "0", 10) || 0;
  const _now = Date.now();
  const initialSecsLeft = storedLockedUntil > _now ? Math.ceil((storedLockedUntil - _now) / 1000) : 0;

  const [attempts,      setAttempts]      = useState(storedAttempts);
  const [locked,        setLocked]        = useState(initialSecsLeft > 0);
  const [secs,          setSecs]          = useState(initialSecsLeft);

  useEffect(() => {
    if (!locked) return;
    const t = setInterval(() => {
      setSecs(s => {
        if (s <= 1) {
          setLocked(false);
          setAttempts(0);
          localStorage.removeItem("sphota_pin_attempts");
          localStorage.removeItem("sphota_pin_locked_until");
          clearInterval(t);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [locked]);

  function doShake() { setShake(true); setTimeout(() => setShake(false), 500); }

  function handleDigit(d: string) {
    if (locked || verifying || entry.length >= PIN_LEN) return;
    const next = entry + d;
    setEntry(next);

    if (next.length === PIN_LEN) {
      setTimeout(async () => {
        setVerifying(true);
        try {
          const hash = await db.getPinHash();
          const ok = hash ? await bcrypt.compare(next, hash) : false;
          if (ok) {
            localStorage.removeItem("sphota_pin_attempts");
            localStorage.removeItem("sphota_pin_locked_until");
            onUnlock();
          } else {
            const att = attempts + 1;
            setAttempts(att);
            localStorage.setItem("sphota_pin_attempts", String(att));
            doShake();
            setEntry("");
            if (att >= MAX_TRIES) {
              const lockedUntil = Date.now() + LOCKOUT * 1000;
              localStorage.setItem("sphota_pin_locked_until", String(lockedUntil));
              setLocked(true);
              setSecs(LOCKOUT);
              setError(`Too many attempts. Locked for ${LOCKOUT}s.`);
            } else {
              setError(`Incorrect PIN · ${MAX_TRIES - att} attempt${MAX_TRIES - att !== 1 ? "s" : ""} left`);
            }
          }
        } catch {
          setEntry("");
          setError("Error verifying PIN. Try again.");
        } finally {
          setVerifying(false);
        }
      }, 120);
    }
  }

  function handleBack() { if (!locked && !verifying) setEntry(e => e.slice(0, -1)); }

  // Get initials from doctor name for avatar
  const doctorInitial = "D";

  return (
    <div className="pin-screen" data-theme="dark">
      <div className="pin-card">
        <div className="pin-brand">
          Sphota
        </div>
        {/* ── Animated avatar ring ── */}
        <div className="pin-avatar-wrap">
          <div className="pin-ring" />
          <div className="pin-avatar-inner">{doctorInitial}</div>
        </div>
        {/* ── Welcome back title + PIN sub — stacked, no collision ── */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h1 className="pin-heading">Welcome back,<br /><em>Doctor</em></h1>
          <p className="pin-sub" style={{ marginBottom: 0 }}>Enter your PIN to continue</p>
        </div>
        <div className={shake ? "pin-shake" : ""}>
          <PinDots filled={entry.length} />
        </div>
        {locked
          ? <p className="pin-locked-msg">🔒 Locked · retry in {secs}s</p>
          : error
            ? <p className="pin-error-msg">{error}</p>
            : <p className="pin-label">{verifying ? "Verifying…" : "Enter your 6-digit PIN"}</p>
        }
        <PinPad onDigit={handleDigit} onBack={handleBack} disabled={locked || verifying} />
        {!forgotConfirm ? (
          <button className="pin-forgot-link" onClick={() => setForgotConfirm(true)}>
            Forgot PIN?
          </button>
        ) : (
          <div className="pin-forgot-confirm">
            <p className="pin-forgot-confirm-msg">
              We'll send a verification code to your email to confirm your identity. Your patient data will <strong>not</strong> be deleted.
            </p>
            <div className="pin-forgot-confirm-actions">
              <button className="pin-forgot-cancel" onClick={() => setForgotConfirm(false)}>Cancel</button>
              <button className="pin-forgot-reset" onClick={onForgotPin}>Verify via email</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// FORGOT PIN — EMAIL OTP VERIFICATION SCREEN
// ═════════════════════════════════════════════════════════════
export function ForgotPinScreen({ onVerified, onBack }: {
  onVerified: () => void;
  onBack: () => void;
}) {
  const [phase, setPhase]       = useState<"sending" | "code" | "verifying" | "error">("sending");
  const [email, setEmail]       = useState("");
  const [code, setCode]         = useState(["", "", "", "", "", "", "", ""]);
  const [errorMsg, setErrorMsg] = useState("");
  const [resendSecs, setResendSecs] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => { sendOtp(); }, []);

  useEffect(() => {
    if (resendSecs <= 0) return;
    const t = setTimeout(() => setResendSecs(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendSecs]);

  async function sendOtp() {
    setPhase("sending");
    setErrorMsg("");
    try {
      const { data } = await supabase.auth.getUser();
      const userEmail = data.user?.email ?? "";
      if (!userEmail) throw new Error("No email address found for your account.");
      setEmail(userEmail);
      const { error } = await supabase.auth.signInWithOtp({
        email: userEmail,
        options: {
          shouldCreateUser: false,
        },
      });
      if (error) throw error;
      setPhase("code");
      setResendSecs(60);
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } catch (e: any) {
      setErrorMsg(e.message ?? "Failed to send verification email.");
      setPhase("error");
    }
  }

  function handleChange(idx: number, val: string) {
    const digit = val.replace(/\D/g, "").slice(-1);
    const next = [...code];
    next[idx] = digit;
    setCode(next);
    if (digit && idx < 7) inputRefs.current[idx + 1]?.focus();
    if (next.every(d => d) && digit) verifyCode(next.join(""));
  }

  function handleKeyDown(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !code[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && idx > 0) inputRefs.current[idx - 1]?.focus();
    if (e.key === "ArrowRight" && idx < 7) inputRefs.current[idx + 1]?.focus();
  }

  function handlePaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 8);
    if (!text) return;
    e.preventDefault();
    const next = ["", "", "", "", "", "", "", ""];
    for (let i = 0; i < 8; i++) next[i] = text[i] ?? "";
    setCode(next);
    const focusIdx = Math.min(text.length, 7);
    inputRefs.current[focusIdx]?.focus();
    if (text.length === 8) verifyCode(text);
  }

  async function verifyCode(token: string) {
    setPhase("verifying");
    setErrorMsg("");
    try {
      // Try "email" OTP type first (works if Supabase is configured to show code in email).
      // If that fails, try "magiclink" type (works with default Supabase magic-link emails).
      let result = await supabase.auth.verifyOtp({ email, token, type: "email" });
      if (result.error) {
        result = await supabase.auth.verifyOtp({ email, token, type: "magiclink" });
      }
      const { error } = result;
      if (error) throw error;
      onVerified();
    } catch {
      setErrorMsg("Invalid or expired code. Please try again.");
      setCode(["", "", "", "", "", "", "", ""]);
      setPhase("code");
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    }
  }

  const maskedEmail = email
    ? email.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + "*".repeat(Math.max(0, b.length)) + c)
    : "";

  return (
    <div className="pin-screen" data-theme="dark">
      <div className="pin-card pin-otp-card">
        <div className="pin-brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2a5 5 0 1 0 0 10A5 5 0 0 0 12 2zM4 20a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          Sphota
        </div>

        <div className="pin-otp-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" strokeWidth="2"/>
            <path d="M2 8l10 7 10-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </div>

        <h1 className="pin-heading">Check your email</h1>

        {phase === "sending" && (
          <>
            <p className="pin-sub">Sending verification code…</p>
            <div className="pin-otp-spinner" />
          </>
        )}

        {phase === "error" && (
          <>
            <p className="pin-sub">Could not send a verification email.</p>
            <p className="pin-otp-error">{errorMsg}</p>
            <button className="pin-otp-btn pin-otp-btn--primary" onClick={sendOtp}>
              Try again
            </button>
            <button className="pin-otp-back" onClick={onBack}>← Back to PIN entry</button>
          </>
        )}

        {(phase === "code" || phase === "verifying") && (
          <>
            <p className="pin-sub">
              We sent an 8-digit code to<br />
              <strong className="pin-otp-email">{maskedEmail}</strong>
            </p>

            <div className="pin-otp-boxes" onPaste={handlePaste}>
              {code.map((digit, i) => (
                <input
                  key={i}
                  ref={el => { inputRefs.current[i] = el; }}
                  className={`pin-otp-box${phase === "verifying" ? " pin-otp-box--busy" : ""}`}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={e => handleChange(i, e.target.value)}
                  onKeyDown={e => handleKeyDown(i, e)}
                  disabled={phase === "verifying"}
                  autoComplete="one-time-code"
                />
              ))}
            </div>

            {errorMsg
              ? <p className="pin-otp-error">{errorMsg}</p>
              : <p className="pin-otp-hint">
                  {phase === "verifying" ? "Verifying…" : "Enter the code from your email"}
                </p>
            }

            <div className="pin-otp-resend-row">
              {resendSecs > 0
                ? <span className="pin-otp-resend-wait">Resend in {resendSecs}s</span>
                : <button className="pin-otp-resend-btn" onClick={sendOtp}>Resend code</button>
              }
            </div>

            <button className="pin-otp-back" onClick={onBack}>← Back to PIN entry</button>
          </>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// CHANGE PIN MODAL (inside app)
// ═════════════════════════════════════════════════════════════
type ChangeStep = "current" | "new" | "confirm";
const STEP_IDX: Record<ChangeStep, number> = { current: 0, new: 1, confirm: 2 };

export function ChangePinModal({ onClose }: { onClose: () => void }) {
  const [step,    setStep]    = useState<ChangeStep>("current");
  const [entries, setEntries] = useState<Record<ChangeStep, string>>({ current: "", new: "", confirm: "" });
  const [error,   setError]   = useState("");
  const [shake,   setShake]   = useState(false);
  const [success, setSuccess] = useState(false);
  const [busy,    setBusy]    = useState(false);

  function doShake() { setShake(true); setTimeout(() => setShake(false), 500); }

  function handleDigit(d: string) {
    const cur = entries[step];
    if (cur.length >= PIN_LEN || busy) return;
    const next = { ...entries, [step]: cur + d };
    setEntries(next);

    if (next[step].length === PIN_LEN) {
      setTimeout(async () => {
        setBusy(true);
        try {
          if (step === "current") {
            const hash = await db.getPinHash();
            const ok = hash ? await bcrypt.compare(next.current, hash) : false;
            if (ok) { setStep("new"); setError(""); }
            else { doShake(); setEntries({ ...next, current: "" }); setError("Incorrect PIN."); }
          } else if (step === "new") {
            setStep("confirm"); setError("");
          } else {
            if (next.confirm === next.new) {
              const newHash = await bcrypt.hash(next.new, 12);
              await db.setPinHash(newHash);
              setSuccess(true);
              setTimeout(onClose, 1800);
            } else {
              doShake();
              setEntries({ ...next, new: "", confirm: "" });
              setStep("new");
              setError("PINs don't match — re-enter new PIN.");
            }
          }
        } catch {
          setError("An error occurred. Please try again.");
        } finally {
          setBusy(false);
        }
      }, 120);
    }
  }

  function handleBack() {
    setEntries(e => ({ ...e, [step]: e[step].slice(0, -1) }));
  }

  const labels: Record<ChangeStep, { title: string; sub: string }> = {
    current: { title: "Current PIN",     sub: "Confirm your identity first"     },
    new:     { title: "New PIN",         sub: "Choose a new 6-digit PIN"        },
    confirm: { title: "Confirm new PIN", sub: "Enter the same PIN once more"    },
  };

  if (success) return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: 320 }}>
        <div className="pin-success-card">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="#10b981" strokeWidth="2"/>
            <polyline points="9 12 11 14 15 10" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <p className="pin-success-title">PIN updated</p>
          <p className="pin-success-sub">Your new PIN has been saved securely.</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pin-change-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            <h3 className="modal-title">Change PIN</h3>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="pin-change-body">
          <PinSteps current={STEP_IDX[step]} />
          <h4 className="pin-change-title">{labels[step].title}</h4>
          <p className="pin-change-sub">{labels[step].sub}</p>
          <div className={shake ? "pin-shake" : ""}>
            <PinDots filled={entries[step].length} />
          </div>
          {error
            ? <p className="pin-error-msg pin-error-inline">{error}</p>
            : <div style={{ height: 20 }} />
          }
          <PinPad onDigit={handleDigit} onBack={handleBack} disabled={busy} />
        </div>
      </div>
    </div>
  );
}
