import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
const LandingPage = lazy(() => import("./LandingPage"));
import { PinSetup, PinEntry, ForgotPinScreen } from "./PinLock";
import App from "./App";
import ReceptionistView from "./ReceptionistView";
import { supabase } from "./supabase";
import { getPinHash, getProfile, acceptPrivacy, setPinHash } from "./db";
import { ErrorBoundary } from "./ErrorBoundary";

const WARN_BEFORE_MS        = 30 * 1000;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;   // default idle timeout
const AUTO_LOCK_KEY         = "psych_autolock_mins";

function getIdleTimeoutMs(): number | null {
  const raw = localStorage.getItem(AUTO_LOCK_KEY);
  // If key is absent, use default (15 min). If key is "0", disabled → null.
  const mins = raw === null ? INACTIVITY_TIMEOUT_MS / 60_000 : parseInt(raw, 10);
  if (!mins || isNaN(mins) || mins <= 0) return null;
  return mins * 60 * 1000;
}

function unlockKey(userId: string) {
  return "psych_unlocked_" + userId;
}

function isPinUnlocked(userId: string): boolean {
  const raw = localStorage.getItem(unlockKey(userId));
  if (!raw) return false;
  const ts = parseInt(raw, 10);
  if (isNaN(ts)) return false;
  const timeout = getIdleTimeoutMs();
  if (!timeout) return true;
  return Date.now() - ts < timeout;
}

function setPinUnlocked(userId: string) {
  localStorage.setItem(unlockKey(userId), String(Date.now()));
}

function clearPinUnlocked(userId: string) {
  localStorage.removeItem(unlockKey(userId));
}

interface AuthGateProps {
  userId: string;
  userName: string | null;
}

type PinState = "loading" | "setup" | "entry" | "forgot" | "unlocked";

function AutoLockWarning({ secsLeft, onStayLoggedIn }: { secsLeft: number; onStayLoggedIn: () => void }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
    }}>
      <div style={{
        background: "#1a1a2e", border: "1px solid #2d2d44",
        borderRadius: 16, padding: "32px 28px", maxWidth: 340, width: "90%",
        textAlign: "center", boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
      }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
        <h2 style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>
          Locking soon
        </h2>
        <p style={{ color: "#94a3b8", fontSize: 14, margin: "0 0 20px", lineHeight: 1.5 }}>
          No activity detected. The app will lock in
        </p>
        <div style={{
          fontSize: 48, fontWeight: 800, color: secsLeft <= 10 ? "#ef4444" : "#10b981",
          lineHeight: 1, marginBottom: 24, fontVariantNumeric: "tabular-nums",
          transition: "color 0.3s",
        }}>
          {secsLeft}s
        </div>
        <button
          onClick={onStayLoggedIn}
          style={{
            width: "100%", padding: "12px 0", borderRadius: 10,
            background: "#10b981", color: "#fff", border: "none",
            fontSize: 15, fontWeight: 600, cursor: "pointer",
          }}
        >
          Stay logged in
        </button>
      </div>
    </div>
  );
}

// ── Privacy Notice Screen (DPDP Act 2023) ──────────────────────
function PrivacyNoticeScreen({ onAccept }: { onAccept: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  async function handleProceed() {
    if (!agreed || saving) return;
    setSaving(true);
    setError("");
    try {
      await acceptPrivacy();
      onAccept();
    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : null) || "Could not save your consent. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div className="privacy-screen">
      <div className="privacy-card">

        {/* ── Scrollable content area ── */}
        <div className="privacy-scroll-body">
          <div className="privacy-logo">
            <div className="privacy-logo-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
            </div>
            <span className="privacy-logo-name">Sphota</span>
          </div>

          <h1>Data Privacy Notice</h1>
          <p className="privacy-subtitle">Please read carefully — shown once per account</p>

          <div className="privacy-section">
            <h3>What we collect</h3>
            <ul>
              <li>Patient session transcripts and clinical notes you create</li>
              <li>Medication records and prescriptions you enter</li>
              <li>Your doctor profile (name, clinic, contact details)</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>Where it is stored</h3>
            <p>
              All data is stored in <strong>Supabase</strong> — an encrypted, access-controlled cloud
              database with row-level security. Only your account can read or modify your records.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Third-party processing</h3>
            <p>
              Session audio is transcribed and clinical reports are generated using third-party services
              (our service providers). Patient names, phone numbers, Aadhaar numbers, and email addresses
              are automatically stripped before any data leaves this device. Audio and document images are
              discarded immediately after processing and are never stored.
            </p>
          </div>

          <div className="privacy-section privacy-section--highlight">
            <h3>Your data is never sold or shared</h3>
            <p>
              We do not sell, rent, or share your data with any third party beyond the services
              listed above. No advertising. No analytics resale.
            </p>
            <p style={{ marginTop: 10 }}>
              <strong>Your rights (DPDP Act 2023):</strong> You may request correction or deletion of all
              your data at any time by deleting your account from the Profile settings, or by writing to
              the Data Fiduciary (the doctor who operates this account). Consent can be withdrawn at
              any time, after which your data will be deleted within 30 days.
            </p>
          </div>
        </div>

        {/* ── Pinned footer — always visible ── */}
        <div className="privacy-footer">
          <label className="privacy-checkbox-label">
            <input
              type="checkbox"
              checked={agreed}
              onChange={e => setAgreed(e.target.checked)}
            />
            <span>I have read and understood the above. I agree to these data practices.</span>
          </label>

          {error && <p className="privacy-error">{error}</p>}

          <button
            className="privacy-proceed-btn"
            onClick={handleProceed}
            disabled={!agreed || saving}
          >
            {saving ? "Saving…" : "Continue to Sphota"}
          </button>

          <p className="privacy-legal">
            Compliant with the Digital Personal Data Protection Act, 2023 (India) · Acceptance recorded with timestamp
          </p>
        </div>

      </div>
    </div>
  );
}

export default function AuthGate({ userId, userName }: AuthGateProps) {
  const [pinState, setPinState] = useState<PinState>("loading");
  const [unlocked, setUnlocked] = useState(() => isPinUnlocked(userId));
  const [warnSecsLeft, setWarnSecsLeft] = useState<number | null>(null);
  // null = checking, false = not accepted, true = accepted
  const [privacyAccepted, setPrivacyAccepted] = useState<boolean | null>(null);

  // ── Auto-lock timer implementation ─────────────────────────────────────────
  // All timer handles kept in refs so they never cause re-renders and never
  // change identity — this avoids the listener-churn bug where useEffect
  // cleanup was killing the idle timer on every re-render.
  const idleTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  // Stable ref to the lock function so startIdleTimer never needs it as a dep
  const lockRef         = useRef<() => void>(() => {});
  // Stable ref to startIdleTimer itself so the activity handler never changes
  const startIdleTimerRef = useRef<() => void>(() => {});
  // Track unlocked state in a ref for the activity handler (avoids stale closure)
  const unlockedRef     = useRef(unlocked);
  // Track when the page was hidden so we can detect background-time > idleTimeout
  const hiddenAtRef     = useRef<number | null>(null);
  useEffect(() => { unlockedRef.current = unlocked; }, [unlocked]);

  // lock() — stable, defined once, stored in lockRef
  const lock = useCallback(() => {
    setWarnSecsLeft(null);
    // Clear timers directly via refs — no dependency on clearAllTimers
    if (idleTimerRef.current)  { clearTimeout(idleTimerRef.current);  idleTimerRef.current  = null; }
    if (warnTimerRef.current)  { clearTimeout(warnTimerRef.current);  warnTimerRef.current  = null; }
    if (countdownRef.current)  { clearInterval(countdownRef.current); countdownRef.current  = null; }
    clearPinUnlocked(userId);
    setUnlocked(false);
    setPinState("entry");
  }, [userId]);
  // Keep lockRef in sync (userId can change on account switch)
  useEffect(() => { lockRef.current = lock; }, [lock]);

  // startIdleTimer — also stable via ref so activity handler never re-registers
  const startIdleTimer = useCallback(() => {
    // Clear all existing timers first
    if (idleTimerRef.current)  { clearTimeout(idleTimerRef.current);  idleTimerRef.current  = null; }
    if (warnTimerRef.current)  { clearTimeout(warnTimerRef.current);  warnTimerRef.current  = null; }
    if (countdownRef.current)  { clearInterval(countdownRef.current); countdownRef.current  = null; }
    setWarnSecsLeft(null);

    const idleTimeoutMs = getIdleTimeoutMs();
    if (!idleTimeoutMs) return; // auto-lock disabled

    const waitMs = Math.max(idleTimeoutMs - WARN_BEFORE_MS, 0);

    idleTimerRef.current = setTimeout(() => {
      // Start the 30-second countdown warning
      const warnSecs = WARN_BEFORE_MS / 1000;
      setWarnSecsLeft(warnSecs);

      let remaining = warnSecs;
      countdownRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          // Stop the interval before lock() clears it, to avoid double-clear
          if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
          setWarnSecsLeft(null);
          lockRef.current();
        } else {
          setWarnSecsLeft(remaining);
        }
      }, 1000);

      // Belt-and-suspenders: also fire lock via setTimeout in case interval drifts
      warnTimerRef.current = setTimeout(() => {
        if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
        setWarnSecsLeft(null);
        lockRef.current();
      }, WARN_BEFORE_MS + 200); // +200ms buffer so interval fires first

    }, waitMs);
  }, []); // no deps — uses only refs and stable setters
  useEffect(() => { startIdleTimerRef.current = startIdleTimer; }, [startIdleTimer]);

  // Stable activity handler — reads unlocked from ref, calls startIdleTimer via ref
  // Registered ONCE on mount, never re-registered, never removed mid-session.
  // This is the key fix: the previous version re-registered on every render that
  // changed handleActivity identity, and the cleanup call killed the running timer.
  useEffect(() => {
    // Track whether a recording is currently active — when true, idle timers are
    // fully suppressed so the PIN lock never interrupts a live session recording.
    let recordingActive = false;

    function onActivity() {
      if (unlockedRef.current && !recordingActive) startIdleTimerRef.current();
    }
    function onSettingChanged() {
      if (unlockedRef.current && !recordingActive) startIdleTimerRef.current();
    }
    function onRecordingState(e: Event) {
      recordingActive = (e as CustomEvent<{ active: boolean }>).detail.active;
      if (!unlockedRef.current) return;
      if (recordingActive) {
        // Recording started — immediately clear all idle/warn timers so the PIN
        // lock countdown is completely suppressed for the duration of recording.
        if (idleTimerRef.current)  { clearTimeout(idleTimerRef.current);  idleTimerRef.current  = null; }
        if (warnTimerRef.current)  { clearTimeout(warnTimerRef.current);  warnTimerRef.current  = null; }
        if (countdownRef.current)  { clearInterval(countdownRef.current); countdownRef.current  = null; }
        setWarnSecsLeft(null);
      } else {
        // Recording stopped — restart the idle timer fresh from now
        startIdleTimerRef.current();
      }
    }
    const activityEvents = ["mousedown", "keydown", "touchstart", "touchend", "scroll", "click", "pointerdown"];
    activityEvents.forEach(e => window.addEventListener(e, onActivity, { passive: true }));
    // visibilitychange: when user returns to the app on mobile (screen wake)
    // CRITICAL: if the user was away longer than the idle timeout, lock IMMEDIATELY
    // instead of restarting the timer (which would give them another full timeout).
    function onVisibility() {
      if (document.visibilityState === "visible" && unlockedRef.current && !recordingActive) {
        const idleTimeoutMs = getIdleTimeoutMs();
        if (idleTimeoutMs) {
          const hiddenAt = hiddenAtRef.current;
          if (hiddenAt && Date.now() - hiddenAt >= idleTimeoutMs) {
            // Was hidden for longer than the idle timeout — lock immediately
            lockRef.current();
            return;
          }
        }
        startIdleTimerRef.current();
      }
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("psych_autolock_changed", onSettingChanged);
    window.addEventListener("sphota_recording_state", onRecordingState);
    return () => {
      activityEvents.forEach(e => window.removeEventListener(e, onActivity));
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("psych_autolock_changed", onSettingChanged);
      window.removeEventListener("sphota_recording_state", onRecordingState);
    };
  }, []); // truly empty deps — handler is stable via refs

  // Start/stop the idle timer when unlocked state changes
  useEffect(() => {
    if (!unlocked) {
      // Locked — clear all timers and hide warning overlay
      if (idleTimerRef.current)  { clearTimeout(idleTimerRef.current);  idleTimerRef.current  = null; }
      if (warnTimerRef.current)  { clearTimeout(warnTimerRef.current);  warnTimerRef.current  = null; }
      if (countdownRef.current)  { clearInterval(countdownRef.current); countdownRef.current  = null; }
      setWarnSecsLeft(null);
      return;
    }
    // Just unlocked — start the idle timer
    startIdleTimer();
  }, [unlocked, startIdleTimer]);

  const handleStayLoggedIn = useCallback(() => {
    setWarnSecsLeft(null);
    startIdleTimer();
  }, [startIdleTimer]);

  useEffect(() => {
    if (unlocked) { setPinState("unlocked"); return; }
    async function checkPin() {
      try {
        const hash = await getPinHash();
        setPinState(hash ? "entry" : "setup");
      } catch {
        setPinState("setup");
      }
    }
    checkPin();
  }, [unlocked, userId]);

  // Check whether this doctor has already accepted the privacy notice.
  // Runs after PIN unlock. Resets to null whenever the session locks again
  // so it re-checks on next unlock (handles account switching).
  useEffect(() => {
    if (pinState !== "unlocked") {
      setPrivacyAccepted(null);
      return;
    }
    let cancelled = false;
    async function checkPrivacy() {
      try {
        // If the user already passed the outer ConsentGate (terms & privacy welcome
        // screen), treat that as proof of consent — no need to show the inner
        // PrivacyNoticeScreen again. Also auto-persist so the DB is updated.
        const outerConsentGiven = localStorage.getItem("sphota_consent_given") === "1";
        if (outerConsentGiven) {
          if (!cancelled) setPrivacyAccepted(true);
          // Best-effort: persist to DB. Only attempt if we have an active session
          // to avoid the "Not authenticated" getUid() throw during the auth window.
          supabase.auth.getSession().then(({ data: { session } }) => {
            if (session?.user && !cancelled) {
              acceptPrivacy().catch(() => {/* silent — localStorage already set by ConsentGate */});
            }
          }).catch(() => {/* silent */});
          return;
        }
        const profile = await getProfile();
        if (!cancelled) setPrivacyAccepted(profile?.privacyAcceptedAt != null);
      } catch {
        // On error, fail open so a database/network issue never permanently
        // locks the doctor out of their own app.
        if (!cancelled) setPrivacyAccepted(true);
      }
    }
    checkPrivacy();
    return () => { cancelled = true; };
  }, [pinState]);

  function handleSetupDone() {
    setPinUnlocked(userId);
    setUnlocked(true);
    setPinState("unlocked");
  }

  function handleUnlock() {
    setPinUnlocked(userId);
    setUnlocked(true);
    setPinState("unlocked");
  }

  function handleForgotPin() {
    setPinState("forgot");
  }

  async function handleForgotPinVerified() {
    try {
      await setPinHash("");
    } catch { /* silent */ }
    clearPinUnlocked(userId);
    setUnlocked(false);
    setPinState("setup");
  }

  if (pinState === "loading") {
    return (
      <div className="pin-screen" data-theme="dark">
        <div className="pin-card" style={{ alignItems: "center" }}>
          <div className="spinner" style={{ margin: "40px auto" }} />
        </div>
      </div>
    );
  }

  if (pinState === "setup") {
    return <PinSetup onDone={handleSetupDone} />;
  }

  if (pinState === "entry") {
    return <PinEntry onUnlock={handleUnlock} onForgotPin={handleForgotPin} />;
  }

  if (pinState === "forgot") {
    return (
      <ForgotPinScreen
        onVerified={handleForgotPinVerified}
        onBack={() => setPinState("entry")}
      />
    );
  }

  // Still fetching whether privacy has been accepted — show a brief spinner
  if (privacyAccepted === null) {
    return (
      <div className="pin-screen" data-theme="dark">
        <div className="pin-card" style={{ alignItems: "center" }}>
          <div className="spinner" style={{ margin: "40px auto" }} />
        </div>
      </div>
    );
  }

  // Doctor has not yet accepted — show the one-time privacy notice
  if (!privacyAccepted) {
    return <PrivacyNoticeScreen onAccept={() => setPrivacyAccepted(true)} />;
  }

  return (
    <>
      {warnSecsLeft !== null && (
        <AutoLockWarning secsLeft={warnSecsLeft} onStayLoggedIn={handleStayLoggedIn} />
      )}
      <ErrorBoundary
        name="app"
        fallback={
          <div style={{
            minHeight: "100vh", background: "#080c18", display: "flex",
            alignItems: "center", justifyContent: "center", padding: 24,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          }}>
            <div style={{ textAlign: "center", maxWidth: 360 }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
              <h2 style={{ color: "#f0f4f8", fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>
                Something went wrong
              </h2>
              <p style={{ color: "#8898aa", fontSize: 14, margin: "0 0 20px", lineHeight: 1.5 }}>
                An unexpected error occurred. Please refresh the page.
              </p>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: "10px 24px", borderRadius: 8, background: "#14b8a6",
                  color: "#080c18", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer",
                }}
              >
                Refresh
              </button>
            </div>
          </div>
        }
      >
        <App doctorId={userId} doctorDisplayName={userName} onLock={lock} />
      </ErrorBoundary>
    </>
  );
}

// ── Password Reset Screen ──────────────────────────────────────
function PasswordResetScreen({ onDone }: { onDone: () => void }) {
  const [password,  setPassword]  = useState("");
  const [password2, setPassword2] = useState("");
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState("");
  const [done,      setDone]      = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8 || !/\d/.test(password)) {
      setError("Password must be at least 8 characters and include a number.");
      return;
    }
    if (password !== password2) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) {
        setError(err.message || "Could not update password. Please try again.");
        return;
      }
      setDone(true);
      await supabase.auth.signOut();
      setTimeout(onDone, 2000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not update password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pin-screen" data-theme="dark">
      <div className="pin-card" style={{ maxWidth: 360, width: "90%" }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🔑</div>
          <h2 style={{ color: "var(--text-primary)", fontSize: 18, fontWeight: 700, margin: 0 }}>
            Set new password
          </h2>
        </div>
        {done ? (
          <p style={{ color: "#10b981", textAlign: "center", fontSize: 14 }}>
            Password updated! Redirecting to sign in…
          </p>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              type="password"
              placeholder="New password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={busy}
              style={{
                padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border-mid)",
                background: "var(--bg-raised)", color: "var(--text-primary)", fontSize: 14,
              }}
              autoComplete="new-password"
            />
            <input
              type="password"
              placeholder="Confirm new password"
              value={password2}
              onChange={e => setPassword2(e.target.value)}
              disabled={busy}
              style={{
                padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border-mid)",
                background: "var(--bg-raised)", color: "var(--text-primary)", fontSize: 14,
              }}
              autoComplete="new-password"
            />
            {error && (
              <p style={{ color: "#ef4444", fontSize: 13, margin: 0 }}>{error}</p>
            )}
            <button
              type="submit"
              disabled={busy}
              style={{
                padding: "11px 0", borderRadius: 8, background: "#10b981",
                color: "#fff", border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}
            >
              {busy ? "Updating…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Receptionist signup screen (opened via invite link) ───────────────────
function ReceptionistSignupScreen({
  email, inviteCode, doctorId, onSuccess, onError,
}: {
  email: string;
  inviteCode: string;
  doctorId: string;
  onSuccess: (uid: string) => void;
  onError: (msg: string) => void;
}) {
  const [password,  setPassword]  = useState("");
  const [password2, setPassword2] = useState("");
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== password2) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      // 1. Call server endpoint — it uses the admin key to create the account
      //    with email_confirm:true (bypassing email verification), upserts the
      //    doctors row, and marks the invite as accepted.
      const rawResp = await fetch("/api/receptionist/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteCode, email, password }),
      });
      const respText = await rawResp.text();
      let respData: Record<string, unknown> = {};
      try { if (respText.trim()) respData = JSON.parse(respText); } catch { /* ignore */ }
      if (!rawResp.ok) {
        throw new Error((respData.message as string) ?? `Server error (${rawResp.status}). Please try again.`);
      }

      // 2. Sign in — the account now exists and is confirmed
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) throw new Error(signInErr.message ?? "Account created but sign-in failed. Please try again.");

      // 3. Get the signed-in user
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Sign-in succeeded but user record is not available.");

      // 4. Pre-cache role so onAuthStateChange shows receptionist view immediately
      sessionStorage.setItem(`psych_role_${user.id}`, "receptionist");

      // 4b. Pre-cache linkedDoctorId so ReceptionistView renders immediately
      //     without hitting the "waiting" screen while the dashboard API loads.
      if (doctorId) {
        sessionStorage.setItem(`psych_recep_linked_${user.id}`, doctorId);
      }

      // 5. Notify parent
      onSuccess(user.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pin-screen" data-theme="dark">
      <div className="pin-card" style={{ maxWidth: 380, width: "90%" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>👋</div>
          <h2 style={{ color: "var(--text-primary)", fontSize: 20, fontWeight: 700, margin: "0 0 6px" }}>
            Create your receptionist account
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
            You've been invited to join as a receptionist.
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>Email</label>
            <input
              type="email"
              value={email}
              readOnly
              style={{
                width: "100%", padding: "10px 14px", borderRadius: 8,
                border: "1px solid var(--border-mid)", background: "rgba(255,255,255,0.05)",
                color: "var(--text-muted)", fontSize: 14, boxSizing: "border-box",
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>Password</label>
            <input
              type="password"
              placeholder="At least 8 characters"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
              style={{
                width: "100%", padding: "10px 14px", borderRadius: 8,
                border: "1px solid var(--border-mid)", background: "var(--bg-raised)",
                color: "var(--text-primary)", fontSize: 14, boxSizing: "border-box",
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>Confirm password</label>
            <input
              type="password"
              placeholder="Re-enter password"
              value={password2}
              onChange={e => setPassword2(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
              style={{
                width: "100%", padding: "10px 14px", borderRadius: 8,
                border: "1px solid var(--border-mid)", background: "var(--bg-raised)",
                color: "var(--text-primary)", fontSize: 14, boxSizing: "border-box",
              }}
            />
          </div>

          {error && (
            <p style={{ color: "#ef4444", fontSize: 13, margin: 0, lineHeight: 1.4 }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{
              padding: "12px 0", borderRadius: 9, background: busy ? "#475569" : "#3b82f6",
              color: "#fff", border: "none", fontSize: 14, fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer", marginTop: 4,
            }}
          >
            {busy ? "Creating account…" : "Create account & sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Invite password setup screen (opened after clicking Supabase invite email) ──
function InvitePasswordSetupScreen({
  email, onDone,
}: {
  email: string;
  onDone: () => void;
}) {
  const [password,  setPassword]  = useState("");
  const [password2, setPassword2] = useState("");
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState("");
  const [done,      setDone]      = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== password2) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) throw new Error(err.message);
      setDone(true);
      // onAuthStateChange fires USER_UPDATED → role resolution → correct view
      setTimeout(onDone, 1200);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not set password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pin-screen" data-theme="dark">
      <div className="pin-card" style={{ maxWidth: 380, width: "90%" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🎉</div>
          <h2 style={{ color: "var(--text-primary)", fontSize: 20, fontWeight: 700, margin: "0 0 6px" }}>
            Welcome to Sphota
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
            Set a password to complete your receptionist account setup.
          </p>
        </div>

        {done ? (
          <p style={{ color: "#10b981", textAlign: "center", fontSize: 14, padding: "16px 0" }}>
            ✓ Password set! Taking you to your workspace…
          </p>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>Email (your login)</label>
              <input
                type="email"
                value={email}
                readOnly
                style={{
                  width: "100%", padding: "10px 14px", borderRadius: 8,
                  border: "1px solid var(--border-mid)", background: "rgba(255,255,255,0.05)",
                  color: "var(--text-muted)", fontSize: 14, boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>New Password</label>
              <input
                type="password"
                placeholder="At least 8 characters"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={busy}
                autoFocus
                autoComplete="new-password"
                style={{
                  width: "100%", padding: "10px 14px", borderRadius: 8,
                  border: "1px solid var(--border-mid)", background: "var(--bg-raised)",
                  color: "var(--text-primary)", fontSize: 14, boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>Confirm Password</label>
              <input
                type="password"
                placeholder="Re-enter password"
                value={password2}
                onChange={e => setPassword2(e.target.value)}
                disabled={busy}
                autoComplete="new-password"
                style={{
                  width: "100%", padding: "10px 14px", borderRadius: 8,
                  border: "1px solid var(--border-mid)", background: "var(--bg-raised)",
                  color: "var(--text-primary)", fontSize: 14, boxSizing: "border-box",
                }}
              />
            </div>
            {error && (
              <p style={{ color: "#ef4444", fontSize: 13, margin: 0, lineHeight: 1.4 }}>{error}</p>
            )}
            <button
              type="submit"
              disabled={busy}
              style={{
                padding: "12px 0", borderRadius: 9,
                background: busy ? "#475569" : "#10b981",
                color: "#fff", border: "none", fontSize: 14, fontWeight: 600,
                cursor: busy ? "not-allowed" : "pointer", marginTop: 4,
              }}
            >
              {busy ? "Setting password…" : "Set password & continue"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Receptionist Privacy Notice (shown once on first login) ──────────────
function ReceptionistPrivacyScreen({ onAccept }: { onAccept: () => void }) {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="privacy-screen">
      <div className="privacy-card">
        <div className="privacy-scroll-body">
          <div className="privacy-logo">
            <div className="privacy-logo-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
            </div>
            <span className="privacy-logo-name">Sphota</span>
          </div>

          <h1>Data Privacy Notice</h1>
          <p className="privacy-subtitle">Please read carefully — shown once for your account</p>

          <div className="privacy-section">
            <h3>What you can access</h3>
            <ul>
              <li>Patient names, age, gender, and appointment schedules</li>
              <li>Waiting room queue and check-in status</li>
              <li>Appointment scheduling and rescheduling</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>What you cannot access</h3>
            <p>
              Clinical session notes, psychiatric reports, diagnoses, medications, and all
              sensitive health data are <strong>not visible</strong> in the receptionist interface.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Your responsibilities</h3>
            <p>
              As a receptionist, you handle personal data (names, contact details). Do not share
              patient information with unauthorised parties. Log out when leaving your workstation.
            </p>
          </div>

          <div className="privacy-section privacy-section--highlight">
            <h3>Data is never sold or shared</h3>
            <p>
              All data is stored in an encrypted, access-controlled database. No advertising, no analytics resale.
            </p>
          </div>
        </div>

        <div className="privacy-footer">
          <label className="privacy-checkbox-label">
            <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
            <span>I have read and understood the above. I agree to handle patient data responsibly.</span>
          </label>

          <button
            className="privacy-proceed-btn"
            onClick={onAccept}
            disabled={!agreed}
          >
            Continue to Reception Portal
          </button>

          <p className="privacy-legal">
            Compliant with the Digital Personal Data Protection Act, 2023 (India)
          </p>
        </div>
      </div>
    </div>
  );
}

// Synchronously check (before first paint) whether a Supabase session token is
// cached in localStorage. This costs a localStorage read, not a network call,
// so it's effectively free. If there's no token, we already know — with high
// confidence — that the visitor is a guest, so we can skip the "loading"
// spinner entirely and render LandingPage immediately. This is what keeps LCP
// fast for the common case (logged-out visitor hitting the marketing page)
// instead of blocking first paint on a getSession() network round trip.
function hasCachedSupabaseSession(): boolean {
  try {
    return Object.keys(localStorage).some(
      (key) => key.startsWith("sb-") && key.endsWith("-auth-token")
    );
  } catch {
    return false;
  }
}

// Hard safety net: if getSession() (or the role-resolution query that follows
// it) ever hangs — cold start, flaky network, provider outage — never let the
// "loading"/"resolving_role" spinner block the page indefinitely. Past this
// many ms, fall back to "guest" so the user always lands on a usable page.
const AUTH_RESOLVE_TIMEOUT_MS = 4000;

export function RootGate() {
  type AuthStateType = "loading" | "guest" | "resolving_role" | "authed" | "reset" | "invite_signup" | "invite_error" | "invite_set_password";
  // If no cached session token exists, skip the spinner and start as "guest"
  // straight away — LandingPage can render on the very first paint. If a
  // token DOES exist, we still start in "loading" since we likely need to
  // show the authenticated app (not flash the landing page) while we confirm.
  const initialAuthState: AuthStateType = hasCachedSupabaseSession() ? "loading" : "guest";
  const [authState,       setAuthState]       = useState<AuthStateType>(initialAuthState);
  const authStateRef = useRef<AuthStateType>(initialAuthState);
  function setAuth(s: AuthStateType) { authStateRef.current = s; setAuthState(s); }

  const [userId,          setUserId]          = useState<string>("");
  const [userEmail,       setUserEmail]       = useState<string>("");
  const [userName,        setUserName]        = useState<string | null>(null);
  const [inviteError,     setInviteError]     = useState<string>("");
  const [inviteSignupData, setInviteSignupData] = useState<{ email: string; code: string; doctorId: string } | null>(null);
  const [userRole,        setUserRole]        = useState<"doctor" | "receptionist">("doctor");

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const inviteCode  = searchParams.get("invite_code");
    const inviteEmail = searchParams.get("invite_email");

    // Always set up the auth state change listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // TOKEN_REFRESHED and INITIAL_SESSION don't change who is signed in —
      // skip them to avoid re-mounting <App> and wiping navigation state.
      if (event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") return;

      if (event === "PASSWORD_RECOVERY") {
        setAuth("reset");
        return;
      }
      if (session?.user) {
        // Already authenticated — only process genuine new sign-ins (not re-fires).
        if (authStateRef.current === "authed") return;
        // Guard invite flows: a cached session firing SIGNED_IN must not override
        // the invite signup / set-password screens and redirect the receptionist
        // into the main app before they have finished creating their account.
        if (authStateRef.current === "invite_signup") return;
        if (authStateRef.current === "invite_set_password") return;

        const uid   = session.user.id;
        const email = session.user.email ?? "";
        setUserId(uid);
        setUserEmail(email);
        setUserName(email ? email.split("@")[0] : null);
        setUserRole("doctor");
        setAuth("resolving_role"); // show spinner, not PIN screen

        // Resolve role asynchronously — only THEN show the correct UI
        (async () => {
          try {
            const { data: roleData } = await supabase
              .from("doctors")
              .select("role, linked_doctor_id")
              .eq("id", uid)
              .single();
            const dbRole = roleData?.role ?? "doctor";
            const linkedDoctorId = roleData?.linked_doctor_id ?? null;
            // Block revoked receptionists — sign out and return to guest
            if (dbRole === "receptionist_removed" || (dbRole === "receptionist" && !linkedDoctorId)) {
              sessionStorage.removeItem(`psych_role_${uid}`);
              await supabase.auth.signOut();
              setAuth("guest");
              return;
            }
            const role = dbRole === "receptionist" ? "receptionist" : "doctor";
            setUserRole(role as "doctor" | "receptionist");
            sessionStorage.setItem(`psych_role_${uid}`, role);
          } catch { /* stay as doctor on error */ }
          setAuth("authed");
        })();
      } else {
        setUserId("");
        setUserEmail("");
        setUserName(null);
        setUserRole("doctor");
        setAuth("guest");
      }
    });

    // Handle invite signup link — show password-creation form
    const doctorId = searchParams.get("doctor_id") ?? "";
    if (inviteCode && inviteEmail) {
      setInviteSignupData({ email: decodeURIComponent(inviteEmail), code: inviteCode, doctorId });
      window.history.replaceState({}, "", "/");
      setAuth("invite_signup");
      return () => subscription.unsubscribe();
    }

    // Handle password recovery / invite email links
    const hash = window.location.hash;
    const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
    const type = hashParams.get("type") ?? searchParams.get("type");

    // Magic-link clicked from "Forgot PIN" email — user is now authenticated,
    // clear their PIN so they can set a new one.
    if (type === "magiclink_pin_reset") {
      window.history.replaceState({}, "", "/");
      supabase.auth.getSession().then(async ({ data: { session } }) => {
        if (session?.user) {
          const uid = session.user.id;
          setUserId(uid);
          setUserEmail(session.user.email ?? "");
          setUserName(session.user.email ? session.user.email.split("@")[0] : null);
          setUserRole("doctor");
          // Clear the PIN so PinGate shows setup screen
          try {
            await setPinHash("");
          } catch { /* silent */ }
          clearPinUnlocked(uid);
          setAuth("authed");
        } else {
          setAuth("guest");
        }
      }).catch(() => setAuth("guest"));
      return () => subscription.unsubscribe();
    }

    if (type === "recovery") {
      supabase.auth.getSession().then(({ data: { session } }) => {
        setAuth(session ? "reset" : "guest");
      }).catch(() => setAuth("guest"));
      return () => subscription.unsubscribe();
    }

    // Supabase invite email link — user is already signed in via the token,
    // just needs to set a permanent password then resolve role
    if (type === "invite") {
      window.history.replaceState({}, "", "/");
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session?.user) {
          setUserId(session.user.id);
          setUserEmail(session.user.email ?? "");
          setAuth("invite_set_password");
        } else {
          setAuth("guest");
        }
      }).catch(() => setAuth("guest"));
      return () => subscription.unsubscribe();
    }

    // Normal flow — check existing session.
    // Safety net: if this hangs (cold start, flaky network, provider outage),
    // never let the spinner block the page forever — fall back to "guest"
    // after AUTH_RESOLVE_TIMEOUT_MS so the user always gets a usable page.
    let resolvedNormalFlow = false;
    const fallbackTimer = setTimeout(() => {
      if (!resolvedNormalFlow && authStateRef.current === "loading") {
        setAuth("guest");
      }
    }, AUTH_RESOLVE_TIMEOUT_MS);

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      resolvedNormalFlow = true;
      clearTimeout(fallbackTimer);
      if (session?.user) {
        const uid   = session.user.id;
        const email = session.user.email ?? "";
        setUserId(uid);
        setUserEmail(email);
        setUserName(email ? email.split("@")[0] : null);

        // Always resolve role fresh (skip stale cache to catch revocation)
        setUserRole("doctor");
        setAuth("resolving_role");
        try {
          const { data: roleData } = await supabase
            .from("doctors")
            .select("role, linked_doctor_id")
            .eq("id", uid)
            .single();
          const dbRole = roleData?.role ?? "doctor";
          const linkedDoctorId = roleData?.linked_doctor_id ?? null;
          // Block revoked receptionists immediately
          if (dbRole === "receptionist_removed" || (dbRole === "receptionist" && !linkedDoctorId)) {
            sessionStorage.removeItem(`psych_role_${uid}`);
            await supabase.auth.signOut();
            setAuth("guest");
            return;
          }
          const role = dbRole === "receptionist" ? "receptionist" : "doctor";
          setUserRole(role as "doctor" | "receptionist");
          sessionStorage.setItem(`psych_role_${uid}`, role);
        } catch { /* stay as doctor */ }
        setAuth("authed");
      } else {
        setAuth("guest");
      }
    }).catch(() => {
      resolvedNormalFlow = true;
      clearTimeout(fallbackTimer);
      setAuth("guest");
    });

    return () => {
      clearTimeout(fallbackTimer);
      subscription.unsubscribe();
    };
  }, []);

  // Spinner states
  if (authState === "loading" || authState === "resolving_role") {
    return (
      <div className="pin-screen" data-theme="dark">
        <div className="pin-card" style={{ alignItems: "center" }}>
          <div className="spinner" style={{ margin: "40px auto" }} />
          {authState === "resolving_role" && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 12 }}>Signing you in…</p>
          )}
        </div>
      </div>
    );
  }

  if (authState === "reset") {
    return (
      <PasswordResetScreen
        onDone={() => {
          window.history.replaceState({}, "", "/");
          setAuth("guest");
        }}
      />
    );
  }

  if (authState === "invite_signup" && inviteSignupData) {
    return (
      <ReceptionistSignupScreen
        email={inviteSignupData.email}
        inviteCode={inviteSignupData.code}
        doctorId={inviteSignupData.doctorId}
        onSuccess={(uid) => {
          // Update ref synchronously so onAuthStateChange SIGNED_IN (which fires
          // right after signInWithPassword) skips the re-resolution path.
          authStateRef.current = "authed";
          setUserId(uid);
          setUserRole("receptionist");
          setAuthState("authed");
        }}
        onError={(_msg) => { /* error shown inline in component */ }}
      />
    );
  }

  if (authState === "invite_set_password") {
    return (
      <InvitePasswordSetupScreen
        email={userEmail}
        onDone={() => {
          setAuth("resolving_role");
        }}
      />
    );
  }

  if (authState === "invite_error") {
    return (
      <div className="pin-screen" data-theme="dark">
        <div className="pin-card" style={{ alignItems: "center", textAlign: "center" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <h2 style={{ color: "var(--text-primary)", fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>
            Invite link problem
          </h2>
          <p style={{ color: "#ef4444", fontSize: 14, margin: "0 0 20px", lineHeight: 1.5, maxWidth: 300 }}>
            {inviteError}
          </p>
          <button
            onClick={() => setAuth("guest")}
            style={{
              padding: "10px 24px", borderRadius: 8, background: "#10b981",
              color: "#fff", border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer",
            }}
          >
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  if (authState === "guest") {
    return (
      <Suspense fallback={
        <div style={{ minHeight: "100vh", background: "#060910", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          <div style={{ fontFamily: "Georgia, 'Fraunces', serif", fontSize: 32, fontWeight: 700, color: "#e4eaf5", letterSpacing: "-0.5px" }}>
            Sphota<span style={{ color: "#4d9fff" }}>.</span>
          </div>
          <div style={{ width: 28, height: 28, border: "2px solid rgba(77,159,255,0.25)", borderTopColor: "#4d9fff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      }>
        <LandingPage />
      </Suspense>
    );
  }

  // Receptionists get a dedicated interface — PIN not required, but privacy notice shown once
  if (userRole === "receptionist") {
    const consentKey = `psych_receptionist_consent_${userId}`;
    // Accept if either the per-user key OR the outer ConsentGate cache is set
    const hasConsented = !!localStorage.getItem(consentKey) ||
                         localStorage.getItem("sphota_consent_given") === "1";
    if (!hasConsented) {
      return (
        <ReceptionistPrivacyScreen onAccept={async () => {
          // Persist consent to server (DPDP Act 2023 — consent must be recorded)
          try {
            const { data: { session } } = await supabase.auth.getSession();
            const token = session?.access_token ?? "";
            await fetch("/api/consent", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ consentType: "terms_and_privacy", version: "1.0" }),
            });
          } catch {
            // Best-effort — localStorage fallback ensures UI doesn't block
          }
          localStorage.setItem(consentKey, "true");
          setAuth("authed");
        }} />
      );
    }
    return <ReceptionistView userId={userId} userEmail={userEmail} />;
  }

  return <AuthGate userId={userId} userName={userName} />;
}
