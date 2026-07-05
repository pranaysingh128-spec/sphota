import { useState, useRef, useEffect, useCallback, lazy, Suspense, type ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import html2canvas from "html2canvas";
import { marked } from "marked";

// marked v5+ returns `string | Promise<string>` depending on async hooks.
// We never register async hooks, so the result is always a plain string at
// runtime — but TypeScript sees the union.  This wrapper makes that explicit
// and avoids the "as string" cast that silently breaks if the type widens.
function markedSync(src: string): string {
  const result = marked.parse(src, { async: false });
  // In the unlikely event a Promise slips through (shouldn't happen without
  // async hooks), fall back to the raw source so the UI shows something useful.
  if ((result as unknown) instanceof Promise) {
    console.error("[markedSync] unexpected Promise — returning raw text");
    return src;
  }
  // Safety check: if source has markdown pipe-table syntax but the rendered HTML
  // has no <table> element, the table parser failed silently.
  if (/\|.+\|/.test(src) && !(result as string).includes("<table")) {
    console.warn("[markedSync] markdown table not rendered — remarkGfm may be missing or marked version mismatch");
  }
  return result as string;
}
import DOMPurify from "dompurify";
import OverviewPage from "./OverviewPage";
import PaymentPage from "./PaymentPage";
import ReportEditor from "./ReportEditor";
import PatientDocument from "./PatientDocument";
import MedModal from "./MedModal";
import { ChangePinModal } from "./PinLock";
import { ProgressTab } from "./ProgressTab";
import ScanModal from "./ScanModal";
import type { Theme, DocLang, ScaleScore, NoteFormat, DoctorProfile, Patient, ReportSection, ClinicalReport, ReportEntry, PatientMedRecord, MedDraft, Appointment } from "./types";
import * as db from "./db";
import { supabase } from "./supabase";

// ── Lazy-loaded components ─────────────────────────────────────
const PatientSidebar = lazy(() => import("./PatientSidebar"));
const TranscriptPanel = lazy(() => import("./TranscriptPanel"));

// ── Constants ──────────────────────────────────────────────────
const DEFAULT_DOCTOR: DoctorProfile = { name: "", specialty: "Psychiatry", clinic: "", contact: "" };

const STATUS_COLOR: Record<Patient["status"], string> = {
  active: "#22c55e", waiting: "#f59e0b", done: "#6b7280",
};

// ── Helpers ────────────────────────────────────────────────────
function getInitials(name: string) {
  return name.split(" ").filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "Dr";
}

// ── HTML escaping (XSS prevention in print/export windows) ──────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ── PII stripping (DPDP Act 2023 compliance) ───────────────────
// Removes patient identifiers before sending data to external APIs.
function stripPatientPII(text: string, patientName: string): string {
  let result = text;
  if (patientName && patientName.trim()) {
    // Replace full name first, then individual name parts (>2 chars) to avoid over-replacing short words
    const escapedFull = patientName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escapedFull, "gi"), "the patient");
    const parts = patientName.trim().split(/\s+/).filter(p => p.length > 2);
    for (const part of parts) {
      const esc = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`\\b${esc}\\b`, "gi"), "the patient");
    }
  }
  // Strip Indian mobile numbers: +91 XXXXX XXXXX, 91-XXXXXXXXXX, standalone 10-digit mobiles
  result = result.replace(/(\+91[\s\-]?)?[6-9]\d{9}/g, "[phone redacted]");
  result = result.replace(/\b91[\s\-]?\d{10}\b/g, "[phone redacted]");
  // Strip common address identifiers
  result = result.replace(
    /\b(Door|Flat|H\.?No\.?|Plot\s*No\.?|House\s*No\.?|Block|Sector|Apartment|Apt)\s*[#:\-]?\s*\d+[A-Za-z]?/gi,
    "[address redacted]"
  );

  // Strip email addresses
  result = result.replace(/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi, "[email redacted]");

  // Strip Aadhaar numbers (12-digit, with or without spaces every 4 digits)
  result = result.replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "[aadhaar redacted]");

  // Strip PAN card numbers
  result = result.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[pan redacted]");

  // Strip date-of-birth patterns
  result = result.replace(
    /\b(DOB|D\.O\.B\.?|date\s+of\s+birth|born\s+on)\s*[:\-]?\s*[\d]{1,2}[\s\/\-][\d]{1,2}[\s\/\-][\d]{2,4}/gi,
    "[dob redacted]"
  );

  // Strip passport numbers (Indian format)
  result = result.replace(/\b[A-Z]\d{7}\b/g, "[passport redacted]");

  return result;
}
function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}
function nowLabel() {
  return new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

// ── DB row mappers ─────────────────────────────────────────────
function mapPatient(row: Record<string, unknown>): Patient {
  return {
    id:     row.id as number,
    name:   row.name as string,
    age:    (row.age as number) ?? 0,
    gender: (row.gender as string) ?? "Unknown",
    time:   (row.time as string) ?? "",
    status: (row.status as Patient["status"]) ?? "waiting",
  };
}


// Note: ReportEntry DB row mapping is handled by db.ts → rowToEntry(),
// which correctly reads snake_case column names (raw_text, edited_html, etc.).
// Do not add a second mapper here.

// ── Report parser ──────────────────────────────────────────────
// Parses the structured markdown the AI produces (### 1. PRIORITY FLAG, ### 2. QUICK SCAN, etc.)
// Falls back to the old colon-label parser so existing reports still display.
function parseReport(raw: string): ClinicalReport {
  const sections: ReportSection[] = [];
  const planItems: string[] = [];
  let diagnosis = "";

  // ── Strategy 1: parse ### N. SECTION headings (new AI format) ────────────
  // Split on lines that start with one or more # characters followed by a space
  const headingRe = /^#{1,4}\s+\d*\.?\s*/m;
  if (headingRe.test(raw)) {
    const parts = raw.split(/\n(?=#{1,4}\s)/);
    for (const part of parts) {
      const headingMatch = part.match(/^#{1,4}\s+(?:\d+\.)?\s*(.+)/);
      if (!headingMatch) continue;
      const label = headingMatch[1].trim();
      const body = part.slice(headingMatch[0].length).trim();
      if (!body) continue;
      if (/diagnosis|assessment/i.test(label)) {
        // Try to extract just the diagnosis line from the assessment block
        const diagLine = body.match(/\*\*Diagnosis[^*]*\*\*[:\s]*(.+)/i)?.[1]
          ?? body.split("\n").find(l => l.trim())
          ?? body;
        diagnosis = diagLine.replace(/\*+/g, "").trim();
        sections.push({ label, value: body });
      } else if (/^plan$/i.test(label)) {
        planItems.push(...body.split("\n").map(s => s.replace(/^[-•*\d.|]+\s*/, "").trim()).filter(Boolean));
      } else {
        sections.push({ label, value: body });
      }
    }
    if (sections.length > 0 || diagnosis) {
      return { sections, diagnosis, plan: planItems };
    }
  }

  // ── Strategy 2: legacy colon-label parser (old format / hand-typed reports) ──
  const lines = raw.split("\n").filter(l => l.trim());
  let lbl = "", vals: string[] = [];
  function flush() {
    if (!lbl || !vals.length) return;
    const label = lbl.trim().replace(/:$/, "");
    const value = vals.join("\n").trim();
    if (/diagnosis/i.test(label)) diagnosis = value;
    else if (/plan/i.test(label)) planItems.push(...value.split("\n").map(s => s.replace(/^[-•*\d.]+\s*/, "").trim()).filter(Boolean));
    else sections.push({ label, value });
    lbl = ""; vals = [];
  }
  for (const line of lines) {
    const h = line.match(/^\*{0,2}([^:*]+)\*{0,2}:\s*(.*)$/);
    if (h && h[1].trim().length < 60) { flush(); lbl = h[1].trim().replace(/\*+/g, ""); if (h[2].trim()) vals = [h[2].trim()]; }
    else vals.push(line.replace(/^[-•*]\s*/, "").trim());
  }
  flush();
  return { sections, diagnosis, plan: planItems };
}

// ── Draft types ────────────────────────────────────────────────
interface PatientDraft {
  name: string; age: string; gender: string; time: string; status: Patient["status"];
}
const EMPTY_DRAFT: PatientDraft = { name: "", age: "", gender: "Female", time: "", status: "waiting" };
const EMPTY_MED_RECORD = (): PatientMedRecord => ({ medications: [], allergies: [] });

// ── Appointment Reminder Banner ────────────────────────────────
function AppointmentReminderBanner({
  appointments, patients, onDismiss, onSelectPatient,
}: {
  appointments: Appointment[];
  patients: Patient[];
  onDismiss: () => void;
  onSelectPatient: (id: number) => void;
}) {
  const sorted = [...appointments].sort((a, b) => a.time.localeCompare(b.time));
  return (
    <div className="appt-reminder-banner">
      <div className="appt-reminder-icon">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
      </div>
      <div className="appt-reminder-body">
        <span className="appt-reminder-label">
          {appointments.length === 1 ? "1 appointment today" : `${appointments.length} appointments today`}
        </span>
        <div className="appt-reminder-chips">
          {sorted.map(a => {
            const patient = patients.find(p => p.id === a.patientId);
            return (
              <button key={a.id} className="appt-reminder-chip" onClick={() => onSelectPatient(a.patientId)}>
                {patient ? `${patient.name} · ${a.time}` : a.time}
              </button>
            );
          })}
        </div>
      </div>
      <button className="appt-reminder-dismiss" onClick={onDismiss} title="Dismiss for today">✕</button>
    </div>
  );
}

// ── Auto-save error banner with dismiss + auto-close ─────────
function AutoSaveErrorBanner({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 10000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div style={{ position: "fixed", bottom: 22, left: 22, zIndex: 9998, background: "rgba(30,30,30,0.92)", border: "1px solid rgba(245,158,11,0.45)", borderRadius: 9, padding: "9px 14px 9px 12px", fontSize: 12, color: "#fbbf24", display: "flex", alignItems: "center", gap: 8, maxWidth: 360, boxShadow: "0 4px 18px rgba(0,0,0,0.35)", backdropFilter: "blur(4px)" }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
      <span style={{ flex: 1 }}>Auto-save failed — your transcript is stored locally but not yet synced.</span>
      <button onClick={onDismiss} style={{ background: "none", border: "none", cursor: "pointer", color: "#fbbf24", fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0, minWidth: 24, minHeight: 24, display: "flex", alignItems: "center", justifyContent: "center" }} title="Dismiss">×</button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ── AI API helpers with primary/fallback logic ────────────────
interface LLMMessage { role: "system" | "user" | "assistant"; content: string; }

// ── Auth token helper for server-side AI calls ────────────────
async function getAuthToken(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  } catch { return ""; }
}

// Report & patient letter LLM chain (handled server-side in api/ai/chat.ts):
//   1. AI Provider (primary)
//   2. AI Provider (fallback 1)
//   3. AI Provider (final fallback)

//
// Transcription chain (api/ai/transcribe.ts):
//   1. AI Transcription (primary)
//   2. AI Transcription (fallback)

// ── Core SSE streaming fetch for /api/ai/chat ────────────────────────────────
// Reads Server-Sent Events from the streaming API and returns the full result.
// Each SSE event is either: { chunk: string } | { done: true, result: string, provider: string } | { error: string }
async function callChatSSE(
  body: Record<string, unknown>,
  onChunk?: (chunk: string) => void,
  onFallback?: () => void,
): Promise<string> {
  const token = await getAuthToken();
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  // Non-streaming error responses (auth, rate limit, 400s) come back as plain JSON
  if (!res.ok) {
    let errMsg = `Report generation failed (HTTP ${res.status})`;
    try {
      const text = await res.text();
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) errMsg = parsed.message;
    } catch { /* use default */ }
    throw new Error(errMsg);
  }

  // Read the SSE stream
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";
  let streamCompleted = false; // only true when we receive { done: true } from server

  function processSSELine(line: string) {
    if (line.startsWith(":")) return; // keep-alive comment
    if (!line.startsWith("data: ")) return;
    const jsonStr = line.slice(6).trim();
    if (!jsonStr) return;
    const event = JSON.parse(jsonStr) as {
      chunk?: string;
      done?: boolean;
      reset?: boolean;
      result?: string;
      provider?: string;
      error?: string;
    };
    if (event.error) throw new Error(event.error);
    if (event.reset) {
      result = "";
      onChunk?.("\x00RESET\x00");
      return;
    }
    if (event.chunk) {
      result += event.chunk;
      onChunk?.(event.chunk);
    }
    if (event.done) {
      streamCompleted = true;
      if (event.result) result = event.result;
      if (onFallback && event.provider && (event.provider.includes("fallback") || event.provider.includes("groq") || event.provider.includes("openai"))) {
        onFallback();
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      try { processSSELine(line); } catch (parseErr: any) {
        if (parseErr?.message && !parseErr.message.startsWith("Unexpected token")) throw parseErr;
      }
    }
  }

  // Flush any remaining buffer content — the final SSE event (including { done: true })
  // can arrive in a partial chunk without a trailing newline and would be missed
  // without this flush, leaving streamCompleted = false and returning partial content.
  if (buffer.trim()) {
    const lines = buffer.split("\n");
    for (const line of lines) {
      try { processSSELine(line); } catch (parseErr: any) {
        if (parseErr?.message && !parseErr.message.startsWith("Unexpected token")) throw parseErr;
      }
    }
  }

  // If the stream closed without a { done: true } event (e.g. network drop):
  if (!streamCompleted) {
    throw new Error("Report generation was interrupted mid-stream — please try again. Your transcript is still here.");
  }
  if (!result) throw new Error("Report generation returned an empty response — please try again.");
  return result;
}

async function callAILLM(messages: LLMMessage[]): Promise<string> {
  return callChatSSE({ messages });
}

// Kept for internal compatibility — routes through the same server-side chain
async function callAILLMFallback(messages: LLMMessage[]): Promise<string> {
  return callAILLM(messages);
}

// Used for: report generation, patient letters, medication extraction,
// speaker diarization, scale detection, session comparison.
// Server handles the full AI fallback chain automatically via streaming.
async function callLLMWithFallback(
  messages: LLMMessage[],
  onFallback: () => void,
  options?: { countable?: boolean; taskType?: string; onChunk?: (chunk: string) => void },
): Promise<string> {
  const body: Record<string, unknown> = { messages };
  if (options?.taskType) body.taskType = options.taskType;
  else if (options?.countable === false) body.taskType = "utility";
  return callChatSSE(body, options?.onChunk, onFallback);
}

async function callTranscribeWithFallback(
  audioFile: File,
  onFallback: () => void,
  signal?: AbortSignal,
): Promise<string> {
  const token = await getAuthToken();
  const form = new FormData();
  form.append("file", audioFile);
  const res = await fetch("/api/ai/transcribe", {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
    signal,
  });
  if (!res.ok) {
    let errMsg = "Transcription service temporarily unavailable — please try again in a moment.";
    try {
      const body = await res.text();
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) errMsg = parsed.message;
    } catch { /* use default */ }
    throw new Error(errMsg);
  }
  const data = await res.json() as { transcript?: string };
  if (data.transcript === undefined || data.transcript === "") {
    throw new Error("Transcription returned empty — please try again or type the transcript manually.");
  }
  return data.transcript;
}

// ══════════════════════════════════════════════════════════════
interface AppProps {
  doctorId: string;
  doctorDisplayName: string | null;
  onLock?: () => void;
}

export default function App({ doctorId, doctorDisplayName, onLock }: AppProps) {
  // ── One-time cleanup: purge legacy collateral-draft keys from before the
  // per-entry scoping fix existed. Old keys came in two broken shapes:
  //   1. `psych_collateral_draft_<doctorId>_<selectedId>` (no entry scope at all)
  //   2. `psych_collateral_draft_<doctorId>_<selectedId>_new` (generic "new"
  //      bucket shared by every brand-new session for every patient)
  // Both shapes leaked one patient's/session's collateral text into others.
  // This runs once per app load and only removes keys matching this exact
  // prefix — nothing else in localStorage is touched.
  useEffect(() => {
    try {
      const prefix = "psych_collateral_draft_";
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
    } catch (_) { /* fail silently — non-critical cleanup */ }
  }, []);
  const [changePinOpen, setChangePinOpen] = useState(false);
  const [appLoading,    setAppLoading]    = useState(true);

  // ── Session auto sign-out (hard limit, separate from PIN idle-lock) ──
  useEffect(() => {
    const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes hard sign-out
    const WARNING_MS = 2 * 60 * 1000;
    let idleTimer: ReturnType<typeof setTimeout>;
    let warnTimer: ReturnType<typeof setTimeout>;
    let warningShown = false;
    // Track recording state so timers are suppressed while mic is active
    let isRecordingActive = false;

    const doSignOut = async () => {
      localStorage.removeItem("psych_pending_country");
      sessionStorage.clear();
      await supabase.auth.signOut();
      window.location.href = "/";
    };

    const resetTimers = () => {
      // Never auto-sign-out while a recording is in progress
      if (isRecordingActive) return;
      clearTimeout(idleTimer);
      clearTimeout(warnTimer);
      warningShown = false;

      warnTimer = setTimeout(() => {
        if (isRecordingActive) return; // recording started while warning was pending
        warningShown = true;
        const stay = window.confirm(
          "You have been idle for 28 minutes.\n\nClick OK to stay signed in, or Cancel to sign out now."
        );
        if (!stay) doSignOut();
      }, IDLE_TIMEOUT_MS - WARNING_MS);

      idleTimer = setTimeout(() => {
        if (warningShown || isRecordingActive) return;
        doSignOut();
      }, IDLE_TIMEOUT_MS);
    };

    const onRecordingState = (e: Event) => {
      isRecordingActive = (e as CustomEvent<{ active: boolean }>).detail.active;
      if (isRecordingActive) {
        // Recording started — clear all session-timeout timers immediately
        clearTimeout(idleTimer);
        clearTimeout(warnTimer);
        warningShown = false;
      } else {
        // Recording stopped — restart the idle timer fresh from now
        resetTimers();
      }
    };

    const events = ["mousedown", "mousemove", "keydown", "touchstart", "scroll", "click"];
    events.forEach(ev => window.addEventListener(ev, resetTimers, { passive: true }));
    window.addEventListener("sphota_recording_state", onRecordingState);
    resetTimers();

    return () => {
      clearTimeout(idleTimer);
      clearTimeout(warnTimer);
      events.forEach(ev => window.removeEventListener(ev, resetTimers));
      window.removeEventListener("sphota_recording_state", onRecordingState);
    };
  }, []);

  // ── Report usage limit ────────────────────────────────────────
  const [reportCount,          setReportCount]          = useState(0);
  const [feedbackBonusUsed,    setFeedbackBonusUsed]    = useState(false);
  const [showReportLimitModal, setShowReportLimitModal] = useState(false);
  const [monthlyCount,         setMonthlyCount]         = useState(0);
  const [isUnlimited,          setIsUnlimited]          = useState(false);
  const [userPlan,             setUserPlan]             = useState<"free" | "starter" | "clinical" | "premium">("free");
  const [planExpiresAt,        setPlanExpiresAt]        = useState<Date | null>(null);
  const [planExpiryNotice,     setPlanExpiryNotice]     = useState<"tomorrow" | "today" | null>(null);
  const [planExpiryDismissed,  setPlanExpiryDismissed]  = useState(() =>
    !!sessionStorage.getItem(`sphota_expiry_dismissed_${new Date().toISOString().slice(0, 10)}`)
  );

  // ── Onboarding popup (replaces tour) ─────────────────────────
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingTriggeredRef = useRef(false);
  const [toastMsg,  setToastMsg]  = useState<string | null>(null);
  const [toastType, setToastType] = useState<"success" | "error" | "default">("default");
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string, type: "success" | "error" | "default" = "default") {
    setToastMsg(msg);
    setToastType(type);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 4000);
  }
  const [followUpToast, setFollowUpToast] = useState<{ msg: string; draft: { date: string; time: string; notes: string } } | null>(null);
  const followUpToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Theme & view
  // Load report usage from Supabase
  useEffect(() => {
    const currentMonthKey = new Date().toISOString().slice(0, 7);
    // Restore monthly count from localStorage immediately (instant, no flicker)
    try {
      const stored = localStorage.getItem(`psych_monthly_${doctorId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.month_key === currentMonthKey) setMonthlyCount(parsed.monthly_count ?? 0);
      }
    } catch (_) {}

    // Try full select (works once DB columns exist)
    supabase.from("report_usage").select("count, feedback_bonus_used, month_key, monthly_count, unlimited")
      .eq("user_id", doctorId).single()
      .then(({ data, error }) => {
        if (data && !error) {
          setReportCount(data.count ?? 0);
          setFeedbackBonusUsed(data.feedback_bonus_used ?? false);
          if (data.unlimited) setIsUnlimited(true);
          if (data.month_key === currentMonthKey) {
            const dbMonthly = data.monthly_count ?? 0;
            setMonthlyCount(dbMonthly);
            localStorage.setItem(`psych_monthly_${doctorId}`, JSON.stringify({ month_key: currentMonthKey, monthly_count: dbMonthly }));
          }
          // If DB month_key is stale, keep the localStorage value
          // already loaded at the top of this effect — do not overwrite
        } else {
          // Columns don't exist yet — fall back to basic columns only
          supabase.from("report_usage").select("count, feedback_bonus_used")
            .eq("user_id", doctorId).single()
            .then(({ data: d2 }) => {
              if (d2) {
                setReportCount(d2.count ?? 0);
                setFeedbackBonusUsed(d2.feedback_bonus_used ?? false);
                // Monthly count already loaded from localStorage above
              }
            });
        }
      });
  }, [doctorId]);

  // Show simple onboarding popup for first-time users — once per account
  useEffect(() => {
    if (!doctorId || onboardingTriggeredRef.current) return;
    const timer = setTimeout(() => {
      if (onboardingTriggeredRef.current) return;
      if (localStorage.getItem(`psych_tour_done_${doctorId}`)) return;
      onboardingTriggeredRef.current = true;
      setShowOnboarding(true);
    }, 1400);
    return () => clearTimeout(timer);
  }, [doctorId]);

  // ── Plan expiry notification ──────────────────────────────────
  useEffect(() => {
    if (!planExpiresAt || userPlan === "free") { setPlanExpiryNotice(null); return; }
    const now = new Date();
    const msLeft = planExpiresAt.getTime() - now.getTime();
    if (msLeft <= 0) {
      setUserPlan("free");
      setIsUnlimited(false);
      setPlanExpiresAt(null);
      setPlanExpiryNotice(null);
      return;
    }
    const hoursLeft = msLeft / (1000 * 60 * 60);
    if (hoursLeft <= 24)       setPlanExpiryNotice("today");
    else if (hoursLeft <= 48)  setPlanExpiryNotice("tomorrow");
    else                       setPlanExpiryNotice(null);
  }, [planExpiresAt, userPlan]);

  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("psych_theme") as Theme) || "dark");
  const [view,  setView]  = useState<"main" | "overview" | "payment">(() => {
    // Never restore "payment" view on login — payment page is only shown when
    // the user explicitly clicks Upgrade, or arrives from the landing page
    // with a pending plan selected. sphota_pending_plan is cleared after payment.
    const s = localStorage.getItem(`psych_view_${doctorId}`);
    return s === "main" || s === "overview" ? s : "main";
  });
  useEffect(() => {
    // Never persist "payment" to localStorage — it would cause the payment
    // page to reappear on every subsequent login.
    if (view !== "payment") {
      localStorage.setItem(`psych_view_${doctorId}`, view);
    }
  }, [view, doctorId]);

  // Doctor profile
  const [doctor,       setDoctor]       = useState<DoctorProfile>({
    ...DEFAULT_DOCTOR,
    name: doctorDisplayName ?? DEFAULT_DOCTOR.name,
  });
  const [profileOpen,  setProfileOpen]  = useState(false);
  const [profileDraft, setProfileDraft] = useState<DoctorProfile>(DEFAULT_DOCTOR);

  // Patients — declared BEFORE mobileTab so the mobileTab effect below can safely reference it
  const [patients,        setPatients]       = useState<Patient[]>([]);
  const [selectedId,      setSelectedId]     = useState<number | null>(() => {
    const s = localStorage.getItem(`psych_selected_${doctorId}`);
    return s ? parseInt(s, 10) : null;
  });
  useEffect(() => {
    if (selectedId !== null) localStorage.setItem(`psych_selected_${doctorId}`, String(selectedId));
    else localStorage.removeItem(`psych_selected_${doctorId}`);
  }, [selectedId, doctorId]);

  // selectedIdRef mirrors selectedId state — used by async callbacks (collateral
  // transcription guard) that need to read the truly current patient selection,
  // not a value captured in a closure when the recording started.
  const selectedIdRef = useRef<number | null>(null);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // Mobile tab navigation (placed after selectedId so the guard effect below is valid)
  const [mobileTab, setMobileTab] = useState<"patients" | "report" | "record">(() => {
    const s = localStorage.getItem(`psych_mobiletab_${doctorId}`);
    return s === "patients" || s === "report" || s === "record" ? s : "patients";
  });
  useEffect(() => { localStorage.setItem(`psych_mobiletab_${doctorId}`, mobileTab); }, [mobileTab, doctorId]);
  // If no patient selected and we're on the record tab, fall back to patients tab
  useEffect(() => { if (selectedId === null && mobileTab === "record") setMobileTab("patients"); }, [selectedId, mobileTab]);
  // After patients load, validate stored selectedId — clear it if that patient no longer exists
  const patientValidatedRef = useRef(false);
  useEffect(() => {
    if (!patientValidatedRef.current && patients.length > 0) {
      patientValidatedRef.current = true;
      if (selectedId !== null && !patients.some(p => p.id === selectedId)) {
        setSelectedId(null);
        setView("overview");
      }
    }
  }, [patients]); // eslint-disable-line react-hooks/exhaustive-deps
  const [search,          setSearch]         = useState("");
  const [addPatientOpen,  setAddPatientOpen] = useState(false);
  const [editPatientOpen, setEditPatientOpen]= useState(false);
  const [patientDraft,    setPatientDraft]   = useState<PatientDraft>(EMPTY_DRAFT);
  const [deleteStep,      setDeleteStep]     = useState(0);
  const [shareMenuOpen,   setShareMenuOpen]  = useState(false);
  const [importReportModalOpen, setImportReportModalOpen] = useState(false);
  const [importedReportData, setImportedReportData] = useState<ReportEntry | null>(null);
  const [importReportStatus, setImportReportStatus] = useState<"idle" | "importing" | "done">("idle");
  const importReportFileRef = useRef<HTMLInputElement>(null);

  // Session
  const [transcript,     setTranscript]    = useState("");
  // transcriptRef mirrors transcript state so async functions (transcribeAudio)
  // always read the live value, not a stale closure capture.
  const transcriptRef = useRef("");
  const [sessionNotes,   setSessionNotes]  = useState("");
  // ── Collateral / Family Interview state ─────────────────────
  const [collateralTranscript, setCollateralTranscript] = useState("");
  const collateralTranscriptRef = useRef("");
  const [collateralRecording, setCollateralRecording] = useState(false);
  const [collateralTranscribing, setCollateralTranscribing] = useState(false);
  const [collateralElapsed, setCollateralElapsed] = useState(0);
  const [collateralAudioLevel, setCollateralAudioLevel] = useState(0);
  const [collateralSilentFrames, setCollateralSilentFrames] = useState(0);
  const [transcriptOpen, setTranscriptOpen]= useState(true);
  const [recording,      setRecording]     = useState(false);
  const [recUnexpectedStop, setRecUnexpectedStop] = useState(false);
  const [elapsed,        setElapsed]       = useState(0);
  const [audioLevel,     setAudioLevel]    = useState(0); // 0–1 live mic amplitude for waveform
  const [silentFrames,   setSilentFrames]  = useState(0); // counts consecutive silent frames for mic warning
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [consentChecked,   setConsentChecked]   = useState(false);
  // Maps patientId -> ISO timestamp of when consent was given this app session
  const consentGivenRef = useRef<Record<number, string>>({});
  const [transcribing,   setTranscribing]  = useState(false);
  const [transcriptView, setTranscriptView]= useState<"edit" | "view">("edit");
  const [scanModalOpen,  setScanModalOpen]  = useState(false);
  const [scanAuthToken,  setScanAuthToken]  = useState<string>("");
  // Opens the scan modal and pre-fetches the auth token so the API call is always authorised
  const openScanModal = async () => {
    const token = await getAuthToken();
    setScanAuthToken(token);
    setScanModalOpen(true);
  };
  const timerRef             = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef     = useRef<MediaRecorder | null>(null);
  const audioChunksRef       = useRef<Blob[]>([]);
  const recordedDurationRef  = useRef(0);
  // Tracks elapsed seconds at the boundary of the last auto-chunk send.
  // Used to compute the ACTUAL duration of the final blob when the user stops.
  // Without this, recordedDurationRef gets set to the full session elapsed time
  // (e.g. 1500s for a 25-min session) while the final blob only contains audio
  // since the last 4-min chunk — causing the size-vs-duration guard to reject it.
  const lastChunkElapsedRef  = useRef(0);
  // WebM header seed for chunked recording.
  // MediaRecorder with a timeslice (1s) only includes the EBML container header
  // (codec info, Tracks element) in the FIRST ondataavailable blob. Every
  // subsequent blob is raw cluster data with no header — an invalid standalone
  // audio file that Gemini/Whisper cannot decode (causes hallucinations or silence).
  // Fix: capture the first blob here, then prepend it to chunks 2, 3, … and
  // to the final onstop blob (when at least one chunk was already flushed).
  const headerSeedRef        = useRef<Blob | null>(null);
  // Auto-chunking: fires every 4 minutes to silently flush a chunk for transcription
  const chunkTimerRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef          = useRef<WakeLockSentinel | null>(null);
  const intentionalStopRef   = useRef(false);
  // Session generation counter — incremented by newSession() on every new session.
  // transcribeAudio() captures this at call-entry and checks it before writing results.
  // If the value changed, newSession() fired mid-transcription — discard silently.
  // Replaces the old discardNextTranscriptionRef one-shot boolean, which was vulnerable
  // to being consumed by a concurrent chunk call rather than the intended onstop call.
  const sessionGenRef = useRef(0);
  const audioContextRef      = useRef<AudioContext | null>(null);
  const analyserRef          = useRef<AnalyserNode | null>(null);
  const animFrameRef         = useRef<number | null>(null);
  const silentFramesRef      = useRef(0);
  // ── Online-call recording (mic + tab/system audio mixed) — additive mode ──
  // Separate from audioContextRef (used by the waveform monitor) so the two
  // never collide. Only ever populated when recording mode === "call".
  const callMixCtxRef        = useRef<AudioContext | null>(null);
  const callRawTracksRef     = useRef<MediaStreamTrack[]>([]);
  const pendingRecordModeRef = useRef<"mic" | "call">("mic");
  const [callAudioUnsupported] = useState(() => typeof (navigator.mediaDevices as any)?.getDisplayMedia === "undefined");
  const notesSaveTimer        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcribeAbortRef    = useRef<AbortController | null>(null);

  const [reportCopied, setReportCopied] = useState(false);

  const [draftBanner, setDraftBanner] = useState(false);
  const draftSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [icdPopover, setIcdPopover] = useState<{ code: string; text: string; loading: boolean; error: boolean } | null>(null);
  const [icdAnchor, setIcdAnchor] = useState<{ top: number; left: number } | null>(null);
  const [noteModalOpen, setNoteModalOpen] = useState(false);

  // Reports & history
  const [history,         setHistory]        = useState<Record<number, ReportEntry[]>>({});
  const [activeEntryId,   setActiveEntryId]  = useState<string | null>(null);
  const [flagged,         setFlagged]        = useState<Set<string>>(new Set());
  const [loading,         setLoading]        = useState(false);
  const [error,           setError]          = useState("");
  const [generateError,   setGenerateError]  = useState("");
  const [mediaRecorderUnsupported] = useState(() => typeof MediaRecorder === "undefined");
  const [autoSaveError,   setAutoSaveError]  = useState(false);
  const [genMsgIndex,     setGenMsgIndex]    = useState(0);
  const [sessionComparisons, setSessionComparisons] = useState<Record<string, string>>({});
  const [deletingEntryId, setDeletingEntryId]= useState<string | null>(null);
  const [editMode,        setEditMode]       = useState(false);
  const [viewOriginalOpen,setViewOriginalOpen]= useState(false);
  const [reportExpanded,   setReportExpanded]  = useState(false);
  const [streamingRawText, setStreamingRawText] = useState("");
  const [reportJustReady,  setReportJustReady]  = useState(false);
  const [failedMidStream,  setFailedMidStream]  = useState(false);
  const streamingAccRef  = useRef(""); // full accumulated streaming text
  const streamingBufRef  = useRef(""); // pending partial section buffer

  // Realtime sync
  const [liveConnected,   setLiveConnected]   = useState(false);
  const [remoteRecording, setRemoteRecording] = useState(false);
  const realtimeChannelRef  = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const globalChannelRef    = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const activeEntryIdRef    = useRef<string | null>(null);
  const myDeviceIdRef       = useRef<string>(Math.random().toString(36).slice(2) + Date.now().toString(36));
  const transcriptSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collateralSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Unique token for the current "no activeEntryId yet" (brand-new, unsaved)
  // session. Previously every unsaved session — for every patient — shared
  // one literal "new" localStorage bucket, so any two unsaved sessions (even
  // the same patient's earlier abandoned draft) collided and leaked into
  // each other. This ref is regenerated every time a session goes back to
  // "new" (patient switch, manual new-session, delete, etc.) so each one
  // gets its own private key.
  const newSessionTokenRef = useRef<string>(`new_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  // Tracks the previously selected patient so we can detect a true switch
  const prevSelectedIdRef = useRef<number | null>(null);
  const [globalRecording, setGlobalRecording] = useState<{
    patientId: number; patientName: string; entryId: string;
  } | null>(null);
  // presenceMap: patientId → count of OTHER devices from same account currently viewing that patient
  const [presenceMap, setPresenceMap] = useState<Record<number, number>>({});

  // Medications
  const [meds,         setMeds]         = useState<Record<number, PatientMedRecord>>({});
  const [medModalMode, setMedModalMode] = useState<"review" | "manage">("manage");
  const [medModalOpen, setMedModalOpen] = useState(false);
  const [medDrafts,    setMedDrafts]    = useState<MedDraft[]>([]);

  // Appointments
  const [appointments,  setAppointments]  = useState<Appointment[]>(() => {
    try { return JSON.parse(localStorage.getItem("psych_appointments") ?? "[]"); } catch { return []; }
  });
  const [apptModalOpen,  setApptModalOpen]  = useState(false);
  const [apptDraft,      setApptDraft]      = useState({ date: "", time: "", notes: "" });
  const [editingApptId,  setEditingApptId]  = useState<string | null>(null);
  const [mobileApptListOpen, setMobileApptListOpen] = useState(false);

  // Reminder banner — shows once per calendar day (dismissed via sessionStorage)
  const todayStr          = new Date().toISOString().slice(0, 10);
  const todayAppointments = appointments.filter(a => a.date === todayStr);
  const [reminderDismissed, setReminderDismissed] = useState(
    () => !!sessionStorage.getItem(`psych_reminder_dismissed_${todayStr}`)
  );

  const generateReportRef = useRef<() => void>(() => {});

  // Patient document
  const [reportTab,              setReportTab]              = useState<"clinical" | "patient" | "progress">("clinical");
  const [patientDocLang,          setPatientDocLang]          = useState<DocLang>("en");
  const [patientDocLoading,       setPatientDocLoading]       = useState(false);
  const [translationLoadingLang,  setTranslationLoadingLang]  = useState<DocLang | null>(null);
  const [exportMenuOpen,         setExportMenuOpen]         = useState(false);
  const [mobileTranscriptOpen,   setMobileTranscriptOpen]   = useState(false);
  const [dataRegionWarning, setDataRegionWarning] = useState<boolean>(false);

  const [retentionAlert, setRetentionAlert] = useState<{ count: number; years: string } | null>(null);

  // ── Initial data load ────────────────────────────────────────
  useEffect(() => {
    async function loadAll() {
      try {
        // On mobile, Supabase may not have fully restored the session yet.
        // Only wait if the session genuinely isn't ready — don't add a flat
        // delay on every load (this used to always sleep 600ms even when
        // the session was already available).
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData.session) {
          await new Promise(r => setTimeout(r, 600));
        }

        // PERFORMANCE FIX: report_entries (full session history, including
        // every translated patient document and full transcripts) is by far
        // the largest and slowest query here — it was previously bundled
        // into the same Promise.all as everything else, so the entire
        // dashboard (patient list, profile, appointments) sat blank waiting
        // on it. It's now kicked off in parallel but NOT awaited together
        // with the rest — the fast, small queries resolve and render the
        // dashboard immediately, and session history fills in moments later
        // once it arrives. The resulting `history` state ends up identical
        // either way; only the render is no longer gated on the slowest call.
        const sessionsPromise = db.getSessions();

        const [docProfile, pats, medsAll, cloudAppts, planRow] = await Promise.all([
          db.getProfile(),
          db.getPatients(),
          db.getAllMedications(),
          db.getAppointments(),
          supabase.from("doctors").select("plan,plan_expires_at").eq("id", doctorId).maybeSingle().then(r => r.data as { plan?: string; plan_expires_at?: string | null } | null),
        ]);

        if (docProfile) {
          setDoctor({
            name:              docProfile.name || doctorDisplayName || "",
            specialty:         docProfile.specialty || "Psychiatry",
            clinic:            docProfile.clinic || "",
            contact:           docProfile.contact || "",
            dataRegion:        docProfile.dataRegion || "India",
            noteFormat:        docProfile.noteFormat ?? "SOAP",
            privacyAcceptedAt: docProfile.privacyAcceptedAt ?? null,
            dataRetentionYears: (docProfile.dataRetentionYears as DoctorProfile["dataRetentionYears"]) ?? "never",
          });
        }

        // ── Plan + expiry ──────────────────────────────────────
        if (planRow) {
          const rawPlan    = planRow.plan ?? "free";
          const rawExpiry  = planRow.plan_expires_at ?? null;
          const expiryDate = rawExpiry ? new Date(rawExpiry) : null;
          const now        = new Date();

          // If expiry date is in the past, treat as free immediately
          if (expiryDate && expiryDate <= now && rawPlan !== "unlimited") {
            setUserPlan("free");
            setIsUnlimited(false);
            setPlanExpiresAt(null);
          } else {
            if (rawPlan === "starter" || rawPlan === "clinical" || rawPlan === "premium") {
              setUserPlan(rawPlan);
              if (rawPlan === "clinical" || rawPlan === "premium") setIsUnlimited(true);
            } else if (rawPlan === "unlimited") {
              setUserPlan("premium");
              setIsUnlimited(true);
            }
            if (expiryDate) setPlanExpiresAt(expiryDate);
          }
        }

        setPatients(pats);
        setMeds(medsAll ?? {});

        // ── Appointments: migrate localStorage → Supabase (one-time) ──
        // If there are local appointments and Supabase has none, this is
        // the first load after the cloud sync was enabled. Push them up,
        // then wipe localStorage so Supabase is the permanent source of truth.
        const localAppts: Appointment[] = (() => {
          try { return JSON.parse(localStorage.getItem("psych_appointments") ?? "[]"); }
          catch { return []; }
        })();
        if (localAppts.length > 0 && cloudAppts.length === 0) {
          await Promise.allSettled(localAppts.map(a => db.saveAppointment(a)));
          setAppointments(localAppts);
        } else {
          setAppointments(cloudAppts);
        }
        localStorage.removeItem("psych_appointments");
        // Show payment page once if user came from landing page with a plan selected.
        // Move the pending plan to sessionStorage immediately so it doesn't
        // persist across future logins — only valid for the current browser session.
        const pendingPlan = localStorage.getItem("sphota_pending_plan");
        if (pendingPlan) {
          sessionStorage.setItem("sphota_pending_plan_session", pendingPlan);
          localStorage.removeItem("sphota_pending_plan");
          setView("payment");
        }

        // The dashboard shell (patients, profile, plan, appointments) is now
        // fully populated — stop showing the loading state. Session history
        // (the slow report_entries fetch) continues loading in the
        // background below and populates `history` as soon as it's ready,
        // without making the doctor wait for it before seeing their patients.
        setAppLoading(false);

        // ── Session history (slow query — resolved separately) ──────────
        try {
          const sessions = await sessionsPromise;
          const hist: Record<number, ReportEntry[]> = {};
          const flaggedIds = new Set<string>();
          for (const { patientId, entry } of sessions) {
            // Skip auto-save draft entries — they exist only to preserve
            // transcript state across page refreshes, not as real clinical records.
            // Draft IDs are deterministic: "draft_<doctorId>_<patientId>".
            // Including them inflates report counts and pollutes session history.
            if (entry.id.startsWith("draft_")) continue;
            const rawText = entry.rawText ?? "";
            const fullEntry = { ...entry, report: rawText ? parseReport(rawText) : { sections: [], diagnosis: "", plan: [] } };
            if (!hist[patientId]) hist[patientId] = [];
            hist[patientId].push(fullEntry);
            if (entry.flagged) flaggedIds.add(entry.id);
          }
          Object.values(hist).forEach(arr => arr.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
          setHistory(hist);
          setFlagged(flaggedIds);

          // DPDP retention check — flag sessions older than the retention window
          if (docProfile?.dataRetentionYears && docProfile.dataRetentionYears !== "never") {
            const cutoff = new Date();
            cutoff.setFullYear(cutoff.getFullYear() - parseInt(docProfile.dataRetentionYears));
            const cutoffStr = cutoff.toISOString().slice(0, 10);
            // Just log — actual deletion requires doctor confirmation, not auto-delete
            const allEntries = Object.values(hist).flat();
            const oldSessions = allEntries.filter(e => e.date < cutoffStr);
            if (oldSessions.length > 0) {
              setRetentionAlert({ count: oldSessions.length, years: docProfile.dataRetentionYears });
            }
          }
        } catch (e) {
          console.error("Failed to load session history:", e);
        }
      } catch (e) {
        console.error("Failed to load app data:", e);
        setAppLoading(false);
      }
    }
    loadAll();
  }, [doctorId, doctorDisplayName]);

  // ── Effects ──────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("psych_theme", theme);
    // Keep the browser chrome (status bar / address bar tint) in sync with the in-app theme,
    // so there's no mismatched-color seam at the top of the screen on mobile.
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) metaThemeColor.setAttribute("content", theme === "light" ? "#ffffff" : "#141416");
  }, [theme]);

  // Keep transcriptRef in sync so async callbacks always read live transcript value
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { collateralTranscriptRef.current = collateralTranscript; }, [collateralTranscript]);
  // Mint a fresh, unique token every time we land back on "no saved entry
  // yet" (activeEntryId === null) — covers every call site that resets it
  // (patient switch, new session, delete, etc.) from one place, so none can
  // be missed. This is what the "new" localStorage bucket key is built from
  // below, instead of the previous shared literal "new" string.
  useEffect(() => {
    if (activeEntryId === null) {
      newSessionTokenRef.current = `new_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
  }, [activeEntryId, selectedId]);

  useEffect(() => {
    if (recording) {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [recording]);

  // Release ALL recording resources on unmount — prevents orphaned MediaRecorder,
  // AudioContext, AnimFrame, and chunk timer if auth timeout tears the component down mid-recording.
  useEffect(() => {
    return () => {
      try { wakeLockRef.current?.release(); } catch { /* fail silently */ }
      if (chunkTimerRef.current) { clearInterval(chunkTimerRef.current); chunkTimerRef.current = null; }
      if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
      if (audioContextRef.current) { audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
      callRawTracksRef.current.forEach(t => { try { t.stop(); } catch { /* already stopped */ } });
      callRawTracksRef.current = [];
      if (callMixCtxRef.current) { callMixCtxRef.current.close().catch(() => {}); callMixCtxRef.current = null; }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        intentionalStopRef.current = true; // prevent unexpected-stop toast on forced unmount
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  // ── Cycle status messages during report generation ───────────────────────
  const GEN_MESSAGES = [
    "Analysing session transcript...",
    "Identifying clinical themes and symptoms...",
    "Structuring findings into SOAP format...",
    "Cross-referencing diagnostic criteria...",
    "Drafting clinical observations...",
    "Reviewing medication and treatment notes...",
    "Finalising report structure...",
    "Almost ready...",
  ] as const;
  useEffect(() => {
    if (!loading) { setGenMsgIndex(0); return; }
    const id = setInterval(() => setGenMsgIndex(i => (i + 1) % GEN_MESSAGES.length), 2500);
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); generateReportRef.current(); }
      if (e.key === "Escape") { setReportExpanded(false); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Recording in progress. Leaving this page will stop the recording and you may lose your session.";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [recording]);

  // ── Suppress auto-lock and session timeout during recording ──────────────
  // Broadcasts a custom event so AuthGate (parent) can pause the PIN idle-lock
  // timer, and also suppresses the local 30-min session sign-out timer.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("sphota_recording_state", { detail: { active: recording } }));
  }, [recording]);

  // Sync notes when switching sessions
  useEffect(() => {
    const entry = selectedId ? (history[selectedId] ?? []).find(e => e.id === activeEntryId) : null;
    setSessionNotes(entry?.notes ?? "");
  }, [activeEntryId, selectedId]);

  // ── Clear transcript whenever the selected patient changes ───────────────
  // This is the single authoritative place where transcript is wiped on a
  // patient switch.  Every path that changes selectedId (sidebar click,
  // overview page, appointment reminder, "View patient" button, adding a new
  // patient) benefits automatically — no need to remember to call
  // setTranscript("") at each callsite.  The draft-restore effect below then
  // re-populates the transcript if the newly selected patient has a saved draft.
  useEffect(() => {
    // Skip the very first mount (prevSelectedIdRef starts null, selectedId may
    // already be initialised from localStorage — we don't want to clobber a
    // restored draft on first load).
    if (prevSelectedIdRef.current === selectedId) return;
    const previousId = prevSelectedIdRef.current;
    prevSelectedIdRef.current = selectedId;
    // GUARD: if a recording OR transcription is in progress, revert the patient
    // selection back to the active patient. We must not wipe the live transcript or
    // kill the transcription just because the user tapped another patient by mistake.
    // The sidebar / history chip guards below show a toast, but this is the
    // belt-and-suspenders safety net in case any other code path calls setSelectedId.
    if (recording || transcribing) {
      prevSelectedIdRef.current = previousId;
      setSelectedId(previousId!);
      return;
    }
    // Only clear when actually switching to a different (or null) patient.
    // SYNC clear transcriptRef immediately so any in-flight transcribeAudio call
    // that passes the write guard sees "" and doesn't contaminate the new patient.
    transcriptRef.current = "";
    setTranscript("");
    // Clear collateral transcript on patient switch
    collateralTranscriptRef.current = "";
    setCollateralTranscript("");
    setCollateralRecording(false);
    setCollateralTranscribing(false);
    setCollateralElapsed(0);
    setDraftBanner(false);
    setEditMode(false);
    setActiveEntryId(null);
    setError("");
    setGenerateError(""); // clear stale error so old generated reports do not show error banner
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset edit mode and patient doc state when switching sessions.
  // Also restore the transcript draft when coming back to the new-session slot
  // (activeEntryId === null) — this is what makes the transcribed text survive
  // after the user browses a past session and returns.
  useEffect(() => {
    // Do NOT reset editMode here — that is managed by the edit/save/discard
    // actions themselves. Resetting it on every activeEntryId change caused
    // the editor to collapse the moment the Realtime subscription re-subscribed
    // after saving (which momentarily cycles activeEntryId through null).
    setViewOriginalOpen(false);
    setReportTab("clinical");
    setPatientDocLang("en");
    setReportCopied(false);
    setIcdPopover(null);
    setIcdAnchor(null);
    setGenerateError(""); // clear stale error when switching to a different session entry

    // When landing back on the new-session slot, restore the saved draft so the
    // transcript isn't lost. We only do this when activeEntryId is null AND
    // selectedId is set — i.e. the user is on the new-session view for a patient.
    // We do NOT overwrite if recording/transcribing is active (the live transcript
    // is already in state and must not be replaced).
    if (activeEntryId === null && selectedId !== null && !recording && !transcribing) {
      const saved = localStorage.getItem(`psych_draft_${doctorId}_${selectedId}`);
      if (saved && saved.trim()) {
        setTranscript(saved);
      }
    }
  }, [activeEntryId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime: subscribe to current session for cross-device sync ──
  useEffect(() => {
    if (realtimeChannelRef.current) {
      supabase.removeChannel(realtimeChannelRef.current);
      realtimeChannelRef.current = null;
    }
    setLiveConnected(false);
    setRemoteRecording(false);
    if (!activeEntryId) return;

    const channel = supabase
      .channel(`session-${activeEntryId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "report_entries", filter: `id=eq.${activeEntryId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const incoming = row.transcript as string | undefined;
          if (incoming !== undefined) {
            setTranscript(prev => (prev === incoming ? prev : incoming));
          }
          // Also sync the generated report (raw_text) so it appears without a reload
          const incomingRaw = row.raw_text as string | undefined;
          if (incomingRaw !== undefined) {
            setHistory(prev => {
              const patId = row.patient_id as number;
              const entryId = row.id as string;
              const arr = prev[patId] ?? [];
              if (!arr.some(e => e.id === entryId)) return prev;
              return {
                ...prev,
                [patId]: arr.map(e => {
                  if (e.id !== entryId) return e;
                  const newReport = incomingRaw ? parseReport(incomingRaw) : e.report;
                  return { ...e, rawText: incomingRaw || e.rawText, report: newReport };
                }),
              };
            });
          }
        }
      )
      .on("broadcast", { event: "recording_state" }, ({ payload }) => {
        setRemoteRecording(payload?.active === true);
      })
      .subscribe((status) => {
        setLiveConnected(status === "SUBSCRIBED");
      });

    realtimeChannelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      realtimeChannelRef.current = null;
      setLiveConnected(false);
      setRemoteRecording(false);
    };
  }, [activeEntryId]);

  // ── Keep activeEntryIdRef in sync ────────────────────────────
  useEffect(() => { activeEntryIdRef.current = activeEntryId; }, [activeEntryId]);

  // ── Global doctor channel: cross-device sync for ALL tables ──
  useEffect(() => {
    if (!doctorId) return;

    // Map raw DB row (snake_case) → Patient
    const mapPatientRow = (row: Record<string, unknown>): Patient => ({
      id:     row.id     as number,
      name:   row.name   as string,
      age:    (row.age   as number)  ?? 0,
      gender: (row.gender as string) ?? "Unknown",
      time:   (row.time  as string)  ?? "",
      status: ((row.status as string) ?? "waiting") as Patient["status"],
    });

    // Map raw DB row → ReportEntry (everything except transcript — session channel owns that)
    const mapEntryRow = (row: Record<string, unknown>): ReportEntry => {
      const rawText = (row.raw_text as string) ?? "";
      return {
        id:                     row.id        as string,
        date:                   row.date      as string,
        transcript:             (row.transcript as string) ?? "",
        rawText:                rawText || undefined,
        editedHtml:             (row.edited_html as string)  || undefined,
        editedAt:               (row.edited_at  as string)   || undefined,
        notes:                  (row.notes      as string)   ?? "",
        flagged:                (row.flagged    as boolean)  ?? false,
        patientDocMd:           (row.patient_doc_md            as string) || undefined,
        patientDocHindiMd:      (row.patient_doc_hindi_md      as string) || undefined,
        patientDocMarathiMd:    (row.patient_doc_marathi_md    as string) || undefined,
        patientDocBengaliMd:    (row.patient_doc_bengali_md    as string) || undefined,
        patientDocTamilMd:      (row.patient_doc_tamil_md      as string) || undefined,
        patientDocTeluguMd:     (row.patient_doc_telugu_md     as string) || undefined,
        patientDocEditedHtmlEn: (row.patient_doc_edited_html_en as string) || undefined,
        patientDocEditedHtmlHi: (row.patient_doc_edited_html_hi as string) || undefined,
        scaleScores: (() => {
          const j = row.scale_scores_json as string;
          if (!j) return undefined;
          try { return JSON.parse(j); } catch { return undefined; }
        })(),
        report: rawText ? parseReport(rawText) : { sections: [], diagnosis: "", plan: [] },
      };
    };

    const ch = supabase
      .channel(`doctor-${doctorId}`)
      // ── patients ─────────────────────────────────────────────
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "patients",
        filter: `doctor_id=eq.${doctorId}` }, ({ new: row }) => {
        const p = mapPatientRow(row as Record<string, unknown>);
        setPatients(prev => prev.some(x => x.id === p.id) ? prev : [p, ...prev]);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "patients",
        filter: `doctor_id=eq.${doctorId}` }, ({ new: row }) => {
        const p = mapPatientRow(row as Record<string, unknown>);
        setPatients(prev => prev.map(x => x.id === p.id ? { ...x, ...p } : x));
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "patients",
        filter: `doctor_id=eq.${doctorId}` }, ({ old: row }) => {
        const id = (row as Record<string, unknown>).id as number;
        setPatients(prev => prev.filter(x => x.id !== id));
        setHistory(prev => { const n = { ...prev }; delete n[id]; return n; });
        setSelectedId(prev => prev === id ? null : prev);
      })
      // ── report_entries ────────────────────────────────────────
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "report_entries",
        filter: `doctor_id=eq.${doctorId}` }, ({ new: row }) => {
        const r = row as Record<string, unknown>;
        const patId = r.patient_id as number;
        const entry = mapEntryRow(r);
        setHistory(prev => {
          const arr = prev[patId] ?? [];
          const existing = arr.find(e => e.id === entry.id);
          if (existing) {
            // Local copy is authoritative — it was created on this device with full
            // rawText already parsed.  Realtime INSERT payloads are capped at ~8 kB
            // by Postgres so raw_text is often empty/truncated in the event.
            // Never overwrite a locally-created entry from a Realtime INSERT.
            return prev;
          }
          // Entry came from another device — add it, but re-fetch raw_text from DB
          // if rawText is missing (payload truncation) so report isn't blank.
          const next = [entry, ...arr].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          return { ...prev, [patId]: next };
        });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "report_entries",
        filter: `doctor_id=eq.${doctorId}` }, ({ new: row }) => {
        const r = row as Record<string, unknown>;
        const entryId = r.id as string;
        const patId   = r.patient_id as number;
        const incoming = mapEntryRow(r);
        setHistory(prev => {
          const arr = prev[patId] ?? [];
          if (!arr.some(e => e.id === entryId)) return prev;
          return {
            ...prev,
            [patId]: arr.map(e => {
              if (e.id !== entryId) return e;
              // Keep local transcript for the active session — session channel owns it
              const keepTranscript = e.id === activeEntryIdRef.current;
              // Keep local rawText/report if the Realtime UPDATE payload has empty raw_text
              // (Postgres change payloads are capped ~8 kB — large clinical reports get truncated)
              const keepRawText = !!e.rawText && !incoming.rawText;
              // Keep editedHtml/editedAt/reviewConfirmedAt if the incoming payload is missing them.
              // The edited HTML report is large and almost always gets truncated in Realtime payloads.
              // Without this guard the locally-saved edit appears to vanish seconds after saving
              // because { ...e, ...incoming } overwrites editedHtml with undefined.
              const keepEditedHtml = !!e.editedHtml && !incoming.editedHtml;
              // Keep all patient letter fields if the incoming payload is missing them
              // (same 8 kB Realtime truncation issue — letter fields are large)
              const keepPatientDoc = !!e.patientDocMd && !incoming.patientDocMd;
              return {
                ...e,
                ...incoming,
                ...(keepTranscript ? { transcript: e.transcript } : {}),
                ...(keepRawText ? { rawText: e.rawText, report: e.report } : {}),
                ...(keepEditedHtml ? {
                  editedHtml:        e.editedHtml,
                  editedAt:          e.editedAt,
                  reviewConfirmedAt: e.reviewConfirmedAt,
                } : {}),
                ...(keepPatientDoc ? {
                  patientDocMd:           e.patientDocMd,
                  patientDocHindiMd:      e.patientDocHindiMd,
                  patientDocMarathiMd:    e.patientDocMarathiMd,
                  patientDocBengaliMd:    e.patientDocBengaliMd,
                  patientDocTamilMd:      e.patientDocTamilMd,
                  patientDocTeluguMd:     e.patientDocTeluguMd,
                  patientDocEditedHtmlEn: e.patientDocEditedHtmlEn,
                  patientDocEditedHtmlHi: e.patientDocEditedHtmlHi,
                } : {}),
              };
            }),
          };
        });
      })
      // ── medications ───────────────────────────────────────────
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "medications",
        filter: `doctor_id=eq.${doctorId}` }, ({ new: row }) => {
        const r = row as Record<string, unknown>;
        setMeds(prev => ({ ...prev, [r.patient_id as number]: r.data as PatientMedRecord }));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "medications",
        filter: `doctor_id=eq.${doctorId}` }, ({ new: row }) => {
        const r = row as Record<string, unknown>;
        setMeds(prev => ({ ...prev, [r.patient_id as number]: r.data as PatientMedRecord }));
      })
      // ── global recording indicator (from any device) ──────────
      .on("broadcast", { event: "recording_live" }, ({ payload }) => {
        if (payload?.active) {
          setGlobalRecording({
            patientId:   payload.patientId   as number,
            patientName: payload.patientName as string,
            entryId:     payload.entryId     as string,
          });
        } else {
          setGlobalRecording(null);
        }
      })
      // ── Presence: who else (same account) is viewing what patient ──
      .on("presence", { event: "sync" }, () => {
        type PresencePayload = { deviceId: string; patientId: number | null };
        const state = ch.presenceState<PresencePayload>();
        const myId = myDeviceIdRef.current;
        const map: Record<number, number> = {};
        for (const presences of Object.values(state)) {
          for (const p of presences) {
            if (p.deviceId === myId) continue;      // skip self
            if (p.patientId != null) {
              map[p.patientId] = (map[p.patientId] ?? 0) + 1;
            }
          }
        }
        setPresenceMap(map);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          ch.track({ deviceId: myDeviceIdRef.current, patientId: null }).catch(() => {});
        }
      });

    globalChannelRef.current = ch;
    return () => {
      supabase.removeChannel(ch);
      globalChannelRef.current = null;
      setGlobalRecording(null);
      setPresenceMap({});
    };
  }, [doctorId]);

  // ── Update presence when navigating to a different patient ────
  useEffect(() => {
    const ch = globalChannelRef.current;
    if (!ch) return;
    ch.track({ deviceId: myDeviceIdRef.current, patientId: selectedId ?? null }).catch(() => {});
  }, [selectedId]);

  // ── Broadcast recording state to other devices ────────────────
  const didRecordRef = useRef(false);
  useEffect(() => {
    // Only broadcast after recording has actually been toggled (skip mount-time false)
    if (!recording && !didRecordRef.current) return;
    didRecordRef.current = true;

    // Session-scoped channel: tells other devices viewing the SAME session
    const channel = realtimeChannelRef.current;
    if (channel && activeEntryId) {
      channel.send({ type: "broadcast", event: "recording_state", payload: { active: recording } }).catch(() => {});
    }
    // Global doctor channel: tells ALL devices (any patient/view) about live recording
    const global = globalChannelRef.current;
    if (global && selectedId) {
      const patient = patients.find(p => p.id === selectedId);
      global.send({
        type: "broadcast",
        event: "recording_live",
        payload: {
          active:      recording,
          patientId:   selectedId,
          patientName: patient?.name ?? "a patient",
          entryId:     activeEntryId ?? "",
        },
      }).catch(() => {});
    }
  }, [recording, activeEntryId, selectedId, patients]);

  // ── Debounced transcript save to Supabase (for realtime sync) ──
  useEffect(() => {
    if (!activeEntryId || !transcript) return;
    if (transcriptSaveTimerRef.current) clearTimeout(transcriptSaveTimerRef.current);
    transcriptSaveTimerRef.current = setTimeout(() => {
      db.updateSession(activeEntryId, { transcript }).catch(() => {});
    }, 1500);
    return () => { if (transcriptSaveTimerRef.current) clearTimeout(transcriptSaveTimerRef.current); };
  }, [transcript, activeEntryId]);

  // ── Auto-save transcript draft ────────────────────────────────
  useEffect(() => {
    if (draftSaveRef.current) {
      clearInterval(draftSaveRef.current);
      draftSaveRef.current = null;
    }
    if (transcript.length > 10 && selectedId != null) {
      draftSaveRef.current = setInterval(() => {
        // Save to localStorage (fast, local backup)
        localStorage.setItem(`psych_draft_${doctorId}_${selectedId}`, transcript);
        // Also save to Supabase (cross-device sync)
        supabase.from("report_drafts").upsert({
          doctor_id: doctorId,
          patient_id: selectedId,
          transcript,
          updated_at: new Date().toISOString(),
        }, { onConflict: "doctor_id,patient_id" }).then(({ error }) => {
          if (error) console.warn("Draft sync failed (localStorage backup active):", error.message);
        });
      }, 30000);
    }
    return () => {
      if (draftSaveRef.current) clearInterval(draftSaveRef.current);
    };
  }, [transcript, selectedId, doctorId]);

  // ── Auto-save collateral transcript draft to localStorage ────
  // IMPORTANT: selectedId and activeEntryId are intentionally NOT in the dep
  // array. When the user switches patients/sessions, React fires effects with
  // the NEW selectedId but the OLD collateralTranscript still in state. If
  // those IDs were deps, this effect would wrongly save the departing patient's
  // collateral under the incoming patient's localStorage key, causing it to
  // bleed into every subsequent patient. We only want to persist when the
  // collateral text itself changes (i.e. the user typed something), so we read
  // selectedId/activeEntryId from the closure without listing them as triggers.
  useEffect(() => {
    if (!selectedId || !collateralTranscript) return;
    const key = `psych_collateral_draft_${doctorId}_${selectedId}_${activeEntryId ?? newSessionTokenRef.current}`;
    try { localStorage.setItem(key, collateralTranscript); } catch { /* fail silently */ }
  }, [collateralTranscript, doctorId]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Debounced collateral transcript save to Supabase ─────────
  useEffect(() => {
    if (!activeEntryId || !collateralTranscript) return;
    if (collateralSaveTimerRef.current) clearTimeout(collateralSaveTimerRef.current);
    collateralSaveTimerRef.current = setTimeout(() => {
      db.updateSession(activeEntryId, { collateralTranscript }).catch(() => {});
    }, 1500);
    return () => { if (collateralSaveTimerRef.current) clearTimeout(collateralSaveTimerRef.current); };
  }, [collateralTranscript, activeEntryId]);
  // The transcript-clear effect above always wipes the transcript first, so
  // by the time this effect fires transcript is already "".  We no longer need
  // the !transcript.trim() guard — removing it prevents a stale closure from
  // silently skipping the restore.
  useEffect(() => {
    if (!selectedId) return;
    const saved = localStorage.getItem(`psych_draft_${doctorId}_${selectedId}`);
    if (saved) {
      setTranscript(saved);
      setDraftBanner(true);
      return;
    }
    // If nothing in localStorage (new device / cleared storage), try Supabase
    void Promise.resolve(
      supabase.from("report_drafts")
        .select("transcript")
        .eq("doctor_id", doctorId)
        .eq("patient_id", selectedId)
        .maybeSingle()
    ).then(({ data }) => {
      if (data?.transcript?.trim()) {
        setTranscript(data.transcript);
        setDraftBanner(true);
        // Cache locally so next time is instant
        localStorage.setItem(`psych_draft_${doctorId}_${selectedId}`, data.transcript);
      }
    }).catch(() => {});
  }, [selectedId, doctorId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Restore collateral transcript when switching sessions ─────
  // Scoped strictly to the active entry (activeEntryId) within the selected
  // patient — mirrors the same authoritative pattern used for sessionNotes
  // above. If no collateral exists for this exact entry, the field is
  // cleared rather than left showing a previous patient's/session's text.
  useEffect(() => {
    if (!selectedId) {
      setCollateralTranscript("");
      collateralTranscriptRef.current = "";
      return;
    }
    // First check localStorage draft — scoped per patient AND per entry
    const key = `psych_collateral_draft_${doctorId}_${selectedId}_${activeEntryId ?? newSessionTokenRef.current}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      setCollateralTranscript(saved);
      collateralTranscriptRef.current = saved;
      return;
    }
    // Fall back to DB — but only the exact active entry, never "any entry
    // in this patient's history that happens to have collateral text"
    const entries = history[selectedId] ?? [];
    const activeEntry = activeEntryId ? entries.find(e => e.id === activeEntryId) : null;
    const value = activeEntry?.collateralTranscript?.trim() ? activeEntry.collateralTranscript : "";
    setCollateralTranscript(value);
    collateralTranscriptRef.current = value;
  }, [selectedId, activeEntryId, doctorId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (icdPopover && !(e.target as Element).closest(".icd-popover"))
        setIcdPopover(null);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [icdPopover]);

  // ── Derived ──────────────────────────────────────────────────
  const selectedPatient = patients.find(p => p.id === selectedId) ?? null;
  const filtered        = patients.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  const patientHistory  = selectedId ? (history[selectedId] ?? []) : [];
  const activeEntry     = patientHistory.find(e => e.id === activeEntryId) ?? null;
  const report          = activeEntry?.report ?? null;
  const isFlagged       = activeEntry ? flagged.has(activeEntry.id) : false;
  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // ── Session update helper ────────────────────────────────────
  const updateSession = useCallback(async (patientId: number, entryId: string, update: Partial<ReportEntry>) => {
    setHistory(prev => {
      const entries = (prev[patientId] ?? []).map(e => e.id === entryId ? { ...e, ...update } : e);
      return { ...prev, [patientId]: entries };
    });
    try { await db.updateSession(entryId, update); }
    catch (e) { console.error("Failed to save session:", e); }
  }, []);

  const fetchIcdSummary = useCallback(async (code: string, anchorRect: DOMRect) => {
    const isDsm = /^\d/.test(code);
    const cacheKey = `psych_${isDsm ? "dsm" : "icd"}_${code}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      setIcdPopover({ code, text: cached, loading: false, error: false });
      setIcdAnchor({ top: anchorRect.bottom + 4, left: anchorRect.left });
      return;
    }
    setIcdPopover({ code, text: "", loading: true, error: false });
    setIcdAnchor({ top: anchorRect.bottom + 4, left: anchorRect.left });
    const systemPrompt = isDsm
      ? "You are a clinical psychiatry reference trained on ICD-11, ICD-10, and DSM-5-TR. For the given DSM-5-TR numeric code provide a concise summary in exactly this format:\nCODE — Full DSM-5-TR diagnosis name\nICD-11 equivalent: [matching ICD-11 code and name]\nICD-10 equivalent: [matching ICD-10 code and name]\nKey diagnostic criteria: [2-3 bullet points, max 10 words each]\nSpecifiers: [most common specifiers in one line]\nIndia note: [DCGI availability or NDPS status if medication-relevant, else omit]\nKeep total response under 110 words."
      : "You are a clinical psychiatry reference trained on ICD-11, ICD-10, and DSM-5-TR, with India-first prescribing knowledge. For the given ICD-10 code provide a concise summary in exactly this format:\nCODE — Full ICD-10 name\nICD-11 equivalent: [matching ICD-11 code and name — note key changes from ICD-10 if any]\nDSM-5-TR equivalent: [matching DSM-5-TR code and diagnosis name]\nCategory: [diagnostic category]\nKey features: [2-3 bullet points, max 10 words each]\nIndia prescribing note: [first-line DCGI-approved drug if relevant, else omit]\nKeep total response under 110 words.";
    try {
      const result = await callChatSSE({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: code },
        ],
        taskType: "utility",
      });
      localStorage.setItem(cacheKey, result);
      setIcdPopover({ code, text: result, loading: false, error: false });
    } catch {
      setIcdPopover({ code, text: "", loading: false, error: true });
    }
  }, []);

  // ── Patient actions ──────────────────────────────────────────
  function openAddPatient() {
    setPatientDraft({ ...EMPTY_DRAFT, time: nowLabel() });
    setAddPatientOpen(true);
  }
  async function submitAddPatient() {
    if (!patientDraft.name.trim()) return;
    try {
      const newPatient = await db.createPatient({
        name:   patientDraft.name.trim(),
        age:    parseInt(patientDraft.age) || 0,
        gender: patientDraft.gender || "Unknown",
        time:   patientDraft.time.trim() || nowLabel(),
        status: patientDraft.status,
      });
      setPatients(prev => [newPatient, ...prev]);
      setAddPatientOpen(false);
      setSelectedId(newPatient.id); setActiveEntryId(null); setError(""); setTranscript("");
    } catch (e) {
      setError("Failed to add patient.");
      console.error(e);
    }
  }
  function openEditPatient() {
    if (!selectedPatient) return;
    setPatientDraft({
      name: selectedPatient.name, age: String(selectedPatient.age),
      gender: selectedPatient.gender, time: selectedPatient.time, status: selectedPatient.status,
    });
    setEditPatientOpen(true);
  }
  async function submitEditPatient() {
    if (!selectedPatient) return;
    const updated = {
      name:   patientDraft.name.trim()   || selectedPatient.name,
      age:    parseInt(patientDraft.age) || selectedPatient.age,
      gender: patientDraft.gender        || selectedPatient.gender,
      time:   patientDraft.time.trim()   || selectedPatient.time,
      status: patientDraft.status,
    };
    try {
      await db.updatePatient(selectedPatient.id, updated);
      setPatients(prev => prev.map(p => p.id !== selectedPatient.id ? p : { ...p, ...updated }));
      setEditPatientOpen(false);
    } catch (e) { console.error("Failed to edit patient:", e); showToast("⚠️ Patient record could not be updated. Check your connection.", "error"); }
  }

  // ── Medication helpers ───────────────────────────────────────
  const activeMedRecord = selectedId ? (meds[selectedId] ?? EMPTY_MED_RECORD()) : EMPTY_MED_RECORD();

  async function saveMedRecord(record: PatientMedRecord) {
    if (!selectedId) return;
    setMeds(prev => ({ ...prev, [selectedId]: record }));
    setMedModalOpen(false);
    try { await db.saveMedications(selectedId, record); }
    catch (e) { console.error("Failed to save medications:", e); showToast("⚠️ Medication record could not be saved to cloud. Check your connection and try again.", "error"); }
  }

  function openManageMeds() { setMedModalMode("manage"); setMedModalOpen(true); }

  // ── Print Rx ─────────────────────────────────────────────────
  function buildRxWindow(patientName: string, patientAge: number | undefined, patientGender: string | undefined, meds: ReturnType<typeof activeMedRecord.medications.filter>, allergies: string[]) {
    const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const medsHtml = meds.length
      ? meds.map((m, i) => `
          <tr>
            <td style="padding:6px 4px;font-size:11pt;vertical-align:top;width:24px;color:#555;">${i + 1}.</td>
            <td style="padding:6px 8px;font-size:11pt;vertical-align:top;">
              <strong style="font-size:12pt;">${m.name}</strong>
              ${m.dose ? `<span style="color:#555;"> — ${m.dose}</span>` : ""}
            </td>
            <td style="padding:6px 8px;font-size:11pt;vertical-align:top;color:#333;">${m.frequency || ""}</td>
            <td style="padding:6px 8px;font-size:10pt;vertical-align:top;color:#777;">
              ${m.endDate ? `Until ${new Date(m.endDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}
            </td>
          </tr>`).join("")
      : `<tr><td colspan="4" style="padding:16px 8px;color:#999;font-style:italic;">No active medications on record.</td></tr>`;
    const allergiesHtml = allergies.length
      ? `<div style="margin-top:16px;padding:10px 14px;background:#fff5f5;border:1px solid #fecaca;border-radius:6px;font-size:10pt;">
           <strong style="color:#b91c1c;">⚠ Allergies:</strong> ${allergies.join(", ")}
         </div>`
      : "";
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Rx — ${escapeHtml(patientName)}</title>
    <style>
      @page { margin: 16mm 20mm; }
      body { font-family: "Times New Roman", serif; font-size: 11pt; color: #111; margin: 0; line-height: 1.5; }
      .rx-header { border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 16px; }
      .rx-clinic { font-size: 14pt; font-weight: 700; }
      .rx-doctor { font-size: 11pt; color: #333; margin-top: 2px; }
      .rx-contact { font-size: 10pt; color: #555; margin-top: 1px; }
      .rx-patient-row { display: flex; justify-content: space-between; margin-bottom: 18px; padding-bottom: 8px; border-bottom: 1px dashed #aaa; }
      .rx-patient-label { font-size: 10pt; color: #666; }
      .rx-patient-value { font-size: 12pt; font-weight: 600; }
      .rx-symbol { font-size: 30pt; font-weight: 900; color: #111; margin-bottom: 8px; }
      .rx-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
      .rx-footer { margin-top: 32px; display: flex; justify-content: space-between; align-items: flex-end; }
      .rx-sig-line { border-top: 1px solid #111; padding-top: 6px; font-size: 10pt; color: #555; min-width: 180px; text-align: center; }
      .rx-date { font-size: 10pt; color: #555; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style></head><body>
    <div class="rx-header">
      ${doctor.clinic ? `<div class="rx-clinic">${escapeHtml(doctor.clinic)}</div>` : ""}
      <div class="rx-doctor">${escapeHtml(doctor.name)}${doctor.specialty ? ` — ${escapeHtml(doctor.specialty)}` : ""}</div>
      ${doctor.contact ? `<div class="rx-contact">📞 ${escapeHtml(doctor.contact)}</div>` : ""}
    </div>
    <div class="rx-patient-row">
      <div>
        <div class="rx-patient-label">Patient</div>
        <div class="rx-patient-value">${escapeHtml(patientName)}</div>
        <div style="font-size:10pt;color:#555;">${patientAge !== undefined ? `${patientAge} y/o` : ""}${patientGender ? ` · ${patientGender}` : ""}</div>
      </div>
      <div style="text-align:right;">
        <div class="rx-patient-label">Date</div>
        <div class="rx-patient-value" style="font-size:11pt;">${today}</div>
      </div>
    </div>
    <div class="rx-symbol">℞</div>
    <table class="rx-table">${medsHtml}</table>
    ${allergiesHtml}
    <div class="rx-footer">
      <div class="rx-date">Date: ${today}</div>
      <div class="rx-sig-line">Doctor's Signature</div>
    </div>
    <script>window.onload = function() { window.print(); }<\/script>
    </body></html>`);
    w.document.close();
  }

  function printRx() {
    if (!selectedPatient) return;
    buildRxWindow(
      selectedPatient.name,
      selectedPatient.age,
      selectedPatient.gender,
      activeMedRecord.medications.filter(m => m.status === "active"),
      activeMedRecord.allergies,
    );
  }

  function printIndividualRx(med: import("./types").Medication) {
    if (!selectedPatient) return;
    buildRxWindow(
      selectedPatient.name,
      selectedPatient.age,
      selectedPatient.gender,
      [med],
      activeMedRecord.allergies,
    );
  }

  // ── Appointments ─────────────────────────────────────────────
  function openAddAppointment() {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    setApptDraft({ date: today, time: `${hh}:${mm}`, notes: "" });
    setApptModalOpen(true);
  }
  function submitAddAppointment() {
    if (!selectedPatient || !apptDraft.date || !apptDraft.time) return;
    if (editingApptId) {
      const updated: Appointment = { id: editingApptId, patientId: selectedPatient.id, date: apptDraft.date, time: apptDraft.time, notes: apptDraft.notes };
      setAppointments(prev => prev.map(a => a.id === editingApptId ? updated : a));
      setApptModalOpen(false);
      setEditingApptId(null);
      db.saveAppointment(updated).catch(e => { console.error("Failed to update appointment:", e); showToast("⚠️ Appointment saved locally but could not sync to cloud. Check your connection.", "error"); });
    } else {
      const newAppt: Appointment = { id: crypto.randomUUID(), patientId: selectedPatient.id, date: apptDraft.date, time: apptDraft.time, notes: apptDraft.notes };
      setAppointments(prev => [...prev, newAppt]);
      setApptModalOpen(false);
      db.saveAppointment(newAppt).catch(e => { console.error("Failed to save appointment:", e); showToast("⚠️ Appointment saved locally but could not sync to cloud. Check your connection.", "error"); });
    }
  }
  function deleteAppointment(id: string) {
    setAppointments(prev => prev.filter(a => a.id !== id));
    db.deleteAppointmentFromDb(id).catch(e => { console.error("Failed to delete appointment:", e); showToast("⚠️ Could not delete appointment from cloud. Check your connection.", "error"); });
  }
  function dismissReminder() {
    setReminderDismissed(true);
    sessionStorage.setItem(`psych_reminder_dismissed_${todayStr}`, "1");
  }

  // ── Follow-up auto-scheduling ─────────────────────────────────
  function parseFollowUpDays(rawText: string): number | null {
    const planSection =
      rawText.match(/\*\*P\s*[-–]\s*Plan\*\*[\s\S]*?(?=\n#{1,3}\s+\d+\.|$)/i)?.[0] ??
      rawText.match(/\*\*Plan\*\*[\s\S]*?(?=\n#{1,3}\s+\d+\.|$)/i)?.[0] ??
      rawText.match(/Plan[\s\S]{0,2000}/i)?.[0] ??
      rawText;

    const text = planSection.toLowerCase();
    const contextWords = `follow.?up|return|review|see\\s+(?:again|patient)|come\\s+back|next\\s+(?:appointment|visit|session)|schedule`;
    const units = `day|days|week|weeks|fortnight|fortnights|month|months`;

    const primary = new RegExp(
      `(?:${contextWords})\\s+(?:in\\s+)?(\\d+)\\s+(${units})`, "i"
    );
    const nextUnit = new RegExp(
      `(?:${contextWords})\\s+next\\s+(week|month)`, "i"
    );
    const lineUnit = new RegExp(
      `\\bin\\s+(\\d+)\\s+(${units})\\b`, "i"
    );

    const calc = (n: number, unit: string): number => {
      if (/day/.test(unit))       return n;
      if (/week/.test(unit))      return n * 7;
      if (/fortnight/.test(unit)) return n * 14;
      return n * 30;
    };

    let m = text.match(primary);
    if (m) return calc(parseInt(m[1]), m[2]);

    m = text.match(nextUnit);
    if (m) return m[1] === "week" ? 7 : 30;

    for (const line of text.split("\n")) {
      if (!new RegExp(contextWords, "i").test(line)) continue;
      const lm = line.match(lineUnit);
      if (lm) return calc(parseInt(lm[1]), lm[2]);
    }
    return null;
  }

  async function autoScheduleFollowUp(rawText: string, patId: number, patient: import("./types").Patient) {
    const days = parseFollowUpDays(rawText);
    if (days === null) return;

    const base = new Date();
    base.setDate(base.getDate() + days);
    const dateStr = base.toISOString().slice(0, 10);

    const sessionTime = patient.time || (() => {
      const now = new Date();
      return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    })();

    const draft = { date: dateStr, time: sessionTime, notes: "Follow-up from session report" };
    const friendly = base.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    setFollowUpToast({ msg: `Follow-up detected: ${friendly} — Save this appointment?`, draft });
    if (followUpToastTimerRef.current) clearTimeout(followUpToastTimerRef.current);
    followUpToastTimerRef.current = setTimeout(() => setFollowUpToast(null), 30000);
  }

  async function extractMedications(rawText: string, entryId: string, patId: number) {
    if (!patId) return;
    const safeText = stripPatientPII(rawText, selectedPatient?.name ?? "");
    try {
      const raw = await callLLMWithFallback(
        [
          { role: "system", content: `You extract medication prescriptions from psychiatric clinical notes. Return ONLY a valid JSON array — no explanation, no markdown, no other text. Format: [{"name":"drug name","dose":"e.g. 20mg","frequency":"e.g. once daily"}]. If no medications are mentioned or prescribed, return: []` },
          { role: "user", content: safeText },
        ],
        () => showToast("Switched to backup service"),
        { countable: false },
      );
      // Strip markdown fences, extract JSON array even if wrapped in extra text
      let cleaned = raw.replace(/```json|```/g, "").trim();
      const jsonMatch = cleaned.match(/\[\s*[\s\S]*?\]/);
      if (jsonMatch) cleaned = jsonMatch[0];
      const parsed = JSON.parse(cleaned) as { name?: string; dose?: string; frequency?: string }[];
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const drafts: MedDraft[] = parsed
        .filter(m => m.name?.trim())
        .map(m => ({ name: m.name!.trim(), dose: m.dose?.trim() ?? "", frequency: m.frequency?.trim() ?? "", include: true }));
      if (drafts.length === 0) return;
      setMedDrafts(drafts);
      setMedModalMode("review");
      setMedModalOpen(true);
      void entryId;
    } catch { /* silent */ }
  }

  // ── Export helpers ───────────────────────────────────────────
  function exportReport() {
    if (!activeEntry || !selectedPatient) return;
    const bodyHtml = activeEntry.editedHtml
      ? activeEntry.editedHtml
      : DOMPurify.sanitize(markedSync(activeEntry.rawText ?? ""));
    const style = `<style>
      @page{margin:18mm;}
      body{font-family:Calibri,sans-serif;font-size:11pt;color:#111;line-height:1.6;margin:0;}
      h1,h2,h3{color:#0d5c3a;margin-top:16pt;margin-bottom:4pt;}
      h1{font-size:14pt;} h2{font-size:12pt;} h3{font-size:11pt;}
      p{margin:0 0 8pt;}
      table{border-collapse:collapse;width:100%;margin-bottom:12pt;}
      th{background:#e8f5f0;padding:6px 10px;text-align:left;border:1px solid #ccc;font-size:10pt;}
      td{padding:6px 10px;border:1px solid #ccc;font-size:10pt;vertical-align:top;}
      strong{color:#0d5c3a;}
      ul,ol{margin-left:20px;padding-left:0;margin-bottom:8pt;}
      li{margin-bottom:3pt;}
      hr{border:none;border-top:1px solid #ddd;margin:14pt 0;}
      .report-header{border-bottom:1px solid #ccc;padding-bottom:10pt;margin-bottom:14pt;}
      .report-doctor-name{font-size:13pt;font-weight:700;color:#0d5c3a;}
      .report-meta{font-size:9.5pt;color:#666;margin-top:3pt;}
    </style>`;
    const header = `<div class="report-header">
      <div class="report-doctor-name">${escapeHtml(doctor.name)}${doctor.specialty ? ` — ${escapeHtml(doctor.specialty)}` : ""}</div>
      <div class="report-meta">${doctor.clinic ? escapeHtml(doctor.clinic) + " &nbsp;|&nbsp; " : ""}Patient: <strong>${escapeHtml(selectedPatient.name)}</strong> &nbsp;|&nbsp; Date: ${activeEntry.date.slice(0, 10)}</div>
    </div>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report — ${escapeHtml(selectedPatient.name)}</title>${style}</head><body>${header}${bodyHtml}<script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  async function exportImage() {
    if (!activeEntry || !selectedPatient) return;
    const el = document.querySelector<HTMLElement>(".report-wrap");
    if (!el) return;
    const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: "#0d0d0f" });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `report-${selectedPatient.name.replace(/\s+/g, "-")}-${activeEntry.date.slice(0, 10)}.png`;
    a.click();
  }

  async function exportWord() {
    if (!activeEntry || !selectedPatient) return;
    try {
      const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");

      const rawText = activeEntry.rawText ?? "";
      const lines = rawText.split("\n");

      const children: InstanceType<typeof Paragraph>[] = [];

      // Clinical letterhead
      children.push(
        new Paragraph({
          children: [new TextRun({ text: doctor.name || "Dr.", bold: true, size: 28, color: "0D5C3A" })],
        }),
        new Paragraph({
          children: [new TextRun({ text: `${doctor.specialty || "Psychiatry"}${doctor.clinic ? " — " + doctor.clinic : ""}`, size: 20, color: "666666" })],
        }),
        new Paragraph({
          children: [new TextRun({ text: `Patient: ${selectedPatient.name}   |   Date: ${activeEntry.date.slice(0, 10)}`, size: 18, color: "666666" })],
        }),
        new Paragraph({ children: [new TextRun({ text: "" })] })
      );

      // Parse markdown lines into docx paragraphs
      for (const line of lines) {
        if (line.startsWith("## ")) {
          children.push(new Paragraph({
            text: line.replace(/^## /, ""),
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 240, after: 80 },
          }));
        } else if (line.startsWith("### ")) {
          children.push(new Paragraph({
            text: line.replace(/^### /, ""),
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 160, after: 60 },
          }));
        } else if (line.startsWith("**") && line.endsWith("**")) {
          children.push(new Paragraph({
            children: [new TextRun({ text: line.replace(/\*\*/g, ""), bold: true, size: 22 })],
          }));
        } else if (line.startsWith("- ") || line.startsWith("* ")) {
          children.push(new Paragraph({
            text: line.replace(/^[-*] /, ""),
            bullet: { level: 0 },
          }));
        } else if (line.trim() === "" || line.startsWith("---")) {
          children.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
        } else {
          // Inline bold: **text**
          const parts = line.split(/(\*\*[^*]+\*\*)/g);
          const runs = parts.map(part => {
            if (part.startsWith("**") && part.endsWith("**")) {
              return new TextRun({ text: part.replace(/\*\*/g, ""), bold: true, size: 20 });
            }
            return new TextRun({ text: part, size: 20 });
          });
          children.push(new Paragraph({ children: runs }));
        }
      }

      const doc = new Document({
        sections: [{
          properties: {
            page: {
              margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
            },
          },
          children,
        }],
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `report-${selectedPatient.name.replace(/\s+/g, "-")}-${activeEntry.date.slice(0, 10)}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      // Fallback to legacy Blob method if docx import fails
      console.warn("[exportWord] docx library failed, falling back to legacy export:", err);
      const bodyHtml = activeEntry.editedHtml
        ? activeEntry.editedHtml
        : DOMPurify.sanitize(markedSync(activeEntry.rawText ?? ""));
      const style = `<style>body{font-family:Calibri,sans-serif;font-size:11pt;}</style>`;
      const header = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'>${style}</head><body>`;
      const blob = new Blob([header + bodyHtml + `</body></html>`], { type: "application/msword" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `report-${selectedPatient.name.replace(/\s+/g, "-")}-${activeEntry.date.slice(0, 10)}.doc`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  function printReport() { window.print(); }

  function printPatientConsent() {
    const doctorName = doctor.name  || "Your Doctor";
    const clinicName = doctor.clinic || "This Clinic";
    const style = `
      <style>
        body { font-family: Arial, sans-serif; font-size: 13px; color: #111; max-width: 680px; margin: 40px auto; line-height: 1.7; }
        h1 { font-size: 18px; margin-bottom: 4px; }
        h2 { font-size: 14px; margin-top: 24px; margin-bottom: 6px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
        .subtitle { font-size: 12px; color: #555; margin-bottom: 24px; }
        ul { padding-left: 20px; } li { margin-bottom: 4px; }
        .sign-row { display: flex; gap: 40px; margin-top: 48px; }
        .sign-block { flex: 1; border-top: 1px solid #333; padding-top: 8px; font-size: 12px; color: #444; }
        @media print { body { margin: 20px; } }
      </style>
    `;
    const body = `
      <h1>Patient Data Consent Form</h1>
      <p class="subtitle">${clinicName} · Dr. ${doctorName} · Date: ${new Date().toLocaleDateString("en-IN")}</p>

      <h2>What information will be collected</h2>
      <ul>
        <li>Audio recording of this consultation session (voice only)</li>
        <li>Smart clinical summary and session transcript</li>
        <li>Medication records and prescription details</li>
        <li>Psychiatric assessment scores (PHQ-9, GAD-7, C-SSRS if applicable)</li>
      </ul>

      <h2>Consent to record this session / सत्र रिकॉर्ड करने की सहमति</h2>
      <p>
        I understand that this consultation session will be <strong>audio-recorded</strong> using
        an AI-assisted documentation tool, solely to help my doctor prepare clinical notes.
        The recording is processed automatically and is <strong>not stored</strong> after the
        notes are generated. I may ask my doctor to pause or stop the recording at any time,
        and I may withdraw this consent without affecting my care.
      </p>
      <p style="margin-top: 6px;">
        मैं समझता/समझती हूँ कि यह सत्र मेरे डॉक्टर को क्लिनिकल नोट्स तैयार करने में मदद के लिए
        <strong> AI-सहायता प्राप्त रिकॉर्डिंग टूल</strong> से <strong>ऑडियो रिकॉर्ड</strong> किया जाएगा।
        रिकॉर्डिंग को स्वचालित रूप से संसाधित किया जाता है और नोट्स तैयार होने के बाद
        <strong> संग्रहीत (store) नहीं</strong> किया जाता। मैं किसी भी समय रिकॉर्डिंग रोकने का अनुरोध
        कर सकता/सकती हूँ, और बिना अपनी देखभाल पर प्रभाव डाले इस सहमति को वापस ले सकता/सकती हूँ।
      </p>

      <h2>How your information will be used</h2>
      <ul>
        <li>To generate a structured clinical report for your medical record</li>
        <li>To track your treatment progress over time</li>
        <li>Audio is automatically deleted after transcription — it is not stored</li>
        <li>Your name and identifiers are removed before any data is processed by our services</li>
      </ul>

      <h2>Third-party processing</h2>
      <p>Session audio and anonymised transcript text may be processed by our services
      (for transcription and report generation)
      over encrypted connections. No identifiable patient data
      is transmitted. Reports are stored in an encrypted cloud database accessible only to
      your treating doctor.</p>

      <h2>Your rights under DPDP Act 2023</h2>
      <ul>
        <li>Right to access: You may request a copy of your records at any time</li>
        <li>Right to correction: You may request correction of inaccurate data</li>
        <li>Right to erasure: You may withdraw consent — your records will be deleted within 30 days</li>
        <li>Right to grievance redressal: Contact your doctor directly for any data concerns</li>
      </ul>

      <div class="sign-row">
        <div class="sign-block">Patient signature &amp; date</div>
        <div class="sign-block">Doctor / witness signature &amp; date</div>
      </div>
    `;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">${style}</head><body>${body}<script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  // ── Export full patient history as PDF ───────────────────────
  function exportFullHistory() {
    if (!selectedPatient) return;
    const sessions = [...patientHistory].sort((a, b) => a.date.localeCompare(b.date));
    const style = `<style>
      @page { margin: 18mm; }
      body { font-family: Calibri, sans-serif; font-size: 11pt; color: #111; line-height: 1.65; margin: 0; }
      h1 { font-size: 17pt; color: #0d5c3a; margin: 0 0 6pt; }
      h2, h3 { color: #0d5c3a; margin-top: 14pt; margin-bottom: 4pt; }
      h2 { font-size: 12pt; } h3 { font-size: 11pt; }
      p { margin: 0 0 7pt; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 12pt; }
      th { background: #e8f5f0; padding: 6px 10px; text-align: left; border: 1px solid #ccc; font-size: 10pt; }
      td { padding: 6px 10px; border: 1px solid #ccc; font-size: 10pt; vertical-align: top; }
      strong { color: #0d5c3a; }
      ul, ol { margin-left: 20px; padding-left: 0; margin-bottom: 8pt; }
      li { margin-bottom: 3pt; }
      hr { border: none; border-top: 1px solid #ddd; margin: 14pt 0; }
      .doc-header { border-bottom: 2px solid #0d5c3a; padding-bottom: 12pt; margin-bottom: 18pt; }
      .doc-title { font-size: 19pt; font-weight: 700; color: #0d5c3a; margin-bottom: 6pt; }
      .doc-meta { font-size: 10pt; color: #555; line-height: 1.7; }
      .summary-bar { display: flex; gap: 24px; margin-bottom: 14pt; }
      .summary-item { background: #f0faf5; border: 1px solid #c6e8d9; border-radius: 6px; padding: 8px 16px; font-size: 10.5pt; }
      .summary-label { font-size: 9pt; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
      .summary-value { font-weight: 700; color: #0d5c3a; font-size: 14pt; }
      .session-block { margin-bottom: 0; }
      .session-header { background: #f0faf5; border-left: 4px solid #0d5c3a; padding: 9px 14px; margin-bottom: 10pt; border-radius: 0 5px 5px 0; }
      .session-date { font-size: 12pt; font-weight: 700; color: #0d5c3a; }
      .scales-row { display: flex; gap: 12px; flex-wrap: wrap; margin: 7pt 0 10pt; }
      .scale-pill { padding: 4px 12px; border-radius: 5px; font-size: 10pt; background: #f0faf5; border: 1px solid #c6e8d9; font-weight: 600; color: #1a5c3a; }
      .notes-box { background: #fffbeb; border: 1px solid #fbbf24; border-radius: 5px; padding: 9px 13px; margin-bottom: 10pt; font-size: 10pt; color: #78350f; }
      .notes-box strong { color: #92400e; }
      .session-report { margin-top: 6pt; }
      .empty-session { color: #999; font-style: italic; font-size: 10pt; }
      .page-break { page-break-before: always; padding-top: 4pt; }
      .flagged-badge { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; border-radius: 4px; padding: 2px 8px; font-size: 9.5pt; font-weight: 700; margin-left: 8px; }
    </style>`;

    const patAge = selectedPatient.age ? ` | Age: ${selectedPatient.age}` : "";
    const patGender = selectedPatient.gender ? ` | Gender: ${selectedPatient.gender}` : "";
    const drLine = `${doctor.name}${doctor.specialty ? ` — ${doctor.specialty}` : ""}${doctor.clinic ? ` | ${doctor.clinic}` : ""}`;
    const dateNow = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

    const header = `<div class="doc-header">
      <div class="doc-title">Patient History Report</div>
      <div class="doc-meta">
        <strong>Patient:</strong> ${selectedPatient.name}${patAge}${patGender}<br>
        <strong>Clinician:</strong> ${drLine}<br>
        <strong>Report generated:</strong> ${dateNow} &nbsp;|&nbsp; <strong>Total sessions:</strong> ${sessions.length}
      </div>
    </div>`;

    let body = "";
    sessions.forEach((entry, idx) => {
      const reportHtml = entry.editedHtml
        ? entry.editedHtml
        : entry.rawText
        ? DOMPurify.sanitize(markedSync(entry.rawText))
        : "";

      const scalesHtml = entry.scaleScores?.filter(s => s.score !== null).length
        ? `<div class="scales-row">${entry.scaleScores!.filter(s => s.score !== null).map(s => `<span class="scale-pill">${s.scale}: <strong>${s.score}</strong>${s.severity ? ` — ${s.severity}` : ""}</span>`).join("")}</div>`
        : "";

      const notesHtml = entry.notes
        ? `<div class="notes-box"><strong>Session notes:</strong> ${entry.notes}</div>`
        : "";

      const flagBadge = (entry as any).flagged
        ? `<span class="flagged-badge">⚑ FLAGGED</span>`
        : "";

      body += `
        ${idx > 0 ? '<div class="page-break"></div>' : ""}
        <div class="session-block">
          <div class="session-header">
            <div class="session-date">Session ${idx + 1} &mdash; ${entry.date.slice(0, 10)}${flagBadge}</div>
          </div>
          ${scalesHtml}
          ${notesHtml}
          <div class="session-report">
            ${reportHtml || '<p class="empty-session">No report generated for this session.</p>'}
          </div>
        </div>`;
    });

    if (sessions.length === 0) {
      body = '<p style="color:#999;font-style:italic;">No sessions found for this patient.</p>';
    }

    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Patient History — ${escapeHtml(selectedPatient.name)}</title>${style}</head><body>${header}${body}<script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  // ── Patient document generation ──────────────────────────────
  async function generatePatientDoc(rawText: string, entryId: string, patient: Patient, force = false) {
    if (!force) {
      const existing = (history[patient.id] ?? []).find(e => e.id === entryId);
      if (existing?.patientDocMd) return;
    }
    setPatientDocLoading(true);
    try {
      const safeRawText = stripPatientPII(rawText, patient.name);

      // Look up the next real appointment from the database — never generate or infer one
      const todayIso = new Date().toISOString().slice(0, 10);
      const nextAppt = appointments
        .filter(a => a.patientId === patient.id && a.date >= todayIso)
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      const apptInfo = nextAppt
        ? `${nextAppt.date}${nextAppt.time ? ` at ${nextAppt.time}` : ""}${nextAppt.notes ? ` (${nextAppt.notes})` : ""}`
        : null;

      const prompt = `STRICT RULES:
* Do NOT add any disclaimer, legal notice, or "this is not medical advice" text anywhere in the letter.
* Do NOT add any appointment, follow-up date, or "when to come back" section unless explicit appointment data is provided at the bottom of this prompt. If none is provided, that section must not exist at all.
* Do NOT recommend the patient schedule an appointment unless the doctor explicitly discussed further appointments in the session. The "What to do" section should only reflect what was actually discussed.
* Be consistent: same clinical facts = same letter structure every time.

Generate a patient-friendly summary letter for the patient based on this psychiatric clinical report.

Write in simple, warm, non-medical language. No ICD codes. No jargon. Be empathetic and reassuring.

CRITICAL INSTRUCTION: Do NOT include any next appointment date, follow-up timing, or "When to come back" section unless explicit appointment data is provided at the bottom of this prompt. If no appointment data is provided, completely omit that section. Never generate, infer, or guess an appointment date from the clinical text.

Use this exact markdown structure:

## What we discussed today
2-3 plain sentences summarizing the main concerns in simple language.

## What is happening
Explain the diagnosis simply. Example: instead of "Major Depressive Disorder F32.1" say "You have been experiencing a period of deep sadness and low energy that is making it hard to function — this is a recognized illness and it is very treatable." Never write ICD codes or DSM codes in this section.

## Your medicines
List each prescribed medicine as a bullet point:
• **Medicine name** — what it does in plain terms — Take: when/how often — Watch for: 1-2 common side effects to report
If no new medicines were prescribed, write: No new medicines were prescribed in today's session.

## What to do
3-4 simple, specific action points as bullet points.
${apptInfo ? `\n## When to come back\nYour next appointment is scheduled for: ${apptInfo}` : ""}

## When to call us immediately
3-5 clear warning signs as bullet points. Make them easy to understand.

${apptInfo ? `Appointment data (include this in "When to come back"): ${apptInfo}` : "No appointment data provided — omit the 'When to come back' section entirely."}

Clinical Report:
<transcript>
${safeRawText}
</transcript>`;

      const md = await callLLMWithFallback(
        [
          { role: "system", content: "You are a clinical communication specialist who writes clear, empathetic patient letters. Write only the letter content, no preamble." },
          { role: "user", content: prompt },
        ],
        () => showToast("Switched to backup service"),
      );
      if (!md.trim()) return;
      await updateSession(patient.id, entryId, { patientDocMd: md });
    } catch { /* silent */ }
    finally { setPatientDocLoading(false); }
  }

  const LANG_NAMES: Record<Exclude<DocLang, "en">, string> = {
    hi: "Hindi in Devanagari script",
    mr: "Marathi in Devanagari script",
    bn: "Bengali in Bengali script",
    ta: "Tamil in Tamil script",
    te: "Telugu in Telugu script",
  };

  const TRANSLATION_FIELD: Record<Exclude<DocLang, "en">, keyof ReportEntry> = {
    hi: "patientDocHindiMd",
    mr: "patientDocMarathiMd",
    bn: "patientDocBengaliMd",
    ta: "patientDocTamilMd",
    te: "patientDocTeluguMd",
  };

  async function generateTranslation(lang: Exclude<DocLang, "en">, entryId: string, englishMd: string) {
    if (!selectedId) return;
    setTranslationLoadingLang(lang);
    const patId = selectedId;
    const langName = LANG_NAMES[lang];
    try {
      const translated = await callLLMWithFallback(
        [
          { role: "system", content: `You translate patient health letters into simple, conversational ${langName}. Keep the same markdown structure (## headings, bullet points). Make it warm and easy to understand for any patient in India.` },
          { role: "user", content: `Translate the following patient letter to ${langName}:\n\n${englishMd}` },
        ],
        () => showToast("Switched to backup service"),
        { taskType: "translation" },
      );
      if (!translated.trim()) return;
      await updateSession(patId, entryId, { [TRANSLATION_FIELD[lang]]: translated });
    } catch { /* silent */ }
    finally { setTranslationLoadingLang(null); }
  }

  function handleSetPatientDocLang(lang: DocLang) {
    setPatientDocLang(lang);
    if (lang !== "en" && activeEntry && !activeEntry[TRANSLATION_FIELD[lang]] && translationLoadingLang !== lang) {
      void generateTranslation(lang, activeEntry.id, activeEntry.patientDocMd ?? "");
    }
  }

  async function savePatientDocEdits(html: string, lang: DocLang) {
    if (!selectedId || !activeEntryId) return;
    const editFields: Partial<Record<DocLang, string>> = {
      en: "patientDocEditedHtmlEn",
      hi: "patientDocEditedHtmlHi",
    };
    const field = editFields[lang];
    if (!field) return;
    await updateSession(selectedId, activeEntryId, { [field]: html });
  }

  // ── Save edits ───────────────────────────────────────────────
  async function saveEdits(html: string) {
    if (!selectedId || !activeEntryId) return;
    const reviewedAt = new Date().toISOString();
    await updateSession(selectedId, activeEntryId, { editedHtml: html, editedAt: reviewedAt, reviewConfirmedAt: reviewedAt });
    setEditMode(false);
    // Log clinician's "reviewed and take clinical responsibility" confirmation
    try {
      const token = await getAuthToken();
      void fetch("/api/report-review", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ sessionId: selectedId, entryId: activeEntryId }),
      });
    } catch { /* best-effort — does not block save */ }
  }

  // ── Notes save (debounced) ───────────────────────────────────
  function handleNotesChange(text: string) {
    setSessionNotes(text);
    if (!selectedId || !activeEntryId) return;
    setHistory(prev => {
      const entries = (prev[selectedId] ?? []).map(e => e.id === activeEntryId ? { ...e, notes: text } : e);
      return { ...prev, [selectedId]: entries };
    });
    if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
    notesSaveTimer.current = setTimeout(async () => {
      try { await db.updateSession(activeEntryId, { notes: text }); }
      catch (e) { console.error("Failed to save notes:", e); showToast("⚠️ Session notes could not be saved. Check your connection.", "error"); }
    }, 1000);
  }

  // ── Cancel recording (no API call, no transcript) ────────────
  function cancelRecording() {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") return;
    // Increment generation so onstop's transcribeAudio call exits immediately
    sessionGenRef.current += 1;
    intentionalStopRef.current = true;
    // Clear chunks BEFORE stop — onstop assembles an empty blob, generation guard drops it
    audioChunksRef.current = [];
    mediaRecorderRef.current.stop();
    if (chunkTimerRef.current) { clearInterval(chunkTimerRef.current); chunkTimerRef.current = null; }
    recordedDurationRef.current = 0;
    lastChunkElapsedRef.current = 0;
    headerSeedRef.current = null;
    setRecording(false);
    setElapsed(0);
    try { wakeLockRef.current?.release(); } catch { /* fail silently */ }
    wakeLockRef.current = null;
    showToast("Recording cancelled — no audio was sent.", "error");
  }

  // ── Cancel in-flight transcription ───────────────────────────
  function cancelTranscription() {
    if (transcribeAbortRef.current) {
      transcribeAbortRef.current.abort();
      transcribeAbortRef.current = null;
    }
    setTranscribing(false);
    showToast("Transcription cancelled.", "error");
  }

  // ══════════════════════════════════════════════════════════════
  // COLLATERAL / FAMILY INTERVIEW RECORDING
  // Uses its own separate MediaRecorder, refs, and state — never
  // shares anything with the patient recording path.
  // ══════════════════════════════════════════════════════════════
  const collateralMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const collateralChunksRef        = useRef<Blob[]>([]);
  const collateralAbortRef         = useRef<AbortController | null>(null);
  const collateralTimerRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const collateralDurationRef      = useRef(0);
  const collateralHeaderSeedRef    = useRef<Blob | null>(null);
  const collateralAudioCtxRef      = useRef<AudioContext | null>(null);
  const collateralAnalyserRef      = useRef<AnalyserNode | null>(null);
  const collateralAnimFrameRef     = useRef<number | null>(null);
  const collateralSilentRef        = useRef(0);

  async function transcribeCollateralAudio(
    audioBlob: Blob,
    recordedSecs: number,
    recordingPatientId: number | null,
    recordingEntryId: string | null,
    recordingGen: number,
  ): Promise<void> {
    if (recordedSecs < 1) {
      showToast("Collateral recording too short — please hold the mic button for at least a second.", "error");
      return;
    }
    if (audioBlob.size < 3000) {
      showToast("Collateral recording appears empty — please check your microphone and try again.", "error");
      return;
    }
    if (recordedSecs >= 5 && audioBlob.size < recordedSecs * 1000) {
      showToast(
        `Microphone not capturing audio — ${recordedSecs}s collateral recording is only ${Math.round(audioBlob.size / 1024)}KB.`,
        "error",
      );
      return;
    }

    setCollateralTranscribing(true);
    const abortCtrl = new AbortController();
    collateralAbortRef.current = abortCtrl;
    try {
      const mimeType = audioBlob.type || "audio/webm";
      const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mp4") ? "mp4" : "ogg";
      let blobRef: Blob | null = audioBlob;
      const file = new File([blobRef], `collateral.${ext}`, { type: mimeType });
      blobRef = null;

      // Same retry loop as patient transcribeAudio: up to 3 attempts with backoff.
      // callTranscribeWithFallback hits the same Gemini key pool (keys 1-8) → Groq → OpenAI.
      // We pass role=collateral so the server uses Family: labels instead of Patient:.
      const MAX_RETRIES = 3;
      let rawText = "";
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (abortCtrl.signal.aborted) return;
        try {
          const token = await getAuthToken();
          const form = new FormData();
          form.append("file", file);
          const res = await fetch("/api/ai/transcribe?role=collateral", {
            method: "POST",
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: form,
            signal: abortCtrl.signal,
          });
          if (!res.ok) {
            let errMsg = "Collateral transcription service temporarily unavailable — please try again in a moment.";
            try {
              const parsed = JSON.parse(await res.text()) as { message?: string };
              if (parsed.message) errMsg = parsed.message;
            } catch { /* use default */ }
            throw new Error(errMsg);
          }
          const data = await res.json() as { transcript?: string };
          if (!data.transcript) throw new Error("Collateral transcription returned empty — please try again or type manually.");
          rawText = data.transcript.trim();
          break; // success — exit retry loop
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") return;
          if (attempt === MAX_RETRIES) throw err;
          const waitSecs = attempt * 4; // 4s then 8s
          showToast(`Collateral transcription attempt ${attempt} failed — retrying in ${waitSecs}s…`, "error");
          await new Promise<void>(r => setTimeout(r, waitSecs * 1000));
          if (abortCtrl.signal.aborted) return;
        }
      }
      if (!rawText) return;

      // Diarize: label speakers as Doctor / Family
      const doctorLabel = doctor.name || "Doctor";
      const familyLabel = "Family";
      let labelled = rawText;
      try {
        labelled = await callLLMWithFallback(
          [
            {
              role: "system",
              content: `You are a medical transcription formatter. Add speaker labels to a collateral/family interview transcript.\n\nOUTPUT FORMAT — one line per speaker turn, no timestamps:\n${doctorLabel}: [exact words]\n${familyLabel}: [exact words]\n\nRULES:\n1. Every line MUST start with "${doctorLabel}:" or "${familyLabel}:" — do NOT add timestamps, time markers, or any [MM:SS]-style prefix.\n2. ${doctorLabel} = the psychiatrist asking questions\n3. ${familyLabel} = the patient's family member or informant providing history\n4. Copy words exactly. Do NOT paraphrase or omit.\n5. Preserve any non-verbal annotations exactly as given, without altering or re-estimating them: [pause], [long pause], [laughs], [sighs], [voice break], [quietly], [crying].\n6. No preamble, headers, or extra text.`,
            },
            {
              role: "user",
              content: `Add "${doctorLabel}:" or "${familyLabel}:" labels to every speaker turn. Do NOT add timestamps. Output ONLY labelled lines:\n\n${rawText}`,
            },
          ],
          () => showToast("Switched to backup service"),
        );
        const hasLabels =
          labelled.includes(`${doctorLabel}:`) ||
          labelled.includes("Doctor:") ||
          labelled.includes("doctor:") ||
          labelled.includes(`${familyLabel}:`);
        labelled = hasLabels ? labelled.trim() : rawText;
      } catch {
        labelled = rawText;
      }

      if (
        recordingPatientId !== selectedIdRef.current ||
        recordingEntryId !== activeEntryIdRef.current ||
        recordingGen !== sessionGenRef.current
      ) {
        return;
      }
      const durLabel = `[Collateral Recording: ${fmtTime(recordedSecs)}]`;
      const current = collateralTranscriptRef.current;
      const newText = current ? current + "\n\n" + durLabel + "\n" + labelled : durLabel + "\n" + labelled;
      collateralTranscriptRef.current = newText;
      setCollateralTranscript(newText);
      showToast("✅ Collateral interview transcribed.", "success");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      showToast("⚠️ Collateral transcription failed — you can type the interview notes manually.", "error");
    } finally {
      collateralAbortRef.current = null;
      setCollateralTranscribing(false);
    }
  }

  async function toggleCollateralRecording() {
    if (collateralRecording) {
      // Stop
      collateralDurationRef.current = Math.max(1, collateralElapsed);
      if (collateralTimerRef.current) { clearInterval(collateralTimerRef.current); collateralTimerRef.current = null; }
      collateralMediaRecorderRef.current?.stop();
      setCollateralRecording(false);
      showToast("Processing collateral recording…");
    } else {
      // Start
      setCollateralElapsed(0);
      collateralDurationRef.current = 0;
      collateralSilentRef.current = 0;
      setCollateralSilentFrames(0);
      setCollateralAudioLevel(0);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        // Audio level monitoring
        try {
          const ctx = new AudioContext();
          collateralAudioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          collateralAnalyserRef.current = analyser;
          const buf = new Uint8Array(analyser.frequencyBinCount);
          let silCount = 0;
          const tick = () => {
            collateralAnimFrameRef.current = requestAnimationFrame(tick);
            analyser.getByteFrequencyData(buf);
            const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
            setCollateralAudioLevel(avg / 255);
            if (avg < 5) { silCount++; } else { silCount = 0; }
            collateralSilentRef.current = silCount;
            setCollateralSilentFrames(silCount);
          };
          tick();
        } catch { /* level monitoring optional */ }

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/ogg";

        collateralChunksRef.current = [];
        collateralHeaderSeedRef.current = null;
        const recordingPatientId = selectedId;
        const recordingEntryId = activeEntryId;
        const recordingGen = sessionGenRef.current;
        const mr = new MediaRecorder(stream, { mimeType });

        mr.ondataavailable = (e) => {
          if (e.data.size > 0) {
            if (collateralHeaderSeedRef.current === null) {
              collateralHeaderSeedRef.current = e.data;
            }
            collateralChunksRef.current.push(e.data);
          }
        };

        mr.onstop = () => {
          // Stop level monitoring
          if (collateralAnimFrameRef.current) { cancelAnimationFrame(collateralAnimFrameRef.current); collateralAnimFrameRef.current = null; }
          try { collateralAudioCtxRef.current?.close(); } catch { /* fail silently */ }
          collateralAudioCtxRef.current = null;
          // Stop all tracks
          stream.getTracks().forEach(t => t.stop());

          const chunks = collateralChunksRef.current;
          if (chunks.length === 0) return;
          const blob = new Blob(chunks, { type: mimeType });
          collateralChunksRef.current = [];
          collateralHeaderSeedRef.current = null;
          void transcribeCollateralAudio(blob, collateralDurationRef.current, recordingPatientId, recordingEntryId, recordingGen);
        };

        mr.start(1000);
        collateralMediaRecorderRef.current = mr;
        setCollateralRecording(true);

        collateralTimerRef.current = setInterval(() => {
          setCollateralElapsed(s => s + 1);
        }, 1000);
      } catch (err) {
        showToast("Could not access microphone for collateral recording — please allow microphone access.", "error");
      }
    }
  }

  function cancelCollateralRecording() {
    if (!collateralMediaRecorderRef.current || collateralMediaRecorderRef.current.state === "inactive") return;
    if (collateralTimerRef.current) { clearInterval(collateralTimerRef.current); collateralTimerRef.current = null; }
    if (collateralAnimFrameRef.current) { cancelAnimationFrame(collateralAnimFrameRef.current); collateralAnimFrameRef.current = null; }
    try { collateralAudioCtxRef.current?.close(); } catch { /* fail silently */ }
    collateralAudioCtxRef.current = null;
    collateralChunksRef.current = [];
    collateralHeaderSeedRef.current = null;
    collateralMediaRecorderRef.current.stop();
    setCollateralRecording(false);
    setCollateralElapsed(0);
    showToast("Collateral recording cancelled.", "error");
  }

  function cancelCollateralTranscription() {
    if (collateralAbortRef.current) {
      collateralAbortRef.current.abort();
      collateralAbortRef.current = null;
    }
    setCollateralTranscribing(false);
    showToast("Collateral transcription cancelled.", "error");
  }

  // ── Session actions ──────────────────────────────────────────
  function newSession() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      // BUG FIX (F/E): Set intentionalStopRef=true BEFORE mr.stop() so onstop does NOT
      // fire the unexpected-stop alert. Without this, onstop sees intentionalStop=false
      // and shows a crash error to a user who deliberately clicked New Session.
      intentionalStopRef.current = true;
      // CRITICAL ORDER: sessionGenRef MUST be incremented BEFORE mr.stop().
      // In Chrome, onstop fires synchronously inside stop(). If the increment
      // happens after stop(), the entry guard in transcribeAudio sees the old
      // generation, lets the empty-blob onstop call through, and it shows a
      // spurious "Recording appears empty" toast to a user who clicked New Session.
      // Incrementing first means onstop → transcribeAudio(emptyBlob, gen=old) fires
      // with callerGen < sessionGenRef.current → silent return, no toast.
      sessionGenRef.current += 1;
      // Clear chunks BEFORE stop so onstop assembles a zero-byte blob.
      // The generation guard above ensures transcribeAudio exits silently for it.
      audioChunksRef.current = [];
      mediaRecorderRef.current.stop();
    }
    if (chunkTimerRef.current) { clearInterval(chunkTimerRef.current); chunkTimerRef.current = null; }
    // Also increment when the recorder is already inactive — covers the case where
    // the user stopped recording but a chunk is still transcribing. The in-flight
    // transcribeAudio call will see a generation mismatch at the write guard and
    // discard its result instead of polluting the new session.
    sessionGenRef.current += 1;
    // Reset duration refs so the next session's size-vs-duration guard
    // does not use stale values from the previous recording.
    recordedDurationRef.current = 0;
    lastChunkElapsedRef.current = 0;
    headerSeedRef.current = null;
    // Synchronously clear transcriptRef so any in-flight transcribeAudio call that reads
    // transcriptRef.current after this point appends to "" rather than stale content.
    transcriptRef.current = "";
    setTranscript(""); setSessionNotes(""); setActiveEntryId(null); setError("");
    setElapsed(0); setRecording(false); setTranscribing(false);
    // Mint a fresh token directly here, not only in the activeEntryId-watching
    // effect. If the session was ALREADY unsaved (activeEntryId already null)
    // before clicking "New Session", setActiveEntryId(null) above is a no-op
    // from React's point of view (same value in, no re-render, dependent
    // effects never re-fire) — so without this direct mint, the new session
    // would silently keep reusing the previous abandoned draft's token and
    // inherit its leftover collateral text.
    newSessionTokenRef.current = `new_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    collateralTranscriptRef.current = "";
    setCollateralTranscript("");
  }

  // ── Auto-save transcript draft to Supabase ───────────────────────────────
  // Uses a deterministic draft row ID so repeated saves upsert the same row.
  // Real reports use UUID v4 which never starts with "draft_", so no collision.
  async function saveTranscriptDraft(text: string) {
    if (!selectedId || !doctorId) return;
    // Write to localStorage immediately — this is what the draft-restore
    // effect reads when the user navigates back to the new-session slot.
    // The 30-second interval also does this, but the immediate write here
    // ensures the transcript survives even if the user navigates away within
    // the first 30 seconds after transcription finishes.
    try { localStorage.setItem(`psych_draft_${doctorId}_${selectedId}`, text); } catch (_) {}
    const payload = {
      doctor_id: doctorId,
      patient_id: selectedId,
      transcript: text,
      updated_at: new Date().toISOString(),
    };
    // Try up to 2 times (immediate + 1 retry after 1s) before showing error banner
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { error: upsertError } = await supabase
          .from("report_drafts")
          .upsert(payload, { onConflict: "doctor_id,patient_id" });
        if (upsertError) throw upsertError;
        setAutoSaveError(false);
        return;
      } catch {
        if (attempt < 2) {
          await new Promise<void>(r => setTimeout(r, 1000));
        } else {
          setAutoSaveError(true);
        }
      }
    }
  }

  // ── Hallucination detection ───────────────────────────────────────────────
  // Whisper (and Gemini) hallucinates filler text on silent/very-short audio.
  // Common patterns: "you", "you you you", "Thank you.", "Thank you for watching."
  function isHallucinatedTranscript(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/[.!?,\-]/g, "").trim();
    if (!normalized) return true;
    // Known Whisper hallucination single-phrase outputs
    const knownHallucinations = [
      "you", "you you", "you you you",
      "thank you", "thank you thank you", "thank you thank you thank you",
      "thank you thank you thank you thank you",
      "thanks", "thanks thanks", "thank you for watching",
      "thanks for watching", "bye", "goodbye", "hmm", "uh", "um",
      "okay", "ok", "yes", "no", "i see", "i know", "right",
      "please subscribe", "like and subscribe",
      "subtitles by", "subtitles", "captions by",
      "im not sure if im going to be able to make it to the meeting",
      "i dont know", "the meeting", "see you next time", "see you later",
      "music", "music playing", "background music", "applause", "laughter",
    ];
    if (knownHallucinations.includes(normalized)) return true;

    const words = normalized.split(/\s+/);

    // Repeated single word: "you you you you" etc.
    if (words.length >= 2 && words.every(w => w === words[0])) return true;

    // CRITICAL FIX: detect repeated 2-word phrases like "Thank you. Thank you. Thank you."
    // These have only 2 unique words across the whole text — impossible in real speech.
    const uniqueWords = new Set(words);
    if (words.length >= 4 && uniqueWords.size <= 2) return true;  // e.g. "thank you" × N
    if (words.length >= 8 && uniqueWords.size <= 3) return true;  // e.g. near-silence hallucination

    // Nearly-repeated: at least 4 words and 80%+ are the same single word
    if (words.length >= 4) {
      const freq: Record<string, number> = {};
      words.forEach(w => { freq[w] = (freq[w] ?? 0) + 1; });
      const maxFreq = Math.max(...Object.values(freq));
      if (maxFreq / words.length >= 0.8) return true;
    }

    // Sentence-level repetition: same sentence repeated 3+ times = hallucination on near-silence
    const sentences = text.trim().split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (sentences.length >= 3) {
      const uniqueSentences = new Set(sentences);
      if (uniqueSentences.size === 1) return true;
      if (uniqueSentences.size <= 2 && sentences.length >= 4) return true;
    }

    return false;
  }

  async function transcribeAudio(audioBlob: Blob, mimeType: string, callerGen: number) {
    // ── AUDIO PRIVACY GUARANTEE (DPDP Act 2023) ───────────────────────────
    // 1. The audio blob exists ONLY in this function's local scope — it is
    //    never assigned to any ref, state variable, or module-level variable.
    // 2. It is transmitted ONLY to an AI speech-to-text API (primary or fallback)
    //    over an encrypted HTTPS connection via the server. No other relay.
    // 3. It is NEVER written to localStorage, sessionStorage, IndexedDB,
    //    Supabase, or any other persistence layer.
    // 4. The local blob reference is explicitly cleared (set to null) after
    //    the FormData payload is built, making it eligible for garbage
    //    collection before the network round-trip even begins.
    // 5. Only the plain-text transcript returned by the AI service is retained.
    // ──────────────────────────────────────────────────────────────────────

    // ── Session generation guard ─────────────────────────────────────────
    // Capture the current session generation at the moment this call starts.
    // If newSession() fires during the network round-trip (30-60s), it increments
    // sessionGenRef. We check again before writing results — if the value changed,
    // the user has already moved to a new session and we discard silently.
    // This also suppresses the empty-blob call from onstop after newSession stops
    // the recorder, because that call enters with the NEW generation and the size
    // guard below exits before reaching the write — but we still want zero toasts.
    // If the caller's session generation is already behind the current value,
    // newSession() fired before this call even started — discard immediately,
    // no guards, no toasts. This covers the onstop empty-blob call from newSession.
    if (callerGen !== sessionGenRef.current) return;

    // ── Minimum duration / size guard ─────────────────────────────────────
    // Recordings shorter than 1 second or smaller than 3 KB are almost always
    // silence or accidental taps and will only produce hallucinated text.
    const recordedSecs = recordedDurationRef.current;
    if (recordedSecs < 1) {
      showToast("Recording too short — please hold the mic button for at least a second.", "error");
      return;
    }
    if (audioBlob.size < 3000) {
      showToast("Recording appears empty — please check your microphone and try again.", "error");
      return;
    }
    // Size-vs-duration guard: webm/opus records at ~20-40kbps minimum.
    // If the file is under 1KB per second, audio was never captured (mic silent).
    if (recordedSecs >= 5 && audioBlob.size < recordedSecs * 1000) {
      showToast(
        `Microphone not capturing audio — ${recordedSecs}s recording is only ${Math.round(audioBlob.size / 1024)}KB. ` +
        `Refresh the page, allow microphone access, and check the live waveform while recording.`,
        "error",
      );
      return;
    }

    setTranscribing(true);
    const abortCtrl = new AbortController();
    transcribeAbortRef.current = abortCtrl;
    try {
      const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mp4") ? "mp4" : "ogg";

      // Wrap the audio data into a File for the multipart upload, then
      // immediately drop the blob reference so it can be garbage-collected
      // before the network request is sent.
      let blobRef: Blob | null = audioBlob;
      const file = new File([blobRef], `recording.${ext}`, { type: mimeType });
      blobRef = null; // explicit discard — audio data no longer reachable via this scope

      // Transcribe via AI speech-to-text — up to 3 attempts with backoff.
      // A single network blip, API timeout, or rate-limit spike will not
      // silently drop a chunk; the loop retries before propagating the error.
      const MAX_RETRIES = 3;
      let rawText = "";
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // If the user cancelled, exit silently — no toast, no API count
        if (abortCtrl.signal.aborted) return;
        try {
          rawText = await callTranscribeWithFallback(
            file,
            () => showToast("Switched to backup transcription service"),
            abortCtrl.signal,
          );
          break; // success — exit retry loop
        } catch (err) {
          // User pressed cancel — exit silently, no toast
          if (err instanceof Error && err.name === "AbortError") return;
          if (attempt === MAX_RETRIES) throw err; // all 3 attempts exhausted → outer catch
          const waitSecs = attempt * 4;           // 4 s then 8 s
          showToast(`Transcription attempt ${attempt} failed — retrying in ${waitSecs}s…`, "error");
          await new Promise<void>(r => setTimeout(r, waitSecs * 1000));
          if (sessionGenRef.current !== callerGen) return; // session changed while waiting
        }
      }
      if (!rawText) return;

      // ── Hallucination guard ──────────────────────────────────────────────
      // If the AI returns a known hallucination pattern (e.g. "you you you"),
      // reject it instead of silently inserting garbage into the transcript.
      if (isHallucinatedTranscript(rawText)) {
        showToast("Transcription returned empty audio — check your microphone and try again.", "error");
        return;
      }

      const doctorLabel = doctor.name || "Doctor";
      const patientLabel = "Patient";
      let labelled = rawText;
      try {
        labelled = await callLLMWithFallback(
          [
            {
              role: "system",
              content: `You are a medical transcription formatter. Your ONLY job is to add speaker labels to a psychiatry session transcript.

OUTPUT FORMAT — one line per speaker turn, nothing else, no timestamps:
${doctorLabel}: [exact words spoken]
${patientLabel}: [exact words spoken]

RULES — no exceptions:
1. Every single line MUST begin with exactly "${doctorLabel}:" or "${patientLabel}:" — no unlabelled text ever, and no timestamp, time marker, or [MM:SS]-style prefix of any kind.
2. Start a NEW line each time the speaker changes. Never merge two turns into one line.
3. ${doctorLabel} = the psychiatrist — asks clinical questions, gives diagnoses, prescribes medications, explains treatment plans.
4. ${patientLabel} = the person being treated — describes symptoms, answers questions, shares personal history.
5. Copy every word exactly as spoken. Do NOT paraphrase, summarise, or omit anything.
6. If a turn is ambiguous, label it ${doctorLabel}:
7. Preserve any existing non-verbal annotations inline exactly as given, without altering or re-estimating them: [pause], [long pause], [laughs], [sighs], [voice break], [quietly], [crying].
8. Do NOT add preamble, commentary, section headers, or any text that is not a labelled speaker turn.

EXAMPLE OUTPUT:
${doctorLabel}: How long have you been feeling this way?
${patientLabel}: About three months. It started after I lost my job. [sighs]
${doctorLabel}: Are you sleeping at night?
${patientLabel}: No, I wake up at 3 AM and cannot go back to sleep.
${doctorLabel}: I want to start you on a low dose of sertraline.`,
            },
            {
              role: "user",
              content: `Add "${doctorLabel}:" or "${patientLabel}:" labels to every speaker turn. Do NOT add timestamps. Output ONLY labelled lines — no other text:\n\n${rawText}`,
            },
          ],
          () => showToast("Switched to backup service"),
        );
        // Validate that diarization produced actual speaker labels.
        // If the LLM returned a raw paragraph or ignored the format, fall back
        // to the raw transcript so the doctor sees real text rather than garbage.
        const hasSpeakerLabels =
          labelled.includes(`${doctorLabel}:`) ||
          labelled.includes("Doctor:") ||
          labelled.includes("doctor:") ||
          labelled.includes(`${patientLabel}:`);
        labelled = hasSpeakerLabels ? labelled.trim() : rawText;
      } catch {
        labelled = rawText; // diarization failed — use raw transcript
      }
      // BUG FIX (I): Capture duration once here rather than re-reading recordedDurationRef
      // at label-build time. Between the top-of-function guard read and this line,
      // toggleRecording() can overwrite recordedDurationRef with elapsed, causing the
      // label to show the full session time instead of the chunk duration.
      const durLabel = `[Recording: ${fmtTime(recordedSecs)}]`;
      // BUG FIX (J): Two concurrent transcribeAudio calls (chunk + final) can both read
      // transcriptRef.current before either one's setTranscript triggers the useEffect
      // sync — React batches renders, so the useEffect runs after both set calls, meaning
      // the second call sees the same pre-update transcriptRef and overwrites the first.
      // Fix: update transcriptRef.current synchronously RIGHT BEFORE setTranscript so the
      // next concurrent call immediately sees the updated value without waiting for useEffect.
      // ── Session generation check (write guard) ───────────────────────────
      // Re-read sessionGenRef right before writing. If newSession() fired during
      // the ~30-60s network round-trip, the generation will have advanced — discard
      // silently rather than appending old audio to the new session's transcript.
      if (sessionGenRef.current !== callerGen) return;

      const currentTranscript = transcriptRef.current;
      const newTranscript = currentTranscript ? currentTranscript + "\n\n" + durLabel + "\n" + labelled : durLabel + "\n" + labelled;
      transcriptRef.current = newTranscript; // sync update — makes next concurrent read correct
      setTranscript(newTranscript);
      setTranscriptView("view");
      showToast("✅ Transcription complete — review and click Generate Report.", "success");
      // Auto-save draft to Supabase silently
      void saveTranscriptDraft(newTranscript);
    } catch (err) {
      // Silently ignore abort errors — user cancelled intentionally
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Transcription failed: " + (err instanceof Error ? err.message : String(err)));
      showToast("⚠️ Transcription failed — your recording could not be processed. Please manually type the session notes in the transcript box.", "error");
    } finally {
      transcribeAbortRef.current = null;
      setTranscribing(false);
    }
  }

  // ── Build a mixed mic + call-audio stream for "Record online call" mode ──
  // Does NOT touch the existing mic-only path at all. Returns a single-track
  // MediaStream (from an AudioContext destination) that MediaRecorder treats
  // exactly like a normal mic stream — same mimeType logic, same chunking,
  // same onstop/transcription pipeline downstream.
  async function buildCallRecordingStream(): Promise<MediaStream> {
    if (typeof (navigator.mediaDevices as any)?.getDisplayMedia === "undefined") {
      throw new Error("CALL_CAPTURE_UNSUPPORTED");
    }
    // 1) Doctor's own mic — same call as the mic-only path.
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 2) The shared tab/window/screen's audio — this is the patient's voice
    //    coming through the call app, captured BEFORE it reaches the speaker.
    let dispStream: MediaStream;
    try {
      dispStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      // User cancelled the share picker, or denied it — release the mic we
      // already grabbed so we don't leave a dangling "mic in use" indicator.
      micStream.getTracks().forEach(t => t.stop());
      throw err;
    }
    // We only want audio — stop the video track immediately so no video is
    // ever captured, recorded, or sent anywhere.
    dispStream.getVideoTracks().forEach(t => t.stop());
    const dispAudioTracks = dispStream.getAudioTracks();
    if (dispAudioTracks.length === 0) {
      // Most common cause: the doctor picked a window/screen instead of a tab,
      // or unchecked "Share tab audio" in the picker. No call audio was captured.
      micStream.getTracks().forEach(t => t.stop());
      dispStream.getTracks().forEach(t => t.stop());
      throw new Error("CALL_AUDIO_NOT_SHARED");
    }
    // 3) Mix both audio sources into one track using the Web Audio API.
    const Ctx = (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext;
    const mixCtx = new Ctx();
    const dest = mixCtx.createMediaStreamDestination();
    mixCtx.createMediaStreamSource(micStream).connect(dest);
    mixCtx.createMediaStreamSource(new MediaStream(dispAudioTracks)).connect(dest);
    callMixCtxRef.current = mixCtx;
    // Keep references to the raw hardware/share tracks so we can release them
    // on stop — the destination stream's own track is separate from these.
    callRawTracksRef.current = [...micStream.getTracks(), ...dispStream.getTracks()];
    // If the doctor stops sharing the tab from the browser's own "Stop sharing"
    // bar (not from Sphota's stop button), treat it as an unexpected stop so
    // the recording still finalises and transcribes whatever was captured.
    dispAudioTracks[0].addEventListener("ended", () => {
      if (!intentionalStopRef.current && mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
    });
    return dest.stream;
  }

  // Releases whatever buildCallRecordingStream() acquired — raw mic/display
  // tracks plus the mixing AudioContext. No-op in plain mic mode (arrays stay empty).
  function releaseCallCaptureResources() {
    callRawTracksRef.current.forEach(t => { try { t.stop(); } catch { /* already stopped */ } });
    callRawTracksRef.current = [];
    if (callMixCtxRef.current) {
      callMixCtxRef.current.close().catch(() => {});
      callMixCtxRef.current = null;
    }
  }

  async function toggleRecording(mode: "mic" | "call" = "mic") {
    if (recording) {
      intentionalStopRef.current = true;
      // CRITICAL FIX for long recordings (25-30 min):
      // The final blob only contains audio SINCE the last auto-chunk was sent.
      // If we set recordedDurationRef to the full elapsed (e.g. 1500s for a 25-min
      // session), the size-vs-duration guard in transcribeAudio rejects the final
      // blob because a 1-minute clip can never be 1500 * 1000 = 1.5MB.
      // Fix: use elapsed minus the elapsed at the last chunk boundary.
      // For recordings with no chunks (< 4 min), lastChunkElapsedRef is 0,
      // so this reduces to just `elapsed` — same as before.
      recordedDurationRef.current = Math.max(1, elapsed - lastChunkElapsedRef.current);
      // Stop auto-chunk timer before stopping recorder
      if (chunkTimerRef.current) { clearInterval(chunkTimerRef.current); chunkTimerRef.current = null; }
      mediaRecorderRef.current?.stop();
      setRecording(false);
      showToast("Processing recording…");
      // Release wake lock when recording stops
      try { await wakeLockRef.current?.release(); } catch { /* fail silently */ }
      wakeLockRef.current = null;
    } else {
      setError("");
      pendingRecordModeRef.current = mode;
      // Consent gate: check if consent was already given for this patient this session,
      // or if consent_given_at is already set in the DB for this patient.
      const patId = selectedId;
      if (patId !== null) {
        let hasConsent = !!consentGivenRef.current[patId];
        if (!hasConsent) {
          // Check DB for persisted consent
          const { data: patRow } = await supabase
            .from("patients")
            .select("consent_given_at")
            .eq("id", patId)
            .single();
          if (patRow?.consent_given_at) {
            consentGivenRef.current[patId] = patRow.consent_given_at;
            hasConsent = true;
          }
        }
        if (!hasConsent) {
          // Show consent modal — recording will start only after confirmation
          setConsentChecked(false);
          setShowConsentModal(true);
          return;
        }
      }
      await startRecordingNow(mode);
    }
  }

  async function startRecordingNow(mode: "mic" | "call" = "mic") {
    setError("");
    try {
      const stream = mode === "call" ? await buildCallRecordingStream() : await navigator.mediaDevices.getUserMedia({ audio: true });
      // Format priority per browser:
      // Chrome/Edge: ONLY supports webm — ogg is not supported, mp4 is unreliable
      // Firefox:     supports ogg and webm
      // Safari:      supports mp4
      // Rule: webm first (Chrome), then ogg (Firefox), then mp4 (Safari)
      // The server uses Groq Whisper for webm (supports it natively),
      // and Gemini for ogg/mp4 (both supported by Gemini generateContent).
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/ogg")
        ? "audio/ogg"
        : "audio/mp4";
      const mr = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      intentionalStopRef.current = false;
      lastChunkElapsedRef.current = 0; // reset chunk boundary tracker for this recording session
      headerSeedRef.current = null;    // reset WebM header seed for this recording session
      // Capture the session generation at the moment this recording starts.
      // Passed into every transcribeAudio call so stale calls from a previous
      // session (after newSession() increments sessionGenRef) are discarded.
      const recordingGen = sessionGenRef.current;
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) {
          // Capture the FIRST non-empty blob as the WebM header seed.
          // Only the first ondataavailable blob contains the EBML container
          // header (codec description, Tracks element). All subsequent blobs
          // are raw cluster data. We save this blob so we can prepend it to
          // every chunk 2+ and to the final onstop blob, making them valid
          // self-contained audio files that Gemini/Whisper can decode.
          if (headerSeedRef.current === null) {
            headerSeedRef.current = e.data;
          }
          audioChunksRef.current.push(e.data);
        }
      };
      // CRITICAL: start with a 1-second timeslice so ondataavailable fires every second.
      // Without a timeslice, Chrome produces a webm file missing seek tables and duration
      // metadata — Groq/Whisper can only decode the first fragment and hallucinates "you".
      // With 1-second chunks assembled into a Blob, the webm is a valid progressive file
      // that Whisper can fully decode regardless of recording length.
      mr.onstop = () => {
        // Stop the live waveform monitor immediately
        if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
        if (audioContextRef.current) { audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
        analyserRef.current = null;
        silentFramesRef.current = 0;
        setAudioLevel(0);
        setSilentFrames(0);

        // Release the microphone hardware immediately.
        stream.getTracks().forEach(t => t.stop());
        // Release call-mode capture resources (raw mic + shared-tab tracks, mixing
        // AudioContext) — no-op when this was a plain mic recording.
        releaseCallCaptureResources();

        // If the stop was not triggered by the user, show the unexpected-stop alert.
        if (!intentionalStopRef.current) {
          setRecording(false);
          setRecUnexpectedStop(true);
          try { wakeLockRef.current?.release(); } catch { /* fail silently */ }
          wakeLockRef.current = null;
          audioChunksRef.current = [];
          return;
        }

        // Assemble the audio blob from the in-memory chunks, then clear
        // the chunk array so no raw audio data is retained in this ref.
        // AUDIO PRIVACY: The blob is passed directly to transcribeAudio()
        // where it is sent ONLY to an AI speech-to-text service over HTTPS and then
        // explicitly discarded. It is never stored in localStorage,
        // sessionStorage, IndexedDB, Supabase, or any server endpoint.
        //
        // CRITICAL: If at least one chunk was already flushed (chunkIndex > 0),
        // audioChunksRef only contains audio SINCE the last chunk clear — these
        // are raw cluster blobs with no WebM EBML header. Prepend the saved
        // header seed to make the final blob a valid self-contained audio file.
        // If no chunks were flushed yet (short recording < 4 min), audioChunksRef
        // still contains the full recording from the start, including the header.
        const remainingChunks = audioChunksRef.current;
        audioChunksRef.current = []; // raw chunks cleared before async call
        const blob = (chunkIndex > 0 && headerSeedRef.current)
          ? new Blob([headerSeedRef.current, ...remainingChunks], { type: mimeType })
          : new Blob(remainingChunks, { type: mimeType });
        transcribeAudio(blob, mimeType, recordingGen);
      };
      mr.onerror = () => {
        // MediaRecorder error — treat as unexpected stop
        intentionalStopRef.current = false;
        stream.getTracks().forEach(t => t.stop());
        releaseCallCaptureResources();
        setRecording(false);
        setRecUnexpectedStop(true);
        try { wakeLockRef.current?.release(); } catch { /* fail silently */ }
        wakeLockRef.current = null;
        audioChunksRef.current = [];
      };
      mr.start(1000); // 1-second timeslice — essential for valid progressive webm
      mediaRecorderRef.current = mr;

      // ── Auto-chunking: every 8 minutes, snapshot accumulated chunks ───────
      // Strategy: DO NOT stop the recorder — that kills the mic stream and
      // breaks onstop. Instead, every 8 min we:
      //   1. Call requestData() to flush any partial second into audioChunksRef
      //   2. Snapshot and clear audioChunksRef atomically
      //   3. Build a Blob from the snapshot and send it to transcribeAudio()
      //   4. Recording continues uninterrupted — user sees nothing change
      // The recorder keeps accumulating new chunks while the previous batch
      // is being transcribed. Transcripts append automatically.
      const CHUNK_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes — keeps chunks ~4.8MB, safely within 60s Vercel limit
      // Track chunk number for duration labelling
      let chunkIndex = 0;
      chunkTimerRef.current = setInterval(() => {
        const mr2 = mediaRecorderRef.current;
        if (!mr2 || mr2.state !== "recording") return;

        // requestData() forces ondataavailable to fire right now with any
        // buffered audio since the last timeslice — ensures no partial second is lost.
        mr2.requestData();

        // Wait one tick for ondataavailable to push the data into audioChunksRef
        setTimeout(() => {
          // BUG FIX (H): If the user pressed stop between requestData() and now,
          // intentionalStopRef is already true and onstop has already run (or is
          // about to run synchronously). onstop will assemble ALL current chunks
          // from audioChunksRef for the final blob. If we proceed here we race:
          // whoever grabs audioChunksRef first wins, the other gets an empty array
          // and the corresponding audio is silently lost.
          // Guard: yield all remaining audio to onstop when stop was requested.
          if (intentionalStopRef.current) return;

          // Atomically snapshot and clear the chunks
          const snapshot = audioChunksRef.current.slice();
          audioChunksRef.current = [];

          if (snapshot.length === 0) return; // nothing recorded yet

          chunkIndex += 1;

          // CRITICAL: Prepend the WebM header seed to chunks 2, 3, … so each
          // chunk is a valid self-contained audio file.
          // Chunk 1 (chunkIndex === 1) still has the header as its first blob
          // (since audioChunksRef was never cleared before this point).
          // Chunks 2+ have had audioChunksRef cleared — their snapshot contains
          // only raw cluster data with no header → invalid → Gemini hallucinates.
          // Prepending the saved header seed makes every chunk decodable.
          const chunkBlob = (chunkIndex > 1 && headerSeedRef.current)
            ? new Blob([headerSeedRef.current, ...snapshot], { type: mimeType })
            : new Blob(snapshot, { type: mimeType });
          if (chunkBlob.size < 3000) return; // too small — silence or error

          // Set recordedDurationRef to this chunk's duration (CHUNK_INTERVAL_MS seconds).
          // Each chunk covers exactly one interval worth of audio.
          const chunkElapsed = chunkIndex * (CHUNK_INTERVAL_MS / 1000);
          recordedDurationRef.current = CHUNK_INTERVAL_MS / 1000; // one chunk = one interval
          // Track where we are in the session so toggleRecording can compute
          // the final blob duration as (total_elapsed - lastChunkElapsed).
          lastChunkElapsedRef.current = chunkElapsed;

          // transcribeAudio appends to the existing transcript automatically.
          transcribeAudio(chunkBlob, mimeType, recordingGen);
        }, 150); // one tick after requestData fires ondataavailable
      }, CHUNK_INTERVAL_MS);

      // ── Live waveform monitor using Web Audio API ──────────────────────────
      // Connects the microphone stream to an AnalyserNode and samples the RMS
      // amplitude ~15fps to drive the waveform bars in the UI. If the amplitude
      // stays near zero the "No audio detected" warning appears, giving the
      // doctor an immediate signal that the microphone is not working.
      silentFramesRef.current = 0;
      setSilentFrames(0);
      try {
        const Ctx = (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext;
        const ctx = new Ctx();
        audioContextRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.7;
        src.connect(analyser);
        analyserRef.current = analyser;
        const td = new Uint8Array(analyser.fftSize);
        let frameN = 0;
        const tick = () => {
          animFrameRef.current = requestAnimationFrame(tick);
          if (++frameN % 4 !== 0) return; // sample ~15fps out of ~60fps
          if (!analyserRef.current) return;
          analyserRef.current.getByteTimeDomainData(td);
          // RMS of deviation from 128 (silence baseline)
          let sum = 0;
          for (let i = 0; i < td.length; i++) sum += (td[i] - 128) ** 2;
          const rms = Math.sqrt(sum / td.length);
          const level = Math.min(1, rms / 40);
          if (level < 0.02) {
            silentFramesRef.current++;
            // Update state every 15 frames (~1s) to avoid excessive re-renders
            if (silentFramesRef.current % 15 === 0) setSilentFrames(silentFramesRef.current);
            // After 30 seconds of silence (~450 frames at 15fps), warn the doctor loudly
            if (silentFramesRef.current === 450) {
              showToast("⚠️ No audio detected for 30 seconds — your microphone may have been cut off. Stop and restart the recording.", "error");
            }
          } else {
            silentFramesRef.current = 0;
            setSilentFrames(0);
          }
          setAudioLevel(level);
        };
        animFrameRef.current = requestAnimationFrame(tick);
      } catch { /* fail silently — waveform is best-effort, does not affect recording */ }

      setElapsed(0);
      // Snap to the new-session slot so the live transcript is always visible.
      // If the user was viewing a past session entry, reset it to null so the
      // recording panel / live transcript area is shown. Also switch the mobile
      // tab to "record" so the microphone panel is in view on narrow screens.
      setActiveEntryId(null);
      setMobileTab("record");
      // Prevent screen from locking during recording
      try {
        if ("wakeLock" in navigator) {
          wakeLockRef.current = await (navigator as Navigator & { wakeLock: { request: (type: string) => Promise<WakeLockSentinel> } }).wakeLock.request("screen");
        }
      } catch { /* fail silently — wake lock is best-effort */ }
      setRecording(true);
    } catch (err) {
      releaseCallCaptureResources();
      if (err instanceof Error && err.message === "CALL_CAPTURE_UNSUPPORTED") {
        setError("Recording online calls isn't supported in this browser. Please use Chrome or Edge on a laptop/desktop.");
      } else if (err instanceof Error && err.message === "CALL_AUDIO_NOT_SHARED") {
        setError("No call audio was captured — when the share picker opens, choose the browser tab with the call and make sure \"Share tab audio\" is checked.");
      } else if (err instanceof Error && err.name === "NotAllowedError" && mode === "call") {
        setError("Screen/tab-share permission was denied. Recording online calls needs that permission to capture the patient's audio.");
      } else {
        setError("Microphone access denied. Please allow microphone permission and try again.");
      }
    }
  }

  async function handleConsentConfirm() {
    if (!consentChecked || selectedId === null) return;
    const now = new Date().toISOString();
    // Persist consent to DB
    await supabase
      .from("patients")
      .update({ consent_given_at: now })
      .eq("id", selectedId);
    consentGivenRef.current[selectedId] = now;
    setShowConsentModal(false);
    await startRecordingNow(pendingRecordModeRef.current);
  }

  async function toggleFlag() {
    if (!activeEntry || !selectedId) return;
    const newFlagged = !flagged.has(activeEntry.id);
    const next = new Set(flagged);
    if (newFlagged) next.add(activeEntry.id); else next.delete(activeEntry.id);
    setFlagged(next);
    try { await db.updateSession(activeEntry.id, { flagged: newFlagged }); }
    catch (e) { console.error("Failed to toggle flag:", e); showToast("⚠️ Could not update flag. Check your connection.", "error"); }
  }

  async function handleNoteFormatChange(fmt: NoteFormat) {
    const updated: DoctorProfile = { ...doctor, noteFormat: fmt };
    setDoctor(updated);
    localStorage.setItem("psych_note_format", fmt);
    try { await db.saveProfile(updated); }
    catch (e) { console.error("Failed to save note format:", e); }
  }

  // ── Delete single session entry ──────────────────────────────
  async function deleteEntry(entryId: string) {
    if (!selectedId) return;
    setHistory(prev => {
      const nextEntries = (prev[selectedId] ?? []).filter(e => e.id !== entryId);
      const next = { ...prev, [selectedId]: nextEntries };
      if (nextEntries.length === 0) delete next[selectedId];
      return next;
    });
    const removedFlagged = new Set(flagged); removedFlagged.delete(entryId); setFlagged(removedFlagged);
    if (activeEntryId === entryId) { setActiveEntryId(null); setTranscript(""); }
    setDeletingEntryId(null);
    try { await db.deleteSession(entryId); }
    catch (e) { console.error("Failed to delete session:", e); showToast("⚠️ Could not delete session from cloud. Check your connection.", "error"); }
  }

  // ── Delete patient ───────────────────────────────────────────
  async function deletePatient() {
    if (!selectedPatient) return;
    const deletedId = selectedPatient.id;
    setPatients(prev => prev.filter(p => p.id !== deletedId));
    setHistory(prev => { const next = { ...prev }; delete next[deletedId]; return next; });
    setSelectedId(null); setActiveEntryId(null);
    setTranscript(""); setDeleteStep(0); setError("");
    try { await db.deletePatient(deletedId); }
    catch (e) { console.error("Failed to delete patient:", e); showToast("⚠️ Could not delete patient from cloud. Check your connection.", "error"); }
  }

  // ── Patient JSON export (share with another doctor) ──────────
  async function exportPatientJson(patient: Patient) {
    try {
      const sessions = history[patient.id] ?? [];
      const exportData = {
        exportType: "full_patient",
        exportedAt: new Date().toISOString(),
        exportedBy: doctor.name || "Unknown Doctor",
        patient,
        sessions,
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeName = patient.name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      a.href = url; a.download = `sphota-patient-${safeName}-${new Date().toISOString().slice(0,10)}.json`; a.click();
      URL.revokeObjectURL(url);
      if (!isUnlimited) {
        setMonthlyCount(prev => prev + 1);
      }
      showToast("Patient data exported as JSON", "success");
    } catch {
      showToast("Export failed. Please try again.", "error");
    }
  }

  // Export a single report — for sending one session's report to another
  // doctor without handing over the patient's entire history.
  async function exportSingleReportJson(patient: Patient, entry: ReportEntry) {
    try {
      const exportData = {
        exportType: "single_report",
        exportedAt: new Date().toISOString(),
        exportedBy: doctor.name || "Unknown Doctor",
        patient: { name: patient.name, age: patient.age, gender: patient.gender },
        report: entry,
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeName = patient.name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      const safeDate = (entry.date || new Date().toISOString().slice(0,10)).replace(/[^a-z0-9]/gi, "_");
      a.href = url; a.download = `sphota-report-${safeName}-${safeDate}.json`; a.click();
      URL.revokeObjectURL(url);
      showToast("Report exported as JSON", "success");
    } catch {
      showToast("Export failed. Please try again.", "error");
    }
  }

  const [importPatientModalOpen, setImportPatientModalOpen] = useState(false);
  const [importedPatientData, setImportedPatientData] = useState<{ patient: Patient; sessions: ReportEntry[] } | null>(null);
  const [importPatientStatus, setImportPatientStatus] = useState<"idle" | "importing" | "done">("idle");
  const importPatientFileRef = useRef<HTMLInputElement>(null);

  function openImportPatient() {
    setImportedPatientData(null);
    setImportPatientStatus("idle");
    setImportPatientModalOpen(true);
  }

  function handleImportPatientFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (!data.patient || !data.patient.name) throw new Error("Invalid file");
        setImportedPatientData({ patient: data.patient, sessions: data.sessions ?? [] });
      } catch {
        showToast("Invalid patient JSON file", "error");
      }
    };
    reader.readAsText(file);
  }

  async function confirmImportPatient() {
    if (!importedPatientData) return;
    setImportPatientStatus("importing");
    try {
      const { patient: imp, sessions } = importedPatientData;
      const { id: _oldId, ...patientRest } = imp as any;
      const newPatient = await db.createPatient({ ...patientRest });
      if (!newPatient) throw new Error("Could not create patient");
      for (const s of sessions) {
        try {
          await db.createSession(newPatient.id, {
            date: s.date || new Date().toISOString().slice(0,10),
            transcript: (s as any).transcript ?? "",
            rawText: (s as any).rawText ?? (s as any).raw_text ?? "",
            notes: (s as any).notes ?? "",
            flagged: (s as any).flagged ?? false,
          });
        } catch { /* continue with next session */ }
      }
      // Refresh patients list
      const updatedPatients = await db.getPatients();
      setPatients(updatedPatients);
      // Refresh sessions/history
      const updatedSessions = await db.getSessions();
      const hist: Record<number, ReportEntry[]> = {};
      for (const { patientId, entry } of updatedSessions) {
        if (entry.id.startsWith("draft_")) continue;
        if (!hist[patientId]) hist[patientId] = [];
        hist[patientId].push(entry);
      }
      setHistory(hist);
      setImportPatientStatus("done");
      setTimeout(() => { setImportPatientModalOpen(false); setImportPatientStatus("idle"); }, 1500);
      showToast(`Patient "${imp.name}" imported successfully`, "success");
    } catch (e: any) {
      showToast(e.message || "Import failed", "error");
      setImportPatientStatus("idle");
    }
  }


  function openImportReport() {
    setImportedReportData(null);
    setImportReportStatus("idle");
    setImportReportModalOpen(true);
  }

  function handleImportReportFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        // Accept either a single-report export ({ report: {...} }) or, for
        // convenience, a bare report object pasted/saved directly.
        const report = data.report ?? data;
        if (!report || (!report.rawText && !(report as any).raw_text)) {
          throw new Error("No report data found in file");
        }
        setImportedReportData(report as ReportEntry);
      } catch {
        showToast("Invalid report JSON file", "error");
      }
    };
    reader.readAsText(file);
  }

  async function confirmImportReport() {
    if (!importedReportData || selectedId === null || !selectedPatient) return;
    setImportReportStatus("importing");
    try {
      const r = importedReportData as any;
      const created = await db.createSession(selectedId, {
        date: r.date || new Date().toISOString().slice(0, 10),
        transcript: r.transcript ?? "",
        rawText: r.rawText ?? r.raw_text ?? "",
        notes: r.notes ?? "",
        flagged: r.flagged ?? false,
      });
      if (!created) throw new Error("Could not add report");
      // Refresh sessions/history for this patient
      const updatedSessions = await db.getSessions();
      const hist: Record<number, ReportEntry[]> = {};
      for (const { patientId, entry } of updatedSessions) {
        if (entry.id.startsWith("draft_")) continue;
        if (!hist[patientId]) hist[patientId] = [];
        hist[patientId].push(entry);
      }
      setHistory(hist);
      setImportReportStatus("done");
      setTimeout(() => { setImportReportModalOpen(false); setImportReportStatus("idle"); }, 1500);
      showToast(`Report added to ${selectedPatient.name}'s history`, "success");
    } catch (e: any) {
      showToast(e.message || "Import failed", "error");
      setImportReportStatus("idle");
    }
  }


  function openProfile() { setProfileDraft({ ...doctor }); setProfileOpen(true); }
  async function saveProfile() {
    const trimmed: DoctorProfile = {
      name:              profileDraft.name.trim() || doctor.name || "Doctor",
      specialty:         profileDraft.specialty.trim(),
      clinic:            profileDraft.clinic.trim(),
      contact:           profileDraft.contact?.trim() ?? "",
      dataRegion:        profileDraft.dataRegion ?? doctor.dataRegion ?? "India",
      noteFormat:        profileDraft.noteFormat ?? doctor.noteFormat ?? "SOAP",
      privacyAcceptedAt: doctor.privacyAcceptedAt,
      dataRetentionYears: profileDraft.dataRetentionYears ?? "never",
    };
    setDoctor(trimmed);
    setProfileOpen(false);
    showToast("Saving…", "default");
    try {
      await db.saveProfile(trimmed);
      showToast("Profile saved.", "success");
    } catch (e) {
      console.error("Failed to save profile:", e);
      showToast("Failed to save — please try again.", "error");
    }
  }

  // ── Generate report ──────────────────────────────────────────
  async function detectPsychScales(transcript: string, entryId: string, patId: number) {
    // AI always available via server proxy
    const safeTranscript = stripPatientPII(transcript, selectedPatient?.name ?? "");
    try {
      const raw = (await callLLMWithFallback(
        [
          { role: "system", content: "You are a psychiatric scale detector. Scan session transcripts for validated psychiatric scale scores. Return ONLY a valid JSON array with no markdown, no explanation, no extra text — just raw JSON." },
          { role: "user", content: `Scan this psychiatric session transcript for PHQ-9, GAD-7, and C-SSRS scores. They may be stated directly (e.g. "PHQ-9 score was 14") or implied (doctor reading individual item scores aloud).

Severity rules:
- PHQ-9: 0-4 = minimal, 5-9 = mild, 10-14 = moderate, 15-19 = moderately severe, 20-27 = severe
- GAD-7: 0-4 = minimal, 5-9 = mild, 10-14 = moderate, 15-21 = severe
- C-SSRS: note if administered and capture stated risk category (e.g. "no ideation", "passive ideation", "active ideation with plan")

Return a JSON array of detected scales only. Example format:
[{"scale":"PHQ-9","score":14,"severity":"moderate"},{"scale":"C-SSRS","score":null,"severity":"passive ideation"}]

Return [] if no scales detected. Return ONLY the JSON array.

Transcript:
<transcript>
${safeTranscript}
</transcript>` },
        ],
        () => showToast("Switched to backup service"),
      )).trim();
      const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
      const scales = JSON.parse(cleaned) as ScaleScore[];
      if (!Array.isArray(scales) || scales.length === 0) return;
      await db.updateSession(entryId, { scaleScores: scales });
      setHistory(prev => {
        const entries = (prev[patId] ?? []).map(e =>
          e.id === entryId ? { ...e, scaleScores: scales } : e
        );
        return { ...prev, [patId]: entries };
      });
    } catch { /* silent */ }
  }

  async function generateSessionComparison(prevEntry: ReportEntry, currentRawText: string, currentEntryId: string) {
    const extractSections = (text: string): string => {
      // Match QUICK SCAN section regardless of numbering (e.g. "### 2. QUICK SCAN" or "### QUICK SCAN")
      const qs = text.match(/###\s*(?:\d+\.\s*)?QUICK SCAN[\s\S]*?(?=###\s*(?:\d+\.)?\s*[A-Z]|$)/i)?.[0] ?? "";
      // Match plan block (SOAP P section or standalone)
      const plan = text.match(/\*\*P\s*[-–]\s*Plan\*\*[\s\S]*?(?=###\s*(?:\d+\.)?|$)/i)?.[0] ?? "";
      // Match Labs/Investigations section
      const labs = text.match(/Labs\/(?:Medical Workup|Investigations)[^\n]*[\s\S]*?(?=###\s*(?:\d+\.)?|$)/i)?.[0] ?? "";
      // Match Diagnosis section
      const diag = text.match(/(?:###\s*(?:\d+\.\s*)?DIAGNOSIS|(?:\*\*(?:Primary |Probable )?Diagnosis[^*]*\*\*[^\n]*\n(?:[^\n]+\n){0,4}))/i)?.[0] ?? "";
      return [qs, plan, labs, diag].filter(Boolean).join("\n\n");
    };
    const prevDate = formatDate(prevEntry.date);
    const prevSections = extractSections(prevEntry.rawText ?? "");
    const currSections = extractSections(currentRawText);
    if (!prevSections && !currSections) return;
    try {
      const raw = await callLLMWithFallback(
        [{
          role: "user",
          content: `You are a clinical psychiatry AI assistant. Compare two consecutive sessions for the same patient.

PREVIOUS SESSION (${prevDate}):
${prevSections || "(No data)"}

CURRENT SESSION:
${currSections || "(No data)"}

Output exactly ONE line, nothing else. Format strictly:
"Since last session (${prevDate}): [clinically relevant changes — diagnosis shift, symptom change, medication change, PHQ/GAD/C-SSRS score change, risk level change]."
Be specific and clinical. Max 25 words after the colon. If no meaningful change, end with "No significant clinical change noted."
Do not add any prefix, explanation, or extra text.`,
        }],
        () => {},
      );
      let line = raw.trim().split("\n")[0].replace(/^["']|["']$/g, "");
      // Post-validation: strip false "removed X" claims if X still appears in the current report
      line = line.replace(/removed\s+(\S+)/gi, (match, term) => {
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(escapedTerm, "i").test(currentRawText) ? "" : match;
      }).replace(/\s{2,}/g, " ").trim().replace(/^[,;]\s*/, "");
      if (line) setSessionComparisons(prev => ({ ...prev, [currentEntryId]: line }));
    } catch (e) { console.error("Session comparison failed:", e); }
  }

  async function generateReport() {
    // ── Report usage limit check ──────────────────────────────
    // To grant unlimited: set unlimited=true for this user_id in Supabase report_usage table
    const reportLimit = feedbackBonusUsed ? 40 : 30;
    if (!isUnlimited && monthlyCount >= reportLimit) {
      setShowReportLimitModal(true);
      return;
    }
    if (!transcript.trim() || !selectedPatient || loading) return;
    const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) {
      setGenerateError("Transcript is too short (under 50 words). Please record or type more of the session before generating a report.");
      return;
    }
    setLoading(true); setError(""); setGenerateError("");
    setStreamingRawText(""); setReportJustReady(false); setFailedMidStream(false);
    streamingAccRef.current = ""; streamingBufRef.current = "";

    const noteFormat: NoteFormat = doctor.noteFormat ?? "SOAP";

    const section3 = noteFormat === "DAP" ? `### 3. FULL DAP DOCUMENTATION
Keep all sections concise. Use bullet points. Avoid long paragraphs.

**D - Data**
*   If a collateral transcript is provided: Split this section into two clearly labelled sub-sections — **Patient's Account** and **Collateral History (Family/Informant)**. Each sub-section follows the same rules below. Never merge them. If accounts contradict, state the contradiction explicitly.
*   Bullet points only.
*   Include Chief Complaint and key History of Present Illness.
*   MSE observations: Appearance, Behaviour, Speech, Mood (patient's words), Affect, Thought Form, Thought Content (include suicidal/homicidal ideation status explicitly — if SI present: document (1) type: passive/active/with plan/with intent; (2) ego-syntonic vs ego-dystonic quality — does the patient describe it as distressing, or as comforting/relief-seeking/a fantasy of rest?; (3) any temporal pattern or trigger), Perceptions, Cognition, Insight, Judgment — only if explicitly described.
*   **Crucial:** Explicitly document clinical signals in parentheses e.g. *(long pause)*, *(self-interruption)*, *(voice drops)*.
*   Include 2-3 direct quotes maximum, each under 15 words. Count every word.
*   Note substance use and suicidal/homicidal ideation status explicitly.
*   Note diurnal variation in mood or energy if explicitly described by the patient.
*   If anything is not explicitly stated in the transcript, write "Not documented in session".
*   Max 10 bullet points covering only clinically significant content. Maximum 150 words total.
*   Never label behaviour with clinical terms unless the patient or clinician uses that exact term.
*   **Psychological Formulation (Schema Therapy — Young):** Only if the transcript reveals patterns consistent with an early maladaptive schema (e.g. Abandonment/Instability, Mistrust/Abuse, Emotional Deprivation, Defectiveness/Shame, Social Isolation, Dependence/Incompetence, Vulnerability to Harm, Enmeshment, Failure, Subjugation, Self-Sacrifice, Unrelenting Standards, Entitlement), add ONE bullet naming the schema, its likely developmental origin as described by the patient, and how it manifests in current relational/coping patterns — strictly from what the patient said, no inference beyond the transcript. Omit this bullet entirely if no such pattern is evidenced.

**A - Assessment**
*   **Diagnosis:** State probable diagnosis clearly.
*   **Citation:** Must cite DSM-5-TR, ICD-10, or both with source names.
*   **Reasoning:** Maximum 2 sentences only. No exceptions. Include specific evidence or quotes from the conversation.
*   Never infer a diagnosis from behaviour not explicitly described in the transcript.

**P - Plan**
CRITICAL: This section is a markdown table ONLY. No prose, no quotes, no transcript text.
The table has EXACTLY THREE columns: Domain | Action | Source
Do NOT put quotes in any cell. Each row is one line only.

| Domain | Action | Source |
|--------|--------|--------|
| Medications | [action or "Not indicated"] | [clinical reference] |
| Safety/Risk Management | [action or "Not indicated"] | [clinical reference] |
| Therapy/Psychosocial | [action or "Not indicated"] | [clinical reference] |
| Labs/Medical Workup | [action; if significant weight loss/gain or purging is documented, MUST specify vitals (weight, BMI, orthostatic BP/pulse) and baseline labs (electrolytes, ECG if indicated) — may NOT say "Not indicated" in that case; otherwise "Not indicated" if not relevant] | [clinical reference] |
| Follow-up | [action or "Not indicated"] | [clinical reference] |

MANDATORY: Include ALL 5 rows above in order. Never skip a row. Write "Not indicated" if not relevant.
In the Source column, ALWAYS cite a specific clinical reference — DSM-5-TR, ICD-10-CM, Stahl's Essential Psychopharmacology, NICE Guidelines, or a named evidence-based protocol. NEVER write "Doctor", "Clinician", or "Assessment" as a source. If no published guideline exists for an item, write "Clinical judgment per [specialty] best practice".
After the table, write nothing else. Section 3 ends with the last table row.`

    : noteFormat === "BIRP" ? `### 3. FULL BIRP DOCUMENTATION
Keep all sections concise. Use bullet points. Avoid long paragraphs.

**B - Behaviour**
*   If a collateral transcript is provided: Split this section into two clearly labelled sub-sections — **Patient's Account** and **Collateral History (Family/Informant)**. Each sub-section follows the same rules below. Never merge them. If accounts contradict, state the contradiction explicitly.
*   Bullet points only.
*   Document patient's presenting behaviours, symptoms, and Chief Complaint.
*   MSE observations: Appearance, Behaviour, Speech, Mood (patient's words), Affect, Thought Form, Thought Content (include suicidal/homicidal ideation status explicitly — if SI present: document (1) type: passive/active/with plan/with intent; (2) ego-syntonic vs ego-dystonic quality — does the patient describe it as distressing, or as comforting/relief-seeking/a fantasy of rest?; (3) any temporal pattern or trigger), Perceptions, Cognition, Insight, Judgment — only if explicitly described.
*   **Crucial:** Explicitly document clinical signals in parentheses e.g. *(long pause)*, *(self-interruption)*, *(voice drops)*.
*   Include 2-3 direct quotes maximum, each under 15 words. Count every word.
*   Note substance use and suicidal/homicidal ideation status explicitly.
*   Note diurnal variation in mood or energy if explicitly described by the patient.
*   If anything is not explicitly stated in the transcript, write "Not documented in session".
*   Max 8 bullet points. Maximum 150 words total.
*   Never label behaviour with clinical terms unless the patient or clinician uses that exact term.
*   **Psychological Formulation (Schema Therapy — Young):** Only if the transcript reveals patterns consistent with an early maladaptive schema (e.g. Abandonment/Instability, Mistrust/Abuse, Emotional Deprivation, Defectiveness/Shame, Social Isolation, Dependence/Incompetence, Vulnerability to Harm, Enmeshment, Failure, Subjugation, Self-Sacrifice, Unrelenting Standards, Entitlement), add ONE bullet naming the schema, its likely developmental origin as described by the patient, and how it manifests in current relational/coping patterns — strictly from what the patient said, no inference beyond the transcript. Omit this bullet entirely if no such pattern is evidenced.

**I - Intervention**
*   Bullet points only.
*   Document all clinical interventions performed during this session.
*   Include: psychoeducation given, therapeutic techniques used, risk assessment performed, medication decisions discussed, referrals made.
*   Be specific — name the exact technique or intervention used.
*   If not performed, write "Not documented in session".

**R - Response**
*   Bullet points only.
*   Document how the patient responded to each intervention listed above.
*   Include engagement level, insight, resistance, emotional response.
*   Note any observable changes in mental state during the session.
*   Only document what is explicitly shown in the transcript.

**P - Plan**
CRITICAL: This section is a markdown table ONLY. No prose, no quotes, no transcript text.
The table has EXACTLY THREE columns: Domain | Action | Source
Do NOT put quotes in any cell. Each row is one line only.

| Domain | Action | Source |
|--------|--------|--------|
| Medications | [action or "Not indicated"] | [clinical reference] |
| Safety/Risk Management | [action or "Not indicated"] | [clinical reference] |
| Therapy/Psychosocial | [action or "Not indicated"] | [clinical reference] |
| Labs/Medical Workup | [action; if significant weight loss/gain or purging is documented, MUST specify vitals (weight, BMI, orthostatic BP/pulse) and baseline labs (electrolytes, ECG if indicated) — may NOT say "Not indicated" in that case; otherwise "Not indicated" if not relevant] | [clinical reference] |
| Follow-up | [action or "Not indicated"] | [clinical reference] |

MANDATORY: Include ALL 5 rows above in order. Never skip a row. Write "Not indicated" if not relevant.
In the Source column, ALWAYS cite a specific clinical reference — DSM-5-TR, ICD-10-CM, Stahl's Essential Psychopharmacology, NICE Guidelines, or a named evidence-based protocol. NEVER write "Doctor", "Clinician", or "Assessment" as a source. If no published guideline exists for an item, write "Clinical judgment per [specialty] best practice".
After the table, write nothing else. Section 3 ends with the last table row.`

    : noteFormat === "PIRP" ? `### 3. FULL PIRP DOCUMENTATION
Keep all sections concise. Use bullet points. Avoid long paragraphs.

**P - Problem**
*   If a collateral transcript is provided: Split this section into two clearly labelled sub-sections — **Patient's Account** and **Collateral History (Family/Informant)**. Each sub-section follows the same rules below. Never merge them. If accounts contradict, state the contradiction explicitly.
*   Bullet points only.
*   State the primary presenting problem and Chief Complaint clearly.
*   Include key symptoms, duration, and severity — only if explicitly described.
*   Include DSM-5-TR or ICD-10 probable diagnosis with citation.
*   Include 2-3 direct quotes maximum, each under 15 words. Count every word.
*   Note substance use and suicidal/homicidal ideation status explicitly — if SI present: document (1) type: passive/active/with plan/with intent; (2) ego-syntonic vs ego-dystonic quality — does the patient describe it as distressing, or as comforting/relief-seeking/a fantasy of rest?; (3) any temporal pattern or trigger.
*   Note diurnal variation in mood or energy if explicitly described by the patient.
*   If anything is not explicitly stated in the transcript, write "Not documented in session".
*   Max 6 bullet points. Maximum 120 words total.
*   Never label symptoms with clinical terms unless explicitly used in the transcript.
*   **Psychological Formulation (Schema Therapy — Young):** Only if the transcript reveals patterns consistent with an early maladaptive schema (e.g. Abandonment/Instability, Mistrust/Abuse, Emotional Deprivation, Defectiveness/Shame, Social Isolation, Dependence/Incompetence, Vulnerability to Harm, Enmeshment, Failure, Subjugation, Self-Sacrifice, Unrelenting Standards, Entitlement), add ONE bullet naming the schema, its likely developmental origin as described by the patient, and how it manifests in current relational/coping patterns — strictly from what the patient said, no inference beyond the transcript. Omit this bullet entirely if no such pattern is evidenced.

**I - Intervention**
*   Bullet points only.
*   Document all clinical interventions performed during this session.
*   Include: psychoeducation given, therapeutic techniques used, risk assessment performed, medication decisions discussed.
*   Be specific — name the exact technique or intervention.
*   If not performed, write "Not documented in session".

**R - Response**
*   Bullet points only.
*   Document patient's response to each intervention listed above.
*   Include engagement level, insight demonstrated, emotional response, resistance if any.
*   Note any observable changes in mental state during the session.
*   Only document what is explicitly shown in the transcript.

**P - Plan**
CRITICAL: This section is a markdown table ONLY. No prose, no quotes, no transcript text.
The table has EXACTLY THREE columns: Domain | Action | Source
Do NOT put quotes in any cell. Each row is one line only.

| Domain | Action | Source |
|--------|--------|--------|
| Medications | [action or "Not indicated"] | [clinical reference] |
| Safety/Risk Management | [action or "Not indicated"] | [clinical reference] |
| Therapy/Psychosocial | [action or "Not indicated"] | [clinical reference] |
| Labs/Medical Workup | [action; if significant weight loss/gain or purging is documented, MUST specify vitals (weight, BMI, orthostatic BP/pulse) and baseline labs (electrolytes, ECG if indicated) — may NOT say "Not indicated" in that case; otherwise "Not indicated" if not relevant] | [clinical reference] |
| Follow-up | [action or "Not indicated"] | [clinical reference] |

MANDATORY: Include ALL 5 rows above in order. Never skip a row. Write "Not indicated" if not relevant.
In the Source column, ALWAYS cite a specific clinical reference — DSM-5-TR, ICD-10-CM, Stahl's Essential Psychopharmacology, NICE Guidelines, or a named evidence-based protocol. NEVER write "Doctor", "Clinician", or "Assessment" as a source. If no published guideline exists for an item, write "Clinical judgment per [specialty] best practice".
After the table, write nothing else. Section 3 ends with the last table row.`

    : noteFormat === "NIMHANS" ? `### 3. FULL NIMHANS PROFORMA

CRITICAL NIMHANS RULES:
- Document ONLY what is explicitly stated in the transcript. If information is absent, write "Not documented in session" — never infer, never assume.
- Every clinical term must match the descriptive psychopathology tradition (Fish, Sims, Jaspers). Use precise terminology only.
- ICD-10 is mandatory as primary coding (Indian training standard). Add ICD-11 alongside.
- The Diagnostic Formulation is the most important section — it must be a coherent clinical narrative, not a list.

---

**SOCIODEMOGRAPHIC DATA**
*   Age: [from transcript or "Not documented in session"]
*   Sex: [from transcript or "Not documented in session"]
*   Education: [from transcript or "Not documented in session"]
*   Occupation: [from transcript or "Not documented in session"]
*   Marital status: [from transcript or "Not documented in session"]
*   Domicile/Region: [from transcript or "Not documented in session"]
*   Referral source: [from transcript or "Not documented in session"]
*   Informant & reliability: [from transcript or "Not documented in session"]

---

**CHIEF COMPLAINTS**
*   List in patient's own words, chronologically ordered with approximate duration.
*   Format: [Complaint] — "[direct quote]" — [duration]
*   Maximum 6 complaints. Only include complaints with direct or clearly paraphrased evidence in the transcript — recognise the same clinical content even if the patient's wording differs from clinical terminology (e.g. "I just can't seem to stay with anyone" = difficulty maintaining relationships).
*   DURATION RULE: The duration field reflects ONLY whether a timeframe was stated — never write "not documented in session" for duration on a line that already contains a direct quote proving the complaint itself was documented; that combination is self-contradictory and forbidden. Use:
    - An explicit duration/timeframe if the patient stated one (e.g. "2 years", "since childhood", "lifelong").
    - "duration not specified" if the complaint is clearly evidenced by a quote but no timeframe was given.
    - Do not include the complaint at all if there is no evidence for it in the transcript.

---

**HISTORY OF PRESENT ILLNESS**
*   If a collateral transcript is provided: document collateral history in a clearly labelled sub-section — **Collateral History (Family/Informant)** — immediately after the patient's own account. Never merge the two accounts. If they contradict each other, state the contradiction explicitly — it is clinically significant.
*   Onset: [insidious / acute / subacute — as stated]
*   Duration of current episode: [as stated]
*   Course: [continuous / episodic / deteriorating / improving — as stated]
*   Precipitating factors: [as stated, or "None documented"]
*   Progression of symptoms: [describe chronologically, bullet points. Recognise the same clinical content even if the patient's wording differs from textbook phrasing. CONSISTENCY RULE: if a bullet contains a direct quote as evidence, the same bullet must not also say "not documented in session" — that is self-contradictory and forbidden. If a symptom is evidenced but no duration/timeframe was stated, write "duration not specified" instead of "not documented in session".]
*   Previous episodes: [number, duration, treatment — as stated, or "None documented"]
*   Relevant biological functions:
    *   Sleep: [as stated or "Not documented in session"]
    *   Appetite/Weight: [as stated or "Not documented in session"]
    *   Libido: [as stated or "Not documented in session"]
    *   Bowel/Bladder: [as stated or "Not documented in session"]
    *   Diurnal variation: [note if mood or energy is explicitly described as better or worse at a specific time of day — morning worse/evening better is classical melancholic pattern; document explicitly if mentioned, or "Not documented in session"]

---

**PAST PSYCHIATRIC HISTORY**
*   Previous diagnoses: [as stated, or "None documented"]
*   Previous hospitalisations: [as stated, or "None documented"]
*   Previous treatments and response: [as stated, or "None documented"]
*   Current medication: [name and dose if known. If a medication is mentioned but the name is not given, write "Current medication: name not elicited — to be verified and documented at next appointment" — never omit this field entirely if a medication was referenced.]
*   History of self-harm or suicidal behaviour: [as stated, or "None documented"]. If any attempt or self-harm episode is disclosed, break it down explicitly: number of attempts, method used (if disclosed), circumstances (intent, rescue, medical attention), and current ideation status (active/passive, with/without plan, with/without means) with timeframe of most recent episode.

---

**PAST MEDICAL HISTORY**
*   Medical conditions: [as stated, or "None documented"]
*   Surgical history: [as stated, or "None documented"]
*   Head injury or seizures: [as stated, or "None documented"]
*   Current medications (non-psychiatric): [as stated, or "None documented"]
*   Allergies: [as stated, or "None documented"]

---

**FAMILY HISTORY**
*   Psychiatric illness in first-degree relatives: [as stated, or "None documented"]
*   Psychiatric illness in second-degree relatives: [as stated, or "None documented"]
*   Substance use in family: [as stated, or "None documented"]
*   Suicide in family: [as stated, or "None documented"]
*   Significant medical illness in family: [as stated, or "None documented"]
*   Family structure: [as stated, or "Not documented in session"]
*   RELATIONSHIP ACCURACY RULE: Use only the relationship terms (mother, father, cousin, adopted, foster, stepparent, etc.) explicitly used by the patient or informant in the transcript, here and in every other section of this report. Never infer, assume, or substitute a different relationship label than what was actually stated.

---

**PERSONAL HISTORY**
*   Birth and early development: [as stated, or "Not documented in session"]
*   Childhood behaviour and temperament: [as stated, or "Not documented in session". If adoption, foster care, or custody changes are disclosed, document them explicitly with ages at each transition and number of placements — this must not be folded into a generic note.]
*   Academic history: [as stated, or "Not documented in session"]
*   Occupational history: [Extract from ANYWHERE in the transcript — patient may mention job role, workplace, or work context casually rather than in response to a direct question. If mentioned anywhere, document it here. If not mentioned at all, write "Not documented in session".]
*   Psychosexual and marital history: [as stated, or "Not documented in session"]
*   Menstrual history (if applicable): [as stated, or "Not applicable / Not documented"]
*   Substance use history: [specify substance, onset, frequency, route, current status — or "None documented"]
*   Forensic history: [as stated, or "None documented"]
*   Premorbid personality: [describe baseline personality before illness — relationships, temperament, habits, religiosity, interests — as stated, or "Not documented in session"]
*   **Psychological Formulation (Schema Therapy — Young):** Only if the transcript reveals patterns consistent with an early maladaptive schema (e.g. Abandonment/Instability, Mistrust/Abuse, Emotional Deprivation, Defectiveness/Shame, Social Isolation, Dependence/Incompetence, Vulnerability to Harm, Enmeshment, Failure, Subjugation, Self-Sacrifice, Unrelenting Standards, Entitlement), name the schema, its likely developmental origin as described by the patient, and how it manifests in current relational/coping patterns — strictly from what the patient said, no inference beyond the transcript. Write "Not documented in session" if no such pattern is evidenced — do not omit the field for NIMHANS format.

---

**MENTAL STATE EXAMINATION (MSE)**

Apply descriptive psychopathology precision (Fish/Sims/Jaspers framework). Document ONLY what is explicitly observed or stated in the session. Write "Not documented in session" for anything absent. CONSISTENCY RULE: never write "Not documented in session" on a field that also contains a direct quote or paraphrased evidence for that same domain — that combination is self-contradictory and forbidden. If the domain is evidenced but a sub-detail (e.g. exact duration, trigger) is missing, name the missing detail specifically (e.g. "duration not specified") rather than defaulting to "not documented".

*   **General Appearance & Behaviour:** [dress, grooming, eye contact, psychomotor activity — agitation/retardation, rapport, cooperation]
*   **Speech:** [rate (normal/fast/slow/pressured/poverty), rhythm, volume, tone, spontaneity, latency of response]
*   **Mood (Subjective):** [patient's exact words — quote directly if under 15 words]
*   **Affect (Objective):** [range: full/restricted/blunted/flat; reactivity: reactive/congruent/incongruent; quality: euthymic/dysphoric/euphoric/anxious/labile]
*   **Thought Form:** [normal/loosening of associations/tangential/circumstantial/flight of ideas/thought block/perseveration/neologisms/formal thought disorder — only if explicitly evidenced in the transcript]
*   **Thought Content:** [preoccupations, overvalued ideas, delusions (specify type: persecutory/referential/grandiose/nihilistic/somatic), suicidal ideation (if present: document (1) type: passive/active/with plan/with intent; (2) ego-syntonic vs ego-dystonic quality — does the patient describe it as distressing, or as comforting/relief-seeking/a fantasy of rest?; (3) any temporal pattern or trigger — only if explicitly stated), homicidal ideation — only if explicitly stated. If Borderline Personality Disorder is in the differential or diagnosis: explicitly document chronic feelings of emptiness (BPD Criterion 7) here — present/absent/not elicited, with quote if present — do not leave it implied.]
*   **Perceptions:** [hallucinations (specify modality: auditory/visual/tactile/olfactory; verbal: command/commenting/2nd person/3rd person), illusions, depersonalisation, derealisation — only if explicitly stated. If Borderline Personality Disorder is in the differential or diagnosis: explicitly document transient, stress-related paranoid ideation or dissociative symptoms (BPD Criterion 9) here — present/absent/not assessed in session — every BPD case must address this explicitly.]
*   **Cognition:**
    *   Orientation: [time/place/person — as documented]
    *   Attention & Concentration: [as documented]
    *   Memory: [immediate/short-term/long-term — as documented]
    *   Abstraction: [as documented]
    *   Intelligence (estimated): [as documented]
*   **Insight:** [Use David's three-component model: (1) awareness of being ill, (2) relabelling of symptoms as pathological, (3) acceptance of need for treatment — document each component separately: present/partial/absent]
*   **Judgment:** [social judgment: intact/impaired — with example from transcript]
*   **DSM-5 criterion mapping (personality disorders only):** If a personality disorder is in the differential or diagnosis, explicitly list which DSM-5-TR criteria are met, with transcript evidence for each, and write "Criterion [X] — not assessed in session / not spontaneously reported" for any criterion not covered. Omit this line entirely if no personality disorder is being considered.

---

**PHYSICAL EXAMINATION**
*   General: [as documented, or "Not performed in session"]
*   Systemic: [as documented, or "Not performed in session"]
*   Neurological: [as documented, or "Not performed in session"]
*   Vitals: [as documented, or "Not documented in session"]

---

**INVESTIGATIONS**
*   Pending / Ordered: [list with reason, or "None ordered in session"]
*   Recent results (if discussed): [as stated, or "None documented"]
*   MEDICAL URGENCY OVERRIDE: If the transcript documents significant unintentional weight loss/gain, purging, restriction, or any other eating-disorder-pattern behaviour, this is a potential medical emergency regardless of psychiatric severity. State explicitly here: physical exam with vitals (weight, BMI, orthostatic blood pressure/pulse, temperature) and baseline labs (electrolytes, ECG if purging or rapid weight change is significant) are required before or at the next appointment. This line is mandatory whenever such a pattern is documented and may NOT be downgraded to "Not indicated" by any other section.

---

**DIAGNOSTIC FORMULATION**
This is the clinical heart of the NIMHANS proforma. Write a coherent narrative paragraph (not a list) structured around the four Ps. Be specific, use clinical evidence from the transcript, and apply India-first diagnostic framework.

*Predisposing factors:* [biological, psychological, social vulnerability factors — from transcript only]
*Precipitating factors:* [specific stressors or triggers that initiated or worsened the current episode — from transcript only]
*Perpetuating factors:* [factors maintaining the illness — poor adherence, ongoing stressors, family dynamics — from transcript only]
*Protective factors:* [factors reducing risk or aiding recovery — family support, insight, treatment adherence — from transcript only]

Concluding formulation sentence: "In summary, this is a [age] [sex] patient with [predisposing background] who presents with [core clinical syndrome] precipitated by [trigger], maintained by [perpetuating factors], with [protective factors]. The presentation is most consistent with [diagnosis]."

RULE: Write "Not documented in session" for any P-factor not evidenced in the transcript. Do not infer.

---

**DIAGNOSIS**
*   **Primary Diagnosis:**
    *   ICD-10: [code] — [full name]
    *   ICD-11: [code] — [full name]
    *   DSM-5-TR: [code] — [full name]
*   **Comorbid Diagnoses (list every one identified — do not omit; this includes eating disorders, ADHD, substance use disorders, or any other comorbid condition documented in the transcript):**
    *   [Diagnosis] — ICD-10: [code], ICD-11: [code], DSM-5-TR: [code] — [full name, or "None documented" if genuinely none]
    *   CODING SAFEGUARD: Some conditions (e.g. Complex PTSD, Prolonged Grief Disorder, Gaming Disorder) exist only in ICD-11 and have no DSM-5-TR or ICD-10 equivalent. NEVER invent a code for a system that does not classify that condition — instead write "No ICD-10/DSM-5-TR equivalent code exists" for that line. A fabricated-looking code is worse than an honestly missing one.
    *   EVIDENCE THRESHOLD: Do not assign a full triple-coded diagnosis based on a single unverified self-report line with no corroborating detail elsewhere in the transcript (e.g. MSE findings, functional impairment, symptom history). If the only evidence is one self-reported label (e.g. "I have ADHD"), list it as "Reported diagnosis (per patient self-report, not independently corroborated in this session): [condition] — formal diagnostic confirmation recommended" rather than assigning full ICD-10/ICD-11/DSM-5-TR codes.
*   **Eating disorder rule:** If the patient describes disordered eating behaviour (restriction, bingeing, purging, compulsive exercise) together with a weight change, this MUST be documented as a comorbid diagnosis here (minimum: Unspecified Feeding or Eating Disorder, with triple coding) — it must also appear as a row in the Management Plan table below. Do not document disordered eating only in History and omit it from Diagnosis.
*   **Differential Diagnoses:** For each differential, give all three codes, points in favour (with transcript quotes), points against, and why the primary diagnosis is preferred.
    *   [Diagnosis 1] — ICD-10: [code], ICD-11: [code], DSM-5-TR: [code]. Points in favour: [from transcript]. Points against: [from transcript]. Why primary preferred: [reasoning].
    *   [Diagnosis 2 if applicable] — same format.
    *   Mandatory differential — Complex PTSD: whenever the transcript documents prolonged childhood trauma, abuse, or neglect, Complex PTSD MUST be worked through in full as a differential — never dismissed in one line, even if ultimately not the primary diagnosis. CODING NOTE: Complex PTSD exists only in ICD-11 (6B41), not in ICD-10 or DSM-5-TR. For this differential only, cite ICD-11: 6B41 and explicitly state "No DSM-5-TR equivalent code exists; DSM-5-TR classifies this under PTSD (309.81) if criteria are met, or as a clinical formulation rather than a coded diagnosis." Do NOT invent or assign a DSM-5-TR code to Complex PTSD itself.
    *   Mandatory differential — Bipolar II Disorder: whenever hypomanic/manic features are described anywhere in the transcript, Bipolar II MUST be worked through in full as a differential using the format above.
*   **Rule out:** [any diagnosis that must be excluded before confirming primary — with reason]
*   **Family heritability comment:** If a first- or second-degree relative documented in Family History shares the same diagnosis (or a closely related one) as the patient, explicitly state this here, e.g. "Family history of [relative]'s [diagnosis] supports genetic loading for this presentation." If no shared diagnosis is documented, omit this line.

---

**MANAGEMENT PLAN**
CRITICAL: This section is a markdown table ONLY. No prose, no quotes, no transcript text.
The table has EXACTLY THREE columns: Domain | Action | Source

| Domain | Action | Source |
|--------|--------|--------|
| Medications | [specific drug + dose + titration schedule, or "Not indicated"] | [Stahl's / Maudsley / APA / NICE / Resident's Atlas of Psychiatric Prescribing] |
| Safety/Risk Management | [specific plan including means restriction counselling if any ideation, or "Not indicated"] | [APA Practice Guidelines / NIMHANS protocol / C-SSRS framework] |
| Therapy/Psychosocial | [exact modality + rationale + India-available resource, or "Not indicated"] | [NICE Guidelines / APA Guidelines / CBT/DBT/IPT evidence base] |
| Eating Disorder | [if disordered eating + weight change documented: severity assessment, dietitian/specialist referral, weight/vitals monitoring plan — specific to this case; if not present, "Not indicated"] | [NICE Eating Disorder Guidelines / APA] |
| Labs/Medical Workup | [specific test + reason + timing; if significant weight loss/gain or purging is documented anywhere in this transcript, this row MUST specify vitals (weight, BMI, orthostatic BP/pulse) and baseline labs (electrolytes, ECG if indicated) — it may NOT say "Not indicated" in that case. Otherwise, "Not indicated" if genuinely not relevant.] | [Clinical judgment per psychiatry best practice] |
| Family Psychoeducation | [specific content covered or to be covered — family involvement is standard in Indian psychiatry; refer to family members only using relationships/terms explicitly stated in the transcript (do not invent or assume a relationship, e.g. "adopted," "estranged," "stepfather" unless the patient used that term) — or "Not indicated"] | [NIMHANS family intervention protocol] |
| Follow-up | [specific timeframe + purpose + what to monitor, or "Not indicated"] | [Clinical judgment per NIMHANS outpatient protocol] |

MANDATORY: Include ALL 7 rows above in order. Never skip a row. Write "Not indicated" if genuinely not relevant.
Source column must always cite a named reference. FORBIDDEN in Action column: "Monitor symptoms", "Continue coping strategies", "As clinically indicated", "Encourage engagement", "Per clinical judgment" alone — these are not plans.
RULE: If a comorbid eating disorder is documented in DIAGNOSIS, the Eating Disorder row above is MANDATORY and must contain a specific plan, not "Not indicated".`

    : /* SOAP (default) */ `### 3. FULL SOAP DOCUMENTATION
Keep all sections concise. Use bullet points. Avoid long paragraphs.

**S - Subjective**
*   If a collateral transcript is provided: Split this section into two clearly labelled sub-sections — **Patient's Account** and **Collateral History (Family/Informant)**. Each sub-section follows the same rules below. Never merge them. If accounts contradict, state the contradiction explicitly.
*   Bullet points only. Every single line MUST start with * — no plain sentences, no paragraphs, no exceptions.
*   Include Chief Complaint (CC) and key History of Present Illness (HPI).
*   **Crucial:** Explicitly document clinical signals in parentheses, e.g., *(long pause)*, *(self-interruption)*.
*   **Evidence:** Include 2-3 key direct quotes maximum, each under 15 words. Quotes go HERE and NOWHERE ELSE.
*   Note substance use and suicidal/homicidal ideation status.
*   Note diurnal variation in mood or energy if explicitly described by the patient.
*   Max 8 bullet points covering only the most clinically significant content.
*   **Psychological Formulation (Schema Therapy — Young):** Only if the transcript reveals patterns consistent with an early maladaptive schema (e.g. Abandonment/Instability, Mistrust/Abuse, Emotional Deprivation, Defectiveness/Shame, Social Isolation, Dependence/Incompetence, Vulnerability to Harm, Enmeshment, Failure, Subjugation, Self-Sacrifice, Unrelenting Standards, Entitlement), add ONE bullet naming the schema, its likely developmental origin as described by the patient, and how it manifests in current relational/coping patterns — strictly from what the patient said, no inference beyond the transcript. Omit this bullet entirely if no such pattern is evidenced.

**O - Objective**
*   Bullet points only. Every single line MUST start with * — no plain sentences, no paragraphs, no exceptions.
*   Brief MSE notes covering: Appearance, Behaviour, Speech, Mood (patient's words), Affect, Thought Form, Thought Content (include suicidal/homicidal ideation status explicitly — if SI present: document (1) type: passive/active/with plan/with intent; (2) ego-syntonic vs ego-dystonic quality — does the patient describe it as distressing, or as comforting/relief-seeking/a fantasy of rest?; (3) any temporal pattern or trigger), Perceptions, Cognition, Insight, Judgment.
*   Only document what is explicitly stated or observed in the session.
*   Write "Not documented in session" for anything absent.

**A - Assessment**
*   **Diagnosis:** State probable diagnosis clearly.
*   **Citation:** Must cite DSM-5-TR, ICD-10, or other standard manuals.
*   **Reasoning:** Max 2 sentences. Include specific evidence from the conversation. NO direct quotes here.

**P - Plan**
CRITICAL: This section is a markdown table ONLY. No prose, no quotes, no transcript text.
The table has EXACTLY THREE columns: Domain | Action | Source
Do NOT add a fourth column. Do NOT put quotes in any cell. Each row is one line only.

| Domain | Action | Source |
|--------|--------|--------|
| Medications | [action or "Not indicated"] | [clinical reference] |
| Safety/Risk Management | [action or "Not indicated"] | [clinical reference] |
| Therapy/Psychosocial | [action or "Not indicated"] | [clinical reference] |
| Labs/Medical Workup | [action; if significant weight loss/gain or purging is documented, MUST specify vitals (weight, BMI, orthostatic BP/pulse) and baseline labs (electrolytes, ECG if indicated) — may NOT say "Not indicated" in that case; otherwise "Not indicated" if not relevant] | [clinical reference] |
| Follow-up | [action or "Not indicated"] | [clinical reference] |

MANDATORY: Include ALL 5 rows above in order. Never skip a row. Write "Not indicated" if not relevant.
In the Source column, ALWAYS cite a specific clinical reference — DSM-5-TR, ICD-10-CM, Stahl's Essential Psychopharmacology, NICE Guidelines, or a named evidence-based protocol. NEVER write "Doctor", "Clinician", or "Assessment" as a source. If no published guideline exists for an item, write "Clinical judgment per [specialty] best practice".
After the table, write nothing else. No quotes, no summary, no extra text. Section 3 ends with the last table row.`;

    const systemPrompt = `ABSOLUTE RULES — violation makes this output clinically dangerous and unusable:

1. NEVER invent, infer, or assume ANY clinical detail not explicitly stated in the transcript.
2. If a symptom, behaviour, medication, lab result, or clinical observation is not directly spoken about in the transcript, write "Not documented in session" — never leave it blank, never guess.
3. DEMOGRAPHICS — CRITICAL: Never state or infer patient age, gender, or name unless the exact value appears verbatim in the transcript or the user message. If the transcript does not confirm age or gender, write "Not documented in session" for those fields. A patient name alone is never evidence of gender.
4. Do NOT add a disclaimer, footer, or any text after the SUMMARY section (### 5. SUMMARY for SOAP/DAP/BIRP/PIRP formats, ### 6. SUMMARY for NIMHANS Proforma format). The report ends with the one-sentence summary. Nothing after it.
5. PRIORITY FLAG: Include ONLY when the Risk Assessment Overall Level (section 4) is High or Critical — meaning there is explicit risk of harm to self or others. Specifically: active suicidal ideation (with or without plan), passive suicidal ideation co-occurring with a past suicide attempt, passive ideation with stated intent or access to means, active homicidal ideation, or active command hallucinations directing violence. Do NOT include for Low or Moderate risk, for general psychiatric distress, for non-risk instability, or for any reason other than harm risk. If included, the PRIORITY FLAG section contains EXACTLY ONE line — the flag itself. No explanation, no sub-bullets, no extra text in that section.
6. PLAN TABLE — "Not indicated" vs specific action: Write "Not indicated" ONLY when a domain is genuinely absent from the session with no clinical need. When action IS indicated, write a specific, named intervention — exact medication + starting dose + titration from Stahl's/APA/NICE, or exact therapy modality + rationale, or exact lab + reason. Generic filler such as "Monitor symptoms", "Continue coping strategies", "As clinically indicated", or "Encourage engagement" is NOT a plan entry and must never appear in the Plan table. Source column must always cite a named reference: DSM-5-TR, ICD-10-CM, Stahl's Essential Psychopharmacology, NICE Guidelines, APA Practice Guidelines, Taylor's Prescribing Guidelines, Maudsley Prescribing Guidelines, or Resident's Atlas of Psychiatric Prescribing (Weave).

═══════════════════════════════════════════════════════════════
INDIA-FIRST CLINICAL KNOWLEDGE BASE (Weave Library + NIMHANS)
═══════════════════════════════════════════════════════════════

DIAGNOSTIC FRAMEWORK — ICD-11 FIRST, DSM-5-TR CROSS-REFERENCE:
Always code to ICD-11 (mandatory in India post-2022 MoHFW directive). Cross-reference DSM-5-TR where it aids clinical clarity.
- ICD-11 uses dimensional qualifiers: severity (mild/moderate/severe), course specifiers, psychotic features, and functional impact — always capture these when documented.
- ICD-11 key changes from ICD-10 to flag in Assessment: "Schizophrenia" now requires functional decline; "Recurrent depressive disorder" replaces "F33"; "PTSD" is now distinct from "Complex PTSD" (6B40 vs 6B41); "Prolonged grief disorder" is a new category (6B42); "Gaming disorder" formalised (6C51).
- Dual coding tip: when ICD-10 and ICD-11 diverge in clinical implication (e.g., personality disorders — ICD-11 replaces categorical types with dimensional severity + prominent trait qualifiers), note both in Assessment.

DESCRIPTIVE PSYCHOPATHOLOGY — MSE PRECISION (Fish, Sims, Jaspers framework):
Apply the classical descriptive tradition to the O section. Distinguish:
- FORM (how the experience occurs) from CONTENT (what is believed/experienced) — form is diagnostically more significant (Jaspers).
- PRIMARY symptoms: arise autonomously without psychological context (e.g., primary delusions, thought insertion) — diagnostically weighty, flag explicitly.
- SECONDARY symptoms: psychologically comprehensible reactions (e.g., anxiety after bereavement) — label as secondary.
- Rigidity of terminology: use "persecutory ideation" not "paranoia"; "auditory verbal hallucinations" not "voices"; "formal thought disorder" only when form (not content) is disturbed; "blunted affect" vs "flat affect" vs "restricted affect" per Fish criteria.
- Catatonic features: always screen for and name specifically — waxy flexibility (cerea flexibilitas), gegenhalten/paratonia, posturing, negativism, mutism, echolalia, echopraxia, stereotypy. Catatonia is under-recognised in India.
- Insight: document using David's three-component model (awareness of illness, relabelling of symptoms, compliance with treatment) — not simply "insight present/absent".
- Continuous vs discontinuous psychopathology: mood/anxiety/OCD spectrum = continuous (dimensional, comprehensible); psychotic phenomena = discontinuous (qualitative break, Jaspers' "ununderstandability") — flag which framework applies in Assessment reasoning.

PRESCRIBING — INDIA-FIRST LENS (Resident's Atlas of Psychiatric Prescribing, Weave; Maudsley 14th Ed; Taylor's 15th Ed):
When documenting medication plans, apply these India-specific constraints:

DCGI-APPROVED & COMMONLY AVAILABLE in India (as of 2025):
  Antipsychotics: Olanzapine, Risperidone, Quetiapine, Aripiprazole, Clozapine, Haloperidol, Amisulpride, Paliperidone (oral + monthly LAI), Ziprasidone (limited availability)
  Antidepressants: Escitalopram, Sertraline, Fluoxetine, Paroxetine, Mirtazapine, Venlafaxine, Duloxetine, Amitriptyline, Clomipramine, Imipramine
  Mood stabilisers: Lithium carbonate (widely available, serum level monitoring essential), Sodium valproate/Divalproex, Carbamazepine, Lamotrigine
  Anxiolytics/Hypnotics: Clonazepam, Lorazepam, Diazepam, Alprazolam (NDPS Schedule H1 — require special prescription pad in some states)
  Anticholinergics: Trihexyphenidyl (THP), Benztropine (less common)
  Cognitive: Donepezil, Rivastigmine patch, Memantine

NDPS ACT SCHEDULING — always note when relevant:
  Schedule H1 (special prescription required, records maintained): Alprazolam, Clonazepam, Lorazepam, Diazepam, Nitrazepam, Zolpidem, Tramadol, Buprenorphine
  NDPS (narcotic/psychotropic licence required): Morphine, Methadone, Buprenorphine (high-dose OAT)
  Note: Benzodiazepine prescriptions in India are legally limited to 30 days' supply per prescription in most states.

DOSING — INDIA CONTEXT (start low in treatment-naive Indian patients; metaboliser differences documented):
  Escitalopram: 5–10mg start → 20mg target (depression); 10mg start → 20mg target (anxiety/OCD up to 20mg)
  Sertraline: 25–50mg start → 100–200mg target
  Olanzapine: 5mg start → 10–20mg; note metabolic risk high in Indian patients (document baseline weight, FBS, lipids)
  Risperidone: 1mg start → 4–6mg; higher EPS risk at >6mg in Indian patients
  Quetiapine: 25mg nocte start (sleep/anxiety adjunct) → 300–600mg (psychosis/mania)
  Lithium: 400mg BD start → target serum level 0.6–1.0 mEq/L (acute mania: 0.8–1.2); baseline: TFT, RFT, ECG, CBC
  Clozapine: mandatory ANC monitoring (baseline >2000/mm³, weekly ×18 weeks then fortnightly); only via registered centre in India
  Aripiprazole: 10mg start → 15–30mg; lowest metabolic risk of SGAs, preferred in metabolic syndrome
  Sodium valproate: 500mg BD start → 1000–2000mg/day; TERATOGENIC — mandatory pregnancy counselling in women of reproductive age; document explicitly if prescribed

COMMON INDIA-SPECIFIC CLINICAL SCENARIOS TO DOCUMENT PRECISELY:
  1. Alcohol Use Disorder (AUD) — highly prevalent; note CIWA score if documented; specify detox protocol (chlordiazepoxide taper preferred in India: 50mg QID Day 1 → taper over 7–10 days); Wernicke's prophylaxis (thiamine 100mg IM/IV ×3 days then oral) — document explicitly if risk present
  2. Cannabis-related disorders — high prevalence in youth; specify THC-dominant (psychosis risk) vs CBD-dominant; document duration, frequency, route
  3. Treatment-resistant depression — after 2 adequate antidepressant trials; document augmentation: lithium augmentation (evidence grade A), aripiprazole augmentation (10–15mg), olanzapine-fluoxetine combination; ECT referral pathway
  4. Medication-overuse headache — common comorbidity missed in psychiatric notes; document analgesic/triptan use
  5. Metabolic monitoring — mandatory with SGAs; document at every visit: weight, BMI, BP, FBS/HbA1c, fasting lipids (at baseline, 3M, 6M then annually)
  6. ECT — available in India (both public and private); indicated for: severe depression with psychosis/suicidality/refusal to eat, acute mania unresponsive to pharmacotherapy, malignant catatonia (lorazepam-refractory), NMS (supportive + ECT). Document if discussed or indicated.

HYPERTHERMIC-RIGID EMERGENCY DIFFERENTIAL (Weave Aporia 05 — for any rigid/febrile presentation on psychotropics):
Four syndromes share rigidity + hyperthermia + altered consciousness + autonomic instability:
  NMS (Neuroleptic Malignant Syndrome): dopamine D2 blockade → lead-pipe rigidity (velocity-independent, all directions), CK markedly elevated (>4× ULN), leukocytosis, LOW serum iron. Onset 1–3 days. Stop antipsychotic. Bromocriptine 2.5mg TDS + lorazepam; dantrolene largely unavailable in India — lean on bromocriptine + supportive care + ECT.
  Malignant Catatonia (MC): GABA deficit → waxy flexibility/posturing/gegenhalten/negativism, LOW serum iron (shared with NMS). LORAZEPAM CHALLENGE (2mg IV/IM) is diagnostic AND therapeutic — partial/full response confirms catatonia. If refractory → ECT (same-week access realistic in India — an advantage). NEVER give antipsychotic to an undiagnosed rigid patient — can worsen MC fatally.
  Serotonin Syndrome (SS): 5-HT excess → clonus (especially lower-limb), hyperreflexia, ocular clonus, agitation, diarrhoea. Onset within 24h of serotonergic drug. Hunter criteria diagnostic. Remove serotonergic agents. Cyproheptadine 12mg loading then 2mg Q2H (available in India as antihistamine).
  EPS Mimics: drug-induced parkinsonism (cogwheel rigidity, no fever), acute dystonia (focal, dramatic, painful — biperiden/trihexyphenidyl). No systemic instability.
  KEY DISCRIMINATOR: Lorazepam challenge — partial/full improvement = catatonia/MC. No response = NMS/SS more likely. Serum iron low in both NMS and MC (not SS). Clonus = SS fingerprint. CK >4× ULN = NMS fingerprint.

PSYCHOTHERAPY — INDIA-AVAILABLE MODALITIES:
  CBT: widely available; document specific protocol if mentioned (e.g., Beckian CBT for depression; ERP for OCD; trauma-focused CBT for PTSD; CT-SAD for social anxiety)
  Motivational Interviewing (MI): first-line for substance use; note stage of change (precontemplation/contemplation/preparation/action/maintenance)
  Family psychoeducation: essential in Indian context — high family involvement in care; document explicitly if provided
  IPT: available in metro centres; indicated for depression with interpersonal focus
  SFT (Schema Focused Therapy) / DBT: available in specialist centres; note if BPD or complex trauma presentation
  Psychoeducation: always document — diagnosis explanation, medication rationale, early warning signs

RISK ASSESSMENT — INDIA-SPECIFIC FACTORS:
  C-SSRS: document ideation type (passive wish to die → active ideation → ideation with plan → intent → behaviour) — this progression maps to Low/Moderate/High/Critical.
  India-specific elevating factors: male sex, rural isolation, recent agricultural/financial debt crisis exposure, recent family honour conflict, access to pesticides/organophosphates (highly lethal method — elevates risk category), alcohol intoxication, recent bereavement.
  India-specific mitigating factors: strong family support structure (protective in Indian context), religious/spiritual beliefs, treatment adherence, social connectedness.
  Mandatory documentation: always note whether means restriction counselling was provided if any ideation documented.

BIPOLAR SPECTRUM DOCUMENTATION — when hypomanic or manic episodes are described in the transcript:
- Document episode duration explicitly. Threshold: ≥4 days = hypomanic episode; ≥7 days OR hospitalisation OR marked functional impairment = manic episode (Bipolar I threshold).
- List all behaviours from the transcript that map to DSM-5-TR/ICD-11 hypomanic/manic criteria: decreased need for sleep, grandiosity, talkativeness, racing thoughts, distractibility, increased goal-directed activity, reckless behaviour (specify type: spending/driving/sexual/substance use).
- This characterisation is MANDATORY when the differential includes any bipolar spectrum diagnosis. Bipolar I vs Bipolar II distinction directly changes pharmacological management — specifically, antidepressant safety differs between the two. Document sufficient episode data to support the distinction.

COMORBIDITY RULE — applies to ALL note formats:
If a comorbid diagnosis is documented anywhere in the report (e.g., alcohol use disorder, anxiety disorder, medical condition), a corresponding row or sub-item in the Management Plan table is MANDATORY for that comorbidity. A comorbid diagnosis that has no corresponding management action is clinically incomplete and must not be left without a plan entry.

═══════════════════════════════════════════════════════════════

You are an expert AI assistant for a clinical psychiatrist with 15+ years of experience, trained on India-first psychiatry resources including the Weave Library (ICD-11 coding, descriptive psychopathology, prescribing atlas) and NIMHANS clinical guidelines. Your goal is to reduce post-visit documentation time by providing concise, high-yield clinical summaries that a practicing Indian psychiatry resident would be proud to sign.
Input: Patient-doctor conversation transcript. Output Structure: Strictly follow the format below. Do not add introductory or concluding conversational text.

CRITICAL CONSTRAINTS — these are hard rules, not guidelines. Violating any of them makes the output clinically unusable:
- S section: maximum 8 bullet points, maximum 150 words total. Count your words before outputting.
- Direct quotes: maximum 3, each must be under 15 words. Count every word in every quote.
- O section: write "Not documented in session" for ANYTHING not explicitly stated in the transcript. Never infer, never assume.
- A section reasoning: maximum 2 sentences. No exceptions.
- Summary (section 5): exactly ONE sentence. No exceptions.
- Never add clinical findings not explicitly stated in the transcript. Do not label something "anhedonia," "negative symptoms," "social withdrawal," or any other clinical term unless the patient or clinician uses that exact term or describes it directly.
- Clinical signals in S section must use parenthetical notation inline: (long pause), (self-interruption), (voice drops), (rubs hands).

### 1. PRIORITY FLAG
Condition: Include ONLY when Risk Assessment Overall Level is High or Critical. This means explicit risk of harm: active suicidal ideation (with or without plan), passive suicidal ideation + past suicide attempt (always High/Critical — never suppress this combination), passive ideation with stated intent or access to means, active homicidal ideation, or active command hallucinations directing violence. Do NOT include for Low or Moderate risk. Do NOT include for general distress, agitation, or psychiatric symptoms without harm risk.
Format: Exactly ONE line. Bolded. Example: **⚠ PRIORITY FLAG:** (high) Active suicidal ideation with plan stated.
This section must contain ONLY this one line. No additional text. No risk summary here — that belongs in section 4.
If no risk / Low or Moderate level: Omit this section entirely. Do not write "No priority flag" or any placeholder.

### 2. QUICK SCAN
Goal: A rapid executive summary for immediate decision-making.
Format: STRICTLY bullet points only. Every single item MUST start with "- ". No paragraphs. No prose. No running text.
Output EXACTLY in this bullet format:
- **Probable Diagnosis:** [diagnosis]
- **Key Clinical Signals/Symptoms:** [symptoms]
- **Immediate Action Plan:**
  - Medications: [specific drug + dose + source, or "Not indicated" if truly absent]
  - Safety/Risk Management: [specific plan + source, or "Not indicated" if truly absent]
  - Therapy/Psychosocial: [specific modality + rationale + source, or "Not indicated" if truly absent]
  - Labs/Medical Workup: [specific test + reason + source, or "Not indicated" if truly absent]
  - Follow-up: [specific timeframe + purpose, or "Not indicated" if truly absent]
- PLAN CONSTRAINT: Generic phrases like "Monitor symptoms", "Continue coping strategies", "As clinically indicated" are FORBIDDEN here. Write a real specific action or write "Not indicated".
- If a patient makes a statement that could indicate suicidal ideation (even passive), treat it as risk-relevant and flag it explicitly in both Quick Scan and Risk Assessment.
- Scale Scores (always include if present): Scan the transcript for PHQ-9, GAD-7, and C-SSRS scores — stated directly or computable from individual items read aloud. If detected, add a bullet: e.g. "- **Scale Scores:** PHQ-9: 14 (moderate), GAD-7: 11 (moderate), C-SSRS: passive ideation". If none detected, omit this item entirely.
- **Validated Scales Recommended:** List at least 2-3 validated assessment scales appropriate to this presentation (e.g. PHQ-9, GAD-7, C-SSRS, YMRS, PANSS, EDE-Q, PCL-5, ASRS) with a brief rationale for each, e.g. "- **Validated Scales Recommended:** PHQ-9 (quantify depressive severity), C-SSRS (structured risk stratification given passive ideation)". Choose scales that match the working diagnosis and clinical signals, not a generic default set.
CRITICAL: Do NOT merge any of the above into a paragraph. Each item must be its own bullet line starting with "- ".

${section3}

### ${noteFormat === "NIMHANS" ? "4" : "4"}. RISK ASSESSMENT
Elevating Factors: bullet list — only factors explicitly supported by the transcript
Mitigating Factors: bullet list
Overall Level: Low / Moderate / High / Critical
Rationale: 1–2 sentences maximum.

### ${noteFormat === "NIMHANS" ? "5" : "5"}. SUMMARY
One single sentence only. State the core clinical problem and the primary action being taken. No second sentence. No exceptions.`;

    const safeTranscript = stripPatientPII(transcript, selectedPatient.name);

    // ── Connective reporting: inject previous session as background context ──
    const prevSessions = history[selectedId!] ?? [];
    const prevEntry = prevSessions[0];
    const previousContext = prevEntry?.rawText
      ? `\n\nPREVIOUS SESSION CONTEXT (${formatDate(prevEntry.date)}):\nUse this as clinical background only for continuity in Assessment and Plan sections. Do NOT repeat it verbatim. Do NOT copy diagnoses or findings from it unless they are also supported by the current transcript. Always prioritise what is explicitly stated in the current session transcript.\n<previous_session>\n${prevEntry.rawText.slice(0, 1500)}\n</previous_session>`
      : "";

    const userMessage = (() => {
      const safeCollateralTranscript = collateralTranscript.trim()
        ? stripPatientPII(collateralTranscript, selectedPatient.name)
        : "";

      const collateralSection = safeCollateralTranscript
        ? `\n\nCOLLATERAL / FAMILY INTERVIEW Transcript (recorded separately after patient left the room):\n<collateral_transcript>\n${safeCollateralTranscript}\n</collateral_transcript>\n\nIMPORTANT: Information from the collateral interview must be documented SEPARATELY from the patient's own account. In the Subjective section (or equivalent in the note format), create two clearly labelled sub-sections:\n  • "Patient's Account" — what the patient reported themselves\n  • "Collateral History (Family/Informant)" — what the family member reported\nNever merge these two accounts. If they contradict each other, note the contradiction explicitly — it is clinically significant.`
        : "";

      const isDialogue = safeTranscript.includes("Doctor:") || safeTranscript.includes("Patient:");

      const transcriptSection = isDialogue
        ? `CURRENT SESSION Transcript (recorded conversation between doctor and patient):\n<transcript>\n${safeTranscript}\n</transcript>`
        : `DOCTOR'S DICTATED NOTES (rough clinical summary spoken by the doctor after or during the session — treat as the clinician's own account of the consultation, not a recorded dialogue):\n<transcript>\n${safeTranscript}\n</transcript>\n\nIMPORTANT: Since this is dictated by the doctor rather than a recorded session, populate the report using the doctor's stated observations and clinical findings directly. Do not expect patient quotes. Where the doctor has noted findings, document them confidently. Where information is genuinely absent from the dictation, write "Not documented in session."`;

      return `Patient: [Patient], ${selectedPatient.age ? selectedPatient.age + ' y/o' : 'age not documented'} ${selectedPatient.gender ?? 'gender not documented'}${previousContext}\n\n${transcriptSection}${collateralSection}`;
    })();

    try {
      const rawText = await callLLMWithFallback(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        () => showToast("Switched to backup service"),
        {
          onChunk: (chunk: string) => {
            if (chunk === "\x00RESET\x00") {
              streamingAccRef.current = "";
              streamingBufRef.current = "";
              setStreamingRawText("");
              return;
            }
            streamingAccRef.current += chunk;
            streamingBufRef.current += chunk;
            const buf = streamingBufRef.current;
            // Flush at section boundary (\n\n or start of a new ### heading)
            const sectionBreak = buf.lastIndexOf("\n\n");
            if (sectionBreak !== -1 && streamingAccRef.current.length > 120) {
              streamingBufRef.current = buf.slice(sectionBreak + 2);
              setStreamingRawText(
                streamingAccRef.current.slice(0, streamingAccRef.current.length - streamingBufRef.current.length)
              );
            }
          },
        }
      );

      // Strip any AI-generated disclaimer that leaked into the report body.
      // Use aggressive multi-line removal — the regex must handle disclaimers
      // that appear mid-text (not just at end of string).
      const cleanedRawText = rawText
        .replace(/Smart Documentation:[\s\S]*?(?=\n###|\n##|$)/gi, "")
        .replace(/This report was generated[\s\S]*?(?=\n###|\n##|$)/gi, "")
        .replace(/Do not rely solely on this output[\s\S]*?(?=\n###|\n##|$)/gi, "")
        // Remove any lingering disclaimer sentence fragments
        .replace(/Always apply your professional judgment[\s\S]*?(?=\n|$)/gi, "")
        // Remove doubled SOAP sub-sections: detect second occurrence of O/A/P headers after P-Plan table
        .replace(/((?:\|\s*Follow-up[^\n]*\n)(?:\|[-\s|]+\n)?)\s*\n+\*\*O\s*[-–][^*]+\*\*[\s\S]*/i, "$1")
        .trim();

      const rawEntry = await db.createSession(selectedId!, {
        date:       new Date().toISOString(),
        transcript,
        rawText:    cleanedRawText,
        collateralTranscript: collateralTranscriptRef.current || undefined,
      });
      const entry = { ...rawEntry, report: parseReport(cleanedRawText) };

      // ── Increment report usage counter ────────────────────────
      const currentMonthKey = new Date().toISOString().slice(0, 7);
      const newMonthlyCount = monthlyCount + 1;
      const newLifetimeCount = reportCount + 1;
      setMonthlyCount(newMonthlyCount);
      setReportCount(newLifetimeCount);
      try {
        localStorage.removeItem(`psych_draft_${doctorId}_${selectedId}`);
        // The session was "new" (no activeEntryId) right up until db.createSession
        // returned above — so the draft it was actually saved under is keyed by
        // this session's unique token, not a generic "_new" string.
        localStorage.removeItem(`psych_collateral_draft_${doctorId}_${selectedId}_${newSessionTokenRef.current}`);
      } catch (_) {}
      setDraftBanner(false);
      // Always persist monthly count to localStorage immediately (works even if DB columns missing)
      try { localStorage.setItem(`psych_monthly_${doctorId}`, JSON.stringify({ month_key: currentMonthKey, monthly_count: newMonthlyCount })); } catch (_) {}
      // Try full upsert (works once DB columns exist); fall back to basic columns on error
      supabase.from("report_usage").upsert(
        { user_id: doctorId, count: newLifetimeCount, monthly_count: newMonthlyCount, month_key: currentMonthKey, feedback_bonus_used: feedbackBonusUsed },
        { onConflict: "user_id" }
      ).then(({ error }) => {
        if (error) {
          // New columns not in DB yet — upsert only known columns
          supabase.from("report_usage").upsert(
            { user_id: doctorId, count: newLifetimeCount, feedback_bonus_used: feedbackBonusUsed },
            { onConflict: "user_id" }
          ).then();
        }
      });

      // Save full entry to a module-level ref BEFORE setting state
      // so any concurrent Realtime update cannot overwrite it.
      const authorativeEntry = { ...entry };
      setHistory(prev => {
        const existingArr = prev[selectedId!] ?? [];
        // Deduplicate: if Realtime INSERT fired before this setHistory ran,
        // the entry might already be in state (but with empty/truncated rawText).
        // Always replace with our authoritative local version which has the full parsed report.
        const filtered = existingArr.filter(e => e.id !== authorativeEntry.id);
        const next = { ...prev, [selectedId!]: [authorativeEntry, ...filtered] };
        return next;
      });
      // Set active entry ID after a short delay so the history state update
      // settles first — prevents the report panel from reading a stale/empty entry.
      await new Promise(r => setTimeout(r, 80));
      setStreamingRawText(""); // clear live preview — full report takes over
      setActiveEntryId(authorativeEntry.id);
      setTranscript("");
      setReportJustReady(true);
      setTranscriptOpen(false); // auto-collapse transcript panel — report needs the space
      setTimeout(() => setReportJustReady(false), 5000);
      const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
      void (async () => { await delay(1500); extractMedications(cleanedRawText, entry.id, selectedId!); })();
      void (async () => { await delay(400); if (!entry.patientDocMd) generatePatientDoc(cleanedRawText, entry.id, selectedPatient); })();
      void (async () => { await delay(8000); detectPsychScales(transcript, entry.id, selectedId!); })();
      void autoScheduleFollowUp(cleanedRawText, selectedId!, selectedPatient);
      const prevSessions = history[selectedId!] ?? [];
      if (prevSessions.length > 0) {
        void generateSessionComparison(prevSessions[0], cleanedRawText, entry.id);
      }
    } catch (e: unknown) {
      const rawMsg = e instanceof Error ? e.message : "Unknown error";
      const isMidStream = /interrupted mid-stream/i.test(rawMsg);
      if (isMidStream) {
        // Clear any partial streamed preview so the half-report is not visible
        setStreamingRawText("");
        streamingAccRef.current = "";
        streamingBufRef.current = "";
        setFailedMidStream(true);
        setGenerateError("Report generation was interrupted. Your transcript is safe — tap Retry to regenerate.");
      } else {
        const isShortTechnical = rawMsg.length <= 120 &&
          /gemini|groq|openai|429|503|504|supabase|http \d{3}|provider|rate.?limit|socket|network|fetch/i.test(rawMsg);
        const displayMsg = isShortTechnical
          ? "Report couldn't be generated. Please try again in a moment."
          : rawMsg;
        setError(displayMsg);
        setGenerateError(displayMsg);
      }
    } finally { setLoading(false); }
  }
  generateReportRef.current = generateReport;

  // ── Overview view ────────────────────────────────────────────
  // Skeleton in index.html covers the loading gap.
  // No separate skeleton return here — swapping DOM trees causes CLS 0.38.

  if (view === "payment") {
    return (
      <PaymentPage
        doctorId={doctorId}
        onSuccess={(plan, expiresAt) => {
          setUserPlan(plan as "starter" | "clinical" | "premium");
          if (plan === "clinical" || plan === "premium") setIsUnlimited(true);
          if (expiresAt) setPlanExpiresAt(new Date(expiresAt));
          setPlanExpiryDismissed(false);
          setView("overview");
          setTimeout(() => showToast(`✅ ${plan.charAt(0).toUpperCase() + plan.slice(1)} plan activated! Enjoy all your new features.`, "success"), 400);
        }}
        onBack={() => setView("overview")}
      />
    );
  }

  // ── Plan expiry banner (shared between main + overview views) ────
  const planExpiryBanner = planExpiryNotice && !planExpiryDismissed ? (
    <div className={`plan-expiry-banner plan-expiry-banner--${planExpiryNotice}`}>
      <span className="peb-icon">{planExpiryNotice === "today" ? "🔴" : "🟠"}</span>
      <span className="peb-text">
        {planExpiryNotice === "today"
          ? `Your ${userPlan.charAt(0).toUpperCase() + userPlan.slice(1)} plan expires today. After expiry you'll have 30 free reports/month (40 with feedback).`
          : `Your ${userPlan.charAt(0).toUpperCase() + userPlan.slice(1)} plan expires tomorrow. Renew to keep unlimited access.`}
      </span>
      <button className="peb-renew" onClick={() => setView("payment")}>Renew Plan</button>
      <button className="peb-dismiss" onClick={() => {
        setPlanExpiryDismissed(true);
        sessionStorage.setItem(`sphota_expiry_dismissed_${new Date().toISOString().slice(0, 10)}`, "1");
      }}>✕</button>
    </div>
  ) : null;

  if (view === "overview") {
    return (
      <>
        {planExpiryBanner}
        {profileOpen && <ProfileModal draft={profileDraft} onChange={setProfileDraft} onSave={saveProfile} onClose={() => setProfileOpen(false)} onPrintConsent={printPatientConsent} onChangePin={() => setChangePinOpen(true)} />}
        <OverviewPage
          doctor={doctor} doctorId={doctorId} patients={patients} history={history}
          appointments={appointments}
          apiKeyAvailable={true}
          theme={theme} onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")}
          onBack={() => setView("main")}
          onSelectPatient={id => { setSelectedId(id); setActiveEntryId(null); setError(""); setTranscript(""); setView("main"); }}
          onEditProfile={openProfile}
          onUpgrade={() => setView("payment")}
          monthlyCount={monthlyCount}
          userPlan={userPlan}
          isUnlimited={isUnlimited}
          feedbackBonusUsed={feedbackBonusUsed}
          isLoading={appLoading}
        />
        {toastMsg && <div className={`ai-toast ai-toast--${toastType}`}>{toastMsg}</div>}
        {followUpToast && (
          <div className="ai-toast follow-up-toast">
            <span className="follow-up-toast-msg">{followUpToast.msg}</span>
            <button className="follow-up-toast-btn" onClick={() => {
              setApptDraft({ date: followUpToast.draft.date, time: followUpToast.draft.time, notes: followUpToast.draft.notes });
              setEditingApptId(null);
              setApptModalOpen(true);
              setFollowUpToast(null);
            }}>Review &amp; Save</button>
            <button className="follow-up-toast-dismiss" onClick={() => setFollowUpToast(null)}>Dismiss</button>
          </div>
        )}
      </>
    );
  }

  const isEditing = editPatientOpen;
  const patientModalOpen = addPatientOpen || editPatientOpen;

  return (
    <div className="shell" data-loading={appLoading ? "true" : undefined}>
      {planExpiryBanner}

      {/* ── Patient Recording Consent Modal ── */}
      {showConsentModal && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(8,12,24,0.85)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 16px",
        }}>
          <div style={{
            width: "100%", maxWidth: 460,
            background: "#0f1624",
            borderRadius: 18,
            border: "1px solid rgba(255,255,255,0.07)",
            padding: "32px 28px",
            boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(20,184,166,0.12)", border: "1px solid rgba(20,184,166,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" stroke="#14b8a6" strokeWidth="2" strokeLinecap="round"/><path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="#14b8a6" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="19" x2="12" y2="23" stroke="#14b8a6" strokeWidth="2" strokeLinecap="round"/><line x1="8" y1="23" x2="16" y2="23" stroke="#14b8a6" strokeWidth="2" strokeLinecap="round"/></svg>
              </div>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f0f4f8" }}>Patient Recording Consent</h2>
            </div>
            <p style={{ color: "#8898aa", fontSize: 13, lineHeight: 1.6, margin: "0 0 16px" }}>
              Before this session is recorded, please confirm that the patient has been informed of and agrees to the following:
            </p>
            <ul style={{ color: "#8898aa", fontSize: 13, lineHeight: 1.75, margin: "0 0 20px", paddingLeft: 18 }}>
              <li>This session will be recorded and transcribed using our smart service.</li>
              <li>The transcript will be used to generate a clinical note.</li>
              <li>Audio is not stored; only the text transcript is saved.</li>
              <li>The patient may withdraw consent at any time.</li>
            </ul>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", marginBottom: 24 }}>
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={e => setConsentChecked(e.target.checked)}
                style={{ marginTop: 2, accentColor: "#14b8a6", width: 16, height: 16, flexShrink: 0 }}
              />
              <span style={{ color: "#f0f4f8", fontSize: 13, lineHeight: 1.5 }}>
                I confirm the patient has given verbal consent to assisted recording of this session.
              </span>
            </label>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setShowConsentModal(false)}
                style={{ flex: 1, background: "transparent", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "11px", color: "#8898aa", fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}
              >
                Cancel
              </button>
              <button
                onClick={handleConsentConfirm}
                disabled={!consentChecked}
                style={{ flex: 2, background: consentChecked ? "#14b8a6" : "rgba(20,184,166,0.3)", border: "none", borderRadius: 10, padding: "11px", color: "#fff", fontSize: 14, fontWeight: 700, cursor: consentChecked ? "pointer" : "not-allowed", fontFamily: "inherit", transition: "background 0.2s" }}
              >
                Confirm & Start Recording
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Onboarding popup ── */}
      {showOnboarding && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
          <div style={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "16px", padding: "32px 28px", maxWidth: "360px", width: "100%", color: "#fff", fontFamily: "inherit" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: "1.2rem", fontWeight: 700, textAlign: "center" }}>Welcome to Sphota</h2>
            <p style={{ margin: "0 0 24px", fontSize: "0.85rem", color: "rgba(255,255,255,0.55)", textAlign: "center" }}>Here is how it works</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "28px" }}>
              {[
                { icon: "➕", text: "Add a patient from the left sidebar" },
                { icon: "🎙️", text: "Tap the microphone to start recording" },
                { icon: "✅", text: "Allow microphone permission when prompted" },
                { icon: "⏹️", text: "Tap Stop when the session is done" },
                { icon: "📄", text: "Tap Generate Report to get the clinical note" },
              ].map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                  <span style={{ fontSize: "1.4rem", minWidth: "32px", textAlign: "center" }}>{step.icon}</span>
                  <span style={{ fontSize: "0.9rem", color: "rgba(255,255,255,0.85)", lineHeight: 1.4 }}>{step.text}</span>
                </div>
              ))}
            </div>
            <button
              onClick={() => {
                localStorage.setItem(`psych_tour_done_${doctorId}`, "true");
                setShowOnboarding(false);
              }}
              style={{ width: "100%", padding: "12px", background: "#0ea5e9", color: "#fff", border: "none", borderRadius: "10px", fontSize: "0.95rem", fontWeight: 600, cursor: "pointer", letterSpacing: "0.01em" }}
            >
              Got it, let&apos;s start
            </button>
          </div>
        </div>
      )}

      {/* ── Report limit modal ── */}
      {showReportLimitModal && (() => {
        const atHardLimit = feedbackBonusUsed && monthlyCount >= 40;
        return (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.72)", zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
            onClick={() => setShowReportLimitModal(false)}>
            <div style={{ background:"#111827", border:"1px solid rgba(255,255,255,0.1)", borderRadius:20, padding:"36px 32px", maxWidth:420, width:"100%", boxShadow:"0 24px 80px rgba(0,0,0,0.5)" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ textAlign:"center", marginBottom:24 }}>
                <div style={{ fontSize:40, marginBottom:12 }}>{atHardLimit ? "🏁" : "💡"}</div>
                <h2 style={{ color:"#f0f4f8", fontSize:20, fontWeight:700, margin:"0 0 12px" }}>
                  {atHardLimit ? "Monthly limit reached" : "You've used all 30 free reports for this month"}
                </h2>
                <p style={{ color:"#8898aa", fontSize:14, lineHeight:1.6, margin:0 }}>
                  {atHardLimit
                    ? "You've used all 40 reports for this month. Your limit resets automatically on the 1st of next month."
                    : "Fill out our feedback form to unlock 10 more reports this month and help us improve Sphota."}
                </p>
              </div>
              {!atHardLimit && (
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  <a href="/feedback?role=doctor" target="_blank" rel="noreferrer"
                    style={{ display:"block", textAlign:"center", background:"#14b8a6", border:"none", borderRadius:12, padding:"13px", color:"#fff", fontSize:14, fontWeight:700, textDecoration:"none", boxShadow:"0 0 20px rgba(20,184,166,0.3)" }}>
                    Fill feedback form to unlock 10 more reports this month →
                  </a>
                </div>
              )}
              {atHardLimit && (
                <button onClick={() => setShowReportLimitModal(false)}
                  style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:12, padding:"12px", color:"#94a3b8", fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>
                  Close
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {globalRecording && !recording && (
        <div className="global-rec-banner">
          <span className="global-rec-dot" />
          Recording in progress for <strong>{globalRecording.patientName}</strong> on another device
          {globalRecording.patientId && globalRecording.patientId !== selectedId && (
            <button
              className="global-rec-goto"
              onClick={() => { setSelectedId(globalRecording.patientId); setActiveEntryId(null); setTranscript(""); }}
            >
              View patient →
            </button>
          )}
        </div>
      )}

      {/* ── Floating recording indicator — always on top during recording ── */}
      {recording && (
        <div style={{
          position: "fixed",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 99999,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "rgba(20,20,20,0.88)",
          border: "1.5px solid rgba(239,68,68,0.55)",
          borderRadius: 999,
          padding: "6px 14px 6px 10px",
          boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
          backdropFilter: "blur(6px)",
          pointerEvents: "none",
          userSelect: "none",
        }}>
          <span style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "#ef4444",
            flexShrink: 0,
            animation: "rec-blink 1s ease-in-out infinite",
          }} />
          <span style={{
            fontSize: 12,
            fontWeight: 700,
            color: "#ef4444",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}>REC</span>
          <span style={{
            fontSize: 15,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            color: "#f8fafc",
            letterSpacing: "0.04em",
            minWidth: 42,
            textAlign: "center",
          }}>{fmtTime(elapsed)}</span>
        </div>
      )}

      {/* ── Unexpected recording stop alert ── */}
      {recUnexpectedStop && (
        <div style={{
          position: "fixed",
          inset: 0,
          zIndex: 100000,
          background: "rgba(0,0,0,0.6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
        }}>
          <div style={{
            background: "var(--bg-card, #1e1e2e)",
            border: "1.5px solid rgba(239,68,68,0.5)",
            borderRadius: 14,
            padding: "28px 28px 22px",
            maxWidth: 420,
            width: "100%",
            boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 22 }}>⚠️</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#ef4444" }}>Recording Stopped Unexpectedly</span>
            </div>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "var(--text, #e2e8f0)" }}>
              Recording stopped unexpectedly. Your session may not have been captured fully. Please check your microphone and try again.
            </p>
            <button
              onClick={() => setRecUnexpectedStop(false)}
              style={{
                alignSelf: "flex-end",
                background: "#ef4444",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "8px 20px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {autoSaveError && (
        <AutoSaveErrorBanner onDismiss={() => setAutoSaveError(false)} />
      )}
      {toastMsg && <div className={`ai-toast ai-toast--${toastType}`}>{toastMsg}</div>}
      {followUpToast && (
        <div className="ai-toast follow-up-toast">
          <span className="follow-up-toast-msg">{followUpToast.msg}</span>
          <button className="follow-up-toast-btn" onClick={() => {
            setApptDraft({ date: followUpToast.draft.date, time: followUpToast.draft.time, notes: followUpToast.draft.notes });
            setEditingApptId(null);
            setApptModalOpen(true);
            setFollowUpToast(null);
          }}>Review &amp; Save</button>
          <button className="follow-up-toast-dismiss" onClick={() => setFollowUpToast(null)}>Dismiss</button>
        </div>
      )}
      {changePinOpen && <ChangePinModal onClose={() => setChangePinOpen(false)} />}
      {importPatientModalOpen && (
        <div className="modal-overlay" onClick={() => setImportPatientModalOpen(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <span className="modal-title">Import Patient Data</span>
              <button className="modal-close" onClick={() => setImportPatientModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: "20px 24px" }}>
              {importPatientStatus === "done" ? (
                <p style={{ color: "#22c55e", textAlign: "center", padding: "20px 0" }}>✓ Patient imported successfully!</p>
              ) : importedPatientData ? (
                <>
                  <p style={{ marginBottom: 12, fontSize: 14, color: "var(--text)" }}>Ready to import:</p>
                  <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", marginBottom: 16 }}>
                    <div style={{ fontWeight: 600 }}>{importedPatientData.patient.name}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                      {importedPatientData.sessions.length} session{importedPatientData.sessions.length !== 1 ? "s" : ""} included
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="modal-btn" onClick={() => setImportedPatientData(null)} style={{ flex: 1 }}>Choose Different File</button>
                    <button className="modal-btn modal-btn--primary" onClick={confirmImportPatient} disabled={importPatientStatus === "importing"} style={{ flex: 1 }}>
                      {importPatientStatus === "importing" ? "Importing…" : "Import Patient"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p style={{ marginBottom: 16, fontSize: 14, color: "var(--text-muted)" }}>
                    Select a patient JSON file exported from Sphota to import their data into your account.
                  </p>
                  <input
                    ref={importPatientFileRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: "none" }}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImportPatientFile(f); }}
                  />
                  <button className="modal-btn modal-btn--primary" style={{ width: "100%" }} onClick={() => importPatientFileRef.current?.click()}>
                    Select JSON File
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {importReportModalOpen && (
        <div className="modal-overlay" onClick={() => setImportReportModalOpen(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <span className="modal-title">Add Report from Another Doctor</span>
              <button className="modal-close" onClick={() => setImportReportModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: "20px 24px" }}>
              {importReportStatus === "done" ? (
                <p style={{ color: "#22c55e", textAlign: "center", padding: "20px 0" }}>✓ Report added successfully!</p>
              ) : importedReportData ? (
                <>
                  <p style={{ marginBottom: 12, fontSize: 14, color: "var(--text)" }}>
                    Ready to add this report to <strong>{selectedPatient?.name}</strong>'s history:
                  </p>
                  <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", marginBottom: 16 }}>
                    <div style={{ fontWeight: 600 }}>{importedReportData.date || "Report"}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                      {(importedReportData.rawText ?? "").slice(0, 90)}{(importedReportData.rawText ?? "").length > 90 ? "…" : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="modal-btn" onClick={() => setImportedReportData(null)} style={{ flex: 1 }}>Choose Different File</button>
                    <button className="modal-btn modal-btn--primary" onClick={confirmImportReport} disabled={importReportStatus === "importing" || !selectedPatient} style={{ flex: 1 }}>
                      {importReportStatus === "importing" ? "Adding…" : "Add to Patient"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p style={{ marginBottom: 16, fontSize: 14, color: "var(--text-muted)" }}>
                    Select a single-report JSON file (exported from Sphota's Share → "Share current report") to
                    add it to <strong>{selectedPatient?.name ?? "the selected patient"}</strong>'s history.
                  </p>
                  <input
                    ref={importReportFileRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: "none" }}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImportReportFile(f); }}
                  />
                  <button className="modal-btn modal-btn--primary" style={{ width: "100%" }} onClick={() => importReportFileRef.current?.click()} disabled={!selectedPatient}>
                    Select JSON File
                  </button>
                  {!selectedPatient && (
                    <p style={{ color: "#f59e0b", fontSize: 12, marginTop: 8 }}>Select a patient first.</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {profileOpen && <ProfileModal draft={profileDraft} onChange={setProfileDraft} onSave={saveProfile} onClose={() => setProfileOpen(false)} onPrintConsent={printPatientConsent} onChangePin={() => setChangePinOpen(true)} />}

      {scanModalOpen && (
        <ScanModal
          onClose={() => setScanModalOpen(false)}
          onCopyToNotes={(summary: string) => {
            setTranscript(prev => prev ? prev + "\n\n---\n\n" + summary : summary);
            setTranscriptView("edit");
            setScanModalOpen(false);
            showToast("Scan summary added to transcript — click Generate Report when ready.", "success");
          }}
          onGenerateReport={async (summary: string) => {
            if (!selectedPatient) {
              showToast("Please select a patient first.", "error");
              return;
            }
            setScanModalOpen(false);
            setLoading(true);
            setError("");
            try {
              // Use AI to convert the scan summary into a full clinical report
              const systemPrompt = `You are an expert AI assistant for a clinical psychiatrist in India, trained on India-first psychiatry resources including the Weave Library, NIMHANS proforma, ICD-11, and the Resident's Atlas of Psychiatric Prescribing. You are given a structured summary extracted from a scanned patient document (old record, prescription, discharge summary, or clinical note).

Your task is to convert this scanned document summary into a full clinical report following this EXACT structure. Base everything ONLY on what is documented in the scanned summary — do not invent or infer details.

When interpreting diagnoses: note ICD-11 equivalent if ICD-10 code is found. When interpreting medications: apply India DCGI/NDPS lens. When interpreting MSE: use Jaspers/Fish descriptive psychopathology terminology.

### 1. QUICK SCAN
Goal: A rapid executive summary for immediate decision-making.
Format: STRICTLY bullet points only.
- **Probable Diagnosis:** [from document — include ICD-11 code if mappable]
- **Key Clinical Signals/Symptoms:** [from document]
- **Immediate Action Plan:**
  - Medications: [from document or "Not documented" — note NDPS scheduling if applicable]
  - Safety/Risk Management: [from document or "Not documented"]
  - Therapy/Psychosocial: [from document or "Not documented"]
  - Labs/Medical Workup: [from document or "Not documented"]
  - Follow-up: [from document or "Not documented"]

### 2. SCANNED RECORD — EXTRACTED CLINICAL DETAILS
Reproduce the key extracted clinical details from the scanned document in organized bullet points.

### 3. RISK ASSESSMENT
Elevating Factors: bullet list — only factors from the document
Mitigating Factors: bullet list
Overall Level: Low / Moderate / High / Critical
Rationale: 1–2 sentences maximum.

### 4. SUMMARY
One single sentence only. State the core clinical problem from this historical record.

IMPORTANT: This report is derived from a scanned historical document, not a live session. Label it clearly at the start with: **Source: Scanned Document Record**`;

              const rawText = await callLLMWithFallback(
                [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: `Patient: ${selectedPatient.name}, ${selectedPatient.age} y/o ${selectedPatient.gender}\n\nScanned Document Summary:\n${summary}` },
                ],
                () => showToast("Switched to backup service"),
              );

              const cleanedRawText = rawText.trim();

              const rawEntry = await db.createSession(selectedId!, {
                date:       new Date().toISOString(),
                transcript: `[Scanned Document]\n\n${summary}`,
                rawText:    cleanedRawText,
              });
              const entry = { ...rawEntry, report: parseReport(cleanedRawText) };

              setHistory(prev => ({
                ...prev,
                [selectedId!]: [entry, ...(prev[selectedId!] ?? [])],
              }));
              setActiveEntryId(entry.id);
              setTranscript("");
              showToast("Scan report generated and saved.", "success");
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : "Unknown error";
              setError(msg);
              showToast("Failed to generate report from scan.", "error");
            } finally {
              setLoading(false);
            }
          }}
          patientName={selectedPatient?.name}
          patientAge={selectedPatient?.age != null ? String(selectedPatient.age) : undefined}
          patientGender={selectedPatient?.gender}
          authToken={scanAuthToken}
        />
      )}

      {/* Appointment reminder — always in DOM to avoid layout shift when appointments load.
          Visibility and height are toggled so no space is reserved when nothing to show. */}
      <div style={(!reminderDismissed && todayAppointments.length > 0) ? undefined : { opacity: 0, pointerEvents: 'none' as const, userSelect: 'none' as const }}>
        <AppointmentReminderBanner
          appointments={todayAppointments}
          patients={patients}
          onDismiss={dismissReminder}
          onSelectPatient={(id) => { setSelectedId(id); setActiveEntryId(null); setError(""); setTranscript(""); }}
        />
      </div>

      {patientModalOpen && (
        <div className="modal-overlay" onClick={() => { setAddPatientOpen(false); setEditPatientOpen(false); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{isEditing ? "Edit Patient" : "Add New Patient"}</h3>
              <button className="modal-close" onClick={() => { setAddPatientOpen(false); setEditPatientOpen(false); }}>✕</button>
            </div>
            <div className="modal-body">
              <label className="modal-label">Full Name *</label>
              <input className="modal-input" value={patientDraft.name} onChange={e => setPatientDraft(d => ({ ...d, name: e.target.value }))} placeholder="Patient full name" autoFocus />
              <div className="modal-row">
                <div style={{ flex: 1 }}>
                  <label className="modal-label">Age</label>
                  <input className="modal-input" type="number" min={0} max={120} value={patientDraft.age} onChange={e => setPatientDraft(d => ({ ...d, age: e.target.value }))} placeholder="e.g. 34" />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="modal-label">Gender</label>
                  <select className="modal-input modal-select" value={patientDraft.gender} onChange={e => setPatientDraft(d => ({ ...d, gender: e.target.value }))}>
                    <option>Female</option><option>Male</option><option>Non-binary</option><option>Other</option>
                  </select>
                </div>
              </div>
              <label className="modal-label">Appointment Time</label>
              <input className="modal-input" value={patientDraft.time} onChange={e => setPatientDraft(d => ({ ...d, time: e.target.value }))} placeholder="e.g. Today, 3:00 PM" />
              <label className="modal-label">Status</label>
              <div className="modal-status-row">
                {(["active", "waiting", "done"] as Patient["status"][]).map(s => (
                  <button key={s} className={`modal-status-chip ${patientDraft.status === s ? "active" : ""}`} onClick={() => setPatientDraft(d => ({ ...d, status: s }))}>
                    <span className="modal-status-dot" style={{ background: STATUS_COLOR[s] }} />
                    {s === "active" ? "In Session" : s === "waiting" ? "Waiting" : "Completed"}
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-cancel" onClick={() => { setAddPatientOpen(false); setEditPatientOpen(false); }}>Cancel</button>
              {!isEditing && (
                <button className="modal-cancel" onClick={() => { setAddPatientOpen(false); openImportPatient(); }} style={{ border: "1px solid var(--border)" }} title="Import patient data from another doctor's export">
                  Import JSON
                </button>
              )}
              <button className="modal-save" onClick={isEditing ? submitEditPatient : submitAddPatient} disabled={!patientDraft.name.trim()}>
                {isEditing ? "Save Changes" : "Add Patient"}
              </button>
            </div>
          </div>
        </div>
      )}


      {/* ── Mobile Appointment List Modal ── */}
      {mobileApptListOpen && selectedPatient && (() => {
        const todayIso = new Date().toISOString().slice(0, 10);
        const patientAppts = appointments
          .filter(a => a.patientId === selectedPatient.id && a.date >= todayIso)
          .sort((a, b) => a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date));
        return (
          <div className="modal-overlay" onClick={() => setMobileApptListOpen(false)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 360, width: "92vw" }}>
              <div className="modal-header">
                <h3 className="modal-title">Appointments — {selectedPatient.name}</h3>
                <button className="modal-close" onClick={() => setMobileApptListOpen(false)}>✕</button>
              </div>
              <div className="modal-body" style={{ padding: "12px 16px" }}>
                {patientAppts.length === 0 ? (
                  <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "8px 0 4px", textAlign: "center" }}>No upcoming appointments</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {patientAppts.map(appt => {
                      const [hh, mm] = appt.time.split(":");
                      const h = parseInt(hh);
                      const timeLabel = `${h > 12 ? h - 12 : h || 12}:${mm} ${h >= 12 ? "PM" : "AM"}`;
                      const dateLabel = new Date(appt.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
                      return (
                        <div key={appt.id} style={{ background: "var(--bg-hover)", borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                              <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/>
                              <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                            </svg>
                            {dateLabel} · {timeLabel}
                          </div>
                          {appt.notes && <div style={{ fontSize: 12, color: "var(--text-muted)", paddingLeft: 19 }}>{appt.notes}</div>}
                          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                            <button
                              style={{ flex: 1, padding: "6px 0", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text)", fontSize: 12, fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
                              onClick={() => {
                                setEditingApptId(appt.id);
                                setApptDraft({ date: appt.date, time: appt.time, notes: appt.notes });
                                setMobileApptListOpen(false);
                                setApptModalOpen(true);
                              }}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                              Reschedule
                            </button>
                            <button
                              style={{ flex: 1, padding: "6px 0", borderRadius: 7, border: "1px solid #ef4444", background: "rgba(239,68,68,0.07)", color: "#ef4444", fontSize: 12, fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
                              onClick={() => {
                                deleteAppointment(appt.id);
                                if (patientAppts.length === 1) setMobileApptListOpen(false);
                              }}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                              Cancel Appt
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="modal-footer" style={{ gap: 8 }}>
                <button className="modal-cancel" onClick={() => setMobileApptListOpen(false)}>Close</button>
                <button className="modal-save" onClick={() => { setMobileApptListOpen(false); openAddAppointment(); }}>
                  + New Appointment
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Appointment modal ── */}
      {apptModalOpen && selectedPatient && (
        <div className="modal-overlay" onClick={() => { setApptModalOpen(false); setEditingApptId(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{editingApptId ? "Edit Appointment" : "Add Appointment"} — {selectedPatient.name}</h3>
              <button className="modal-close" onClick={() => { setApptModalOpen(false); setEditingApptId(null); }}>✕</button>
            </div>
            <div className="modal-body">
              <div className="modal-row">
                <div style={{ flex: 1 }}>
                  <label className="modal-label">Date</label>
                  <input className="modal-input" type="date" value={apptDraft.date} onChange={e => setApptDraft(d => ({ ...d, date: e.target.value }))} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="modal-label">Time</label>
                  <input className="modal-input" type="time" value={apptDraft.time} onChange={e => setApptDraft(d => ({ ...d, time: e.target.value }))} />
                </div>
              </div>
              <label className="modal-label">Notes (optional)</label>
              <input className="modal-input" value={apptDraft.notes} onChange={e => setApptDraft(d => ({ ...d, notes: e.target.value }))} placeholder="e.g. Follow-up on medication" />
            </div>
            <div className="modal-footer">
              <button className="modal-cancel" onClick={() => { setApptModalOpen(false); setEditingApptId(null); }}>Cancel</button>
              <button className="modal-save" onClick={submitAddAppointment} disabled={!apptDraft.date || !apptDraft.time}>
                {editingApptId ? "Save Changes" : "Save Appointment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Top bar ── */}
      {dataRegionWarning && (
        <div style={{
          background: "rgba(234,179,8,0.12)",
          borderBottom: "1px solid rgba(234,179,8,0.35)",
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 12,
          color: "var(--text-secondary)",
          zIndex: 50,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, color: "#ca8a04" }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <span>
            <strong style={{ color: "var(--text-primary)" }}>DPDP Notice:</strong> Your Supabase project
            does not appear to be in the Mumbai (ap-south-1) region. For DPDP Act 2023 compliance,
            patient data should be stored in India.
          </span>
          <button
            onClick={() => { sessionStorage.setItem("psych_region_dismissed", "1"); setDataRegionWarning(false); }}
            style={{
              marginLeft: "auto", background: "none", border: "none", cursor: "pointer",
              color: "var(--text-muted)", fontSize: 16, lineHeight: 1, padding: "0 4px",
            }}
            title="Dismiss"
          >✕</button>
        </div>
      )}
      {retentionAlert && (
        <div style={{
          background: "rgba(239,68,68,0.10)",
          borderBottom: "1px solid rgba(239,68,68,0.30)",
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 12,
          color: "var(--text-secondary)",
          zIndex: 50,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, color: "#ef4444" }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <span>
            <strong style={{ color: "var(--text-primary)" }}>DPDP Data Retention:</strong>{" "}
            {retentionAlert.count} session{retentionAlert.count > 1 ? "s" : ""} exceed your {retentionAlert.years}-year retention policy.
            Please review and delete them from the patient record to comply with DPDP Act 2023 §12.
          </span>
          <button
            onClick={() => setRetentionAlert(null)}
            style={{
              marginLeft: "auto", background: "none", border: "none", cursor: "pointer",
              color: "var(--text-muted)", fontSize: 16, lineHeight: 1, padding: "0 4px",
            }}
            title="Dismiss"
          >✕</button>
        </div>
      )}
      <header className="topbar">
        <div className="topbar-left">
          <button id="tour-overview" className="logo-btn logo-cube-btn" onClick={() => setView("overview")} title="Dashboard">
            <svg className="logo-cube-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
              <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
              <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
            </svg>
            <span className="logo-cube-text">Sphota</span>
          </button>
          <button className="sphota-mark-btn" title="Sphota">
            <svg width="22" height="22" viewBox="40 40 260 260" xmlns="http://www.w3.org/2000/svg">
              <circle cx="170" cy="170" r="130" fill="#12111a"/>
              <circle cx="170" cy="170" r="105" fill="none" stroke="#1e1d2e" strokeWidth="1"/>
              <path d="M 122 122 C 122 84, 170 76, 194 106 C 212 130, 196 162, 170 170" fill="none" stroke="#b0adee" strokeWidth="4" strokeLinecap="round"/>
              <path d="M 218 218 C 218 256, 170 264, 146 234 C 128 210, 144 178, 170 170" fill="none" stroke="#b0adee" strokeWidth="4" strokeLinecap="round"/>
              <path d="M 212 118 C 212 96, 194 86, 170 92 C 142 100, 128 122, 138 144 C 146 160, 164 166, 170 170 C 176 174, 196 182, 204 200 C 214 222, 206 246, 184 254 C 162 262, 136 252, 128 232" fill="none" stroke="#c0392b" strokeWidth="8.5" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="212" cy="118" r="5.5" fill="#c0392b"/>
              <circle cx="128" cy="232" r="5.5" fill="#c0392b"/>
              <circle cx="170" cy="170" r="3.5" fill="#c0392b"/>
            </svg>
          </button>
          <span className="topbar-subtitle">Be Present. We'll Remember.</span>
        </div>
        <div className="topbar-right">
          {/* Desktop-only inline actions; hidden on mobile and moved into overflow menu */}
          <button className="theme-btn quick-lock-btn topbar-desktop-action" onClick={() => onLock?.()} title="Quick lock — tap to lock and return to PIN" style={{ color: "var(--text-muted)" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
          <button className="theme-btn topbar-desktop-action" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} title="Toggle theme">
            {theme === "dark"
              ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="2"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              : <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            }
          </button>
          {/* Report usage counter — neutral pill for Unlimited so the accent color isn't diluted */}
          {(() => {
            if (isUnlimited) return (
              <span className="topbar-plan-pill" title="Unlimited reports on your plan">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <span className="topbar-pill-prefix">Reports · </span>Unlimited
              </span>
            );
            const limit = feedbackBonusUsed ? 40 : 30;
            const pct   = Math.min(monthlyCount / limit, 1);
            const color = pct >= 0.8 ? "#ef4444" : pct >= 0.5 ? "#f59e0b" : "var(--text-secondary)";
            return (
              <button
                onClick={() => setShowReportLimitModal(true)}
                title={`Reports used this month: ${monthlyCount}/${limit}`}
                className="topbar-plan-pill topbar-plan-pill--btn"
                style={{ color }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className="topbar-pill-prefix">Reports · </span>{monthlyCount}/{limit}<span className="hide-on-mobile"> · Resets {new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
              </button>
            );
          })()}

          <button className="doctor-badge" onClick={openProfile} title="Edit doctor profile" style={{ textDecoration: "none", cursor: "pointer" }}>
            <span className="doctor-avatar">{getInitials(doctor.name)}</span>
            <div><div className="doctor-name">{doctor.name || "Set up profile"}</div><div className="doctor-specialty">{doctor.specialty}{doctor.clinic ? ` · ${doctor.clinic}` : ""}</div></div>
          </button>
          <button className="theme-btn topbar-signout-btn topbar-desktop-action" title="Sign out" style={{ color: "var(--text-muted)" }}
            onClick={async () => {
              localStorage.removeItem("psych_pending_country");
              sessionStorage.clear();
              await supabase.auth.signOut();
              window.location.href = "/";
            }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="16 17 21 12 16 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="21" y1="12" x2="9" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>

          {/* Mobile-only overflow menu — collapses lock / theme / sign out into a single sheet */}
          <details className="topbar-overflow">
            <summary className="topbar-overflow-trigger" title="More actions" aria-label="More actions">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
            </summary>
            <div className="topbar-overflow-menu" role="menu">
              <button role="menuitem" className="topbar-overflow-item" onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement)?.removeAttribute("open"); onLock?.(); }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                <span>Lock app</span>
              </button>
              <button role="menuitem" className="topbar-overflow-item" onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement)?.removeAttribute("open"); setTheme(t => t === "dark" ? "light" : "dark"); }}>
                {theme === "dark"
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="2"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                }
                <span>{theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}</span>
              </button>
              <button role="menuitem" className="topbar-overflow-item topbar-overflow-item--danger"
                onClick={async (e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement)?.removeAttribute("open");
                  localStorage.removeItem("psych_pending_country");
                  sessionStorage.clear();
                  await supabase.auth.signOut();
                  window.location.href = "/";
                }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="16 17 21 12 16 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="21" y1="12" x2="9" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                <span>Sign out</span>
              </button>
            </div>
          </details>
        </div>
      </header>

      <div className={`main-layout mobile-tab-${mobileTab}`}>
        {/* ── Sidebar ── */}
        <Suspense fallback={<div className="sidebar-loading">{[1,2,3].map(i=><div key={i} className="skeleton-patient-card"/>)}</div>}>
          <PatientSidebar
            filtered={filtered}
            patients={patients}
            history={history}
            flagged={flagged}
            appointments={appointments}
            presenceMap={presenceMap}
            selectedId={selectedId}
            meds={meds}
            selectedPatient={selectedPatient}
            search={search}
            mobileTab={mobileTab}
            recording={recording}
            transcribing={transcribing}
            openAddPatient={openAddPatient}
            setSearch={setSearch}
            setSelectedId={setSelectedId}
            setActiveEntryId={setActiveEntryId}
            setError={setError}
            setTranscript={setTranscript}
            setDeleteStep={setDeleteStep}
            setMobileTab={setMobileTab}
            showToast={showToast}
          />
        </Suspense>

        {/* Mobile New Session button removed from patients tab — use Generate Report tab instead */}

        {/* ── Main content ── */}
        <ErrorBoundary name="report-panel">
        <main className="content">
          <div className="content-header">
            <div className="content-header-left">
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h2 className="content-title">{selectedPatient ? selectedPatient.name : "Select a patient"}</h2>
                  {selectedPatient && (
                    <button
                      className="mobile-edit-patient-btn"
                      onClick={openEditPatient}
                      title="Edit patient info"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                      </svg>
                    </button>
                  )}
                </div>
                <p className="content-sub">
                  {selectedPatient ? `${selectedPatient.age} y/o · ${selectedPatient.gender} · ${selectedPatient.time}` : "Choose from the sidebar to begin"}
                </p>
              </div>
              {selectedPatient && (
                <div className="content-header-actions">
                  <button className="action-pill-btn new-session-btn" onClick={newSession} title="Start new session">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    New Session
                  </button>
                </div>
              )}
            </div>
            {selectedPatient && mediaRecorderUnsupported && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 12px", marginBottom: 6, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.35)", borderRadius: 8, fontSize: 12, color: "#fbbf24", lineHeight: 1.5 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: 1 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                Your browser may not fully support audio recording. For the best experience, please use Google Chrome or Microsoft Edge. Recording may not work correctly on Safari or older browsers.
              </div>
            )}
            {selectedPatient && (
              recording ? (
                <div className="rec-panel">
                  <div className="rec-panel-top">
                    <span className="rec-dot" />
                    <span className="rec-label">REC</span>
                    <span className="rec-timer">{fmtTime(elapsed)}</span>
                  </div>

                  {/* ── Live waveform bars ── */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, height: 28, margin: "6px 0 2px" }}>
                    {[0.5, 0.8, 0.6, 1, 0.7, 0.9, 0.55, 0.75, 0.85, 0.65, 0.9, 0.7].map((scale, i) => {
                      const active = audioLevel > 0.03;
                      const h = active ? Math.max(4, audioLevel * 26 * scale) : 4;
                      return (
                        <div key={i} style={{
                          width: 3,
                          height: `${h}px`,
                          borderRadius: 2,
                          background: active ? "#10b981" : "#334155",
                          transition: "height 0.07s ease, background 0.25s ease",
                          flexShrink: 0,
                        }} />
                      );
                    })}
                  </div>
                  {/* Silent-mic warning — appears after 4 seconds of no audio */}
                  {silentFrames > 60 && elapsed >= 4 && (
                    <p style={{ fontSize: 10, color: "#f87171", textAlign: "center", margin: "0 0 4px", letterSpacing: "0.02em" }}>
                      ⚠ No audio detected — check microphone
                    </p>
                  )}

                  <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center" }}>
                    <button
                      className="mic-stop-btn"
                      onClick={() => toggleRecording()}
                      title="Stop & transcribe"
                    >
                      <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="5" y="5" width="14" height="14" rx="2"/>
                      </svg>
                    </button>
                    <button
                      className="rec-cancel-btn"
                      onClick={cancelRecording}
                      title="Cancel recording — discard audio, no API usage"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                      Cancel
                    </button>
                  </div>
                  <p className="rec-hint">Stop to transcribe · Cancel to discard</p>
                </div>
              ) : (
                <div className="timer-row">
                  <span className="timer">{fmtTime(elapsed)}</span>
                  <span className="timer-sep">/</span>
                  <span className="timer-status">
                    {transcribing ? "Transcribing…" : "Ready"}
                  </span>
                  <button
                    className={`mic-btn ${transcribing ? "mic-btn--transcribing" : ""}`}
                    onClick={() => toggleRecording("mic")}
                    disabled={transcribing && !recording}
                    title={transcribing ? "Transcribing…" : "Start recording (in-person, microphone only)"}
                    style={{ pointerEvents: deleteStep > 0 ? "none" : undefined, opacity: deleteStep > 0 ? 0.3 : undefined }}
                  >
                    {transcribing
                      ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="mic-spinner"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                      : <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="9" y="2" width="6" height="13" rx="3" stroke="currentColor" strokeWidth="2"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3M9 22h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    }
                  </button>
                  {!transcribing && !callAudioUnsupported && (
                    <button
                      className="mic-btn call-record-btn"
                      onClick={() => toggleRecording("call")}
                      title="Record an online call — captures your mic AND the shared tab's call audio"
                      style={{ pointerEvents: deleteStep > 0 ? "none" : undefined, opacity: deleteStep > 0 ? 0.3 : undefined }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="2"/><path d="M22 7.5l-6 3v-3l6 3v-6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M2 18h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    </button>
                  )}
                  {transcribing && (
                    <button
                      className="rec-cancel-btn"
                      onClick={cancelTranscription}
                      title="Cancel transcription — no API usage counted"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                      Cancel
                    </button>
                  )}
                </div>
              )
            )}
          </div>

          <div className="content-body-row">
          {/* ── Vertical action rail — icon-only, colorful — runs alongside sessions/tabs/report only, not the patient header or the generate bar ── */}
          {selectedPatient && (
            <div className="action-rail">
              {deleteStep === 0 && (
                <>
                  <button className="rail-btn rail-btn--edit" onClick={openEditPatient}>
                    <span className="rail-tip">Edit</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  </button>
                  <div style={{ position: "relative" }}>
                    <button className="rail-btn rail-btn--share" onClick={() => setShareMenuOpen(v => !v)}>
                      <span className="rail-tip">Share</span>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="18" cy="5" r="3" stroke="currentColor" strokeWidth="2"/><circle cx="6" cy="12" r="3" stroke="currentColor" strokeWidth="2"/><circle cx="18" cy="19" r="3" stroke="currentColor" strokeWidth="2"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    </button>
                    {shareMenuOpen && (
                      <>
                        <div style={{ position: "fixed", inset: 0, zIndex: 199 }} onClick={() => setShareMenuOpen(false)} />
                        <div className="share-report-popover" style={{
                          position: "absolute", left: "100%", top: 0, marginLeft: 8, zIndex: 200,
                          background: "var(--bg-surface)", border: "1px solid var(--border-mid)",
                          borderRadius: 10, boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
                          minWidth: 200, padding: 6,
                        }}>
                          <button
                            className="share-popover-btn"
                            disabled={!activeEntry}
                            onClick={() => {
                              if (selectedPatient && activeEntry) exportSingleReportJson(selectedPatient, activeEntry);
                              setShareMenuOpen(false);
                            }}
                            style={{
                              display: "block", width: "100%", textAlign: "left", padding: "9px 10px",
                              background: "transparent", border: "none", borderRadius: 6, cursor: activeEntry ? "pointer" : "not-allowed",
                              color: activeEntry ? "var(--text-primary)" : "var(--text-muted)", fontSize: 13,
                            }}
                          >
                            Share current report
                            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                              {activeEntry ? "Just this session's report" : "Open a report first"}
                            </div>
                          </button>
                          <button
                            className="share-popover-btn"
                            onClick={() => {
                              if (selectedPatient) exportPatientJson(selectedPatient);
                              setShareMenuOpen(false);
                            }}
                            style={{
                              display: "block", width: "100%", textAlign: "left", padding: "9px 10px",
                              background: "transparent", border: "none", borderRadius: 6, cursor: "pointer",
                              color: "var(--text-primary)", fontSize: 13,
                            }}
                          >
                            Share all reports
                            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                              Full patient history
                            </div>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <button className="rail-btn rail-btn--appt" onClick={openAddAppointment}>
                    <span className="rail-tip">Add appointment</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  </button>
                  <button className="rail-btn rail-btn--import" onClick={openImportReport}>
                    <span className="rail-tip">Add report from another doctor (JSON)</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="7 10 12 15 17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  </button>
                  <button className="rail-btn rail-btn--meds" onClick={openManageMeds}>
                    <span className="rail-tip">Medications{activeMedRecord.medications.filter(m => m.status === "active").length > 0 ? ` · ${activeMedRecord.medications.filter(m => m.status === "active").length} active` : ""}</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="9" width="18" height="9" rx="4" stroke="currentColor" strokeWidth="2" transform="rotate(-45 12 12)"/><path d="M12 4.5v15" stroke="currentColor" strokeWidth="2" transform="rotate(-45 12 12)"/></svg>
                  </button>
                  <button
                    className="rail-btn rail-btn--note"
                    onClick={() => setNoteModalOpen(true)}
                    style={{ opacity: !activeEntryId ? 0.4 : 1 }}
                  >
                    <span className="rail-tip">{activeEntryId ? "Session notes" : "Generate a report first to add notes"}</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  </button>
                  <div className="rail-sep" />
                  <button className="rail-btn rail-btn--delete" onClick={() => setDeleteStep(1)}>
                    <span className="rail-tip">Delete</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  </button>
                </>
              )}
              {deleteStep === 1 && (
                <div className="rail-delete-confirm">
                  <span className="rail-delete-msg">Delete <strong>{selectedPatient.name}</strong> and all {(history[selectedPatient.id]?.length ?? 0)} report{(history[selectedPatient.id]?.length ?? 0) !== 1 ? "s" : ""}?</span>
                  <button className="action-pill-btn" onClick={() => setDeleteStep(0)}>Cancel</button>
                  <button className="action-pill-btn delete-confirm-btn" onClick={() => setDeleteStep(2)}>Yes, Delete</button>
                </div>
              )}
              {deleteStep === 2 && (
                <div className="rail-delete-confirm">
                  <span className="rail-delete-msg rail-delete-msg--final">Final confirmation — <strong>{history[selectedPatient.id]?.length ?? 0} report{(history[selectedPatient.id]?.length ?? 0) !== 1 ? "s" : ""}</strong> will be permanently deleted.</span>
                  <button className="action-pill-btn" onClick={() => setDeleteStep(0)}>Cancel</button>
                  <button className="action-pill-btn delete-confirm-btn" onClick={deletePatient}>Permanently Delete</button>
                </div>
              )}
            </div>
          )}

          <div className="content-main-col">

          <div className="content-meta">
          {/* Medications & Allergies card removed from here — now accessed via the medication icon in the vertical action rail */}

          {/* ── Upcoming Appointments strip ── */}
          {selectedPatient && (() => {
            const todayIso = new Date().toISOString().slice(0, 10);
            const upcoming = appointments
              .filter(a => a.patientId === selectedPatient.id && a.date >= todayIso)
              .sort((a, b) => a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date));
            if (upcoming.length === 0) return null;
            return (
              <div className="appt-strip">
                <span className="history-label">APPOINTMENTS</span>
                <div className="appt-chips">
                  {upcoming.map(appt => {
                    const [hh, mm] = appt.time.split(":");
                    const h = parseInt(hh);
                    const timeLabel = `${h > 12 ? h - 12 : h || 12}:${mm} ${h >= 12 ? "PM" : "AM"}`;
                    const dateLabel = new Date(appt.date + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
                    return (
                      <span key={appt.id} className="appt-chip">
                        <span className="appt-chip-label">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" style={{ marginRight: 3, flexShrink: 0 }}>
                            <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/>
                            <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                          </svg>
                          {dateLabel} · {timeLabel}
                          {appt.notes && <span className="appt-chip-notes"> — {appt.notes}</span>}
                        </span>
                        <button
                          className="appt-chip-edit"
                          title="Edit this appointment"
                          onClick={() => { setEditingApptId(appt.id); setApptDraft({ date: appt.date, time: appt.time, notes: appt.notes }); setApptModalOpen(true); }}
                        >
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                        </button>
                        <button
                          className="appt-chip-delete"
                          title="Delete this appointment"
                          onClick={() => deleteAppointment(appt.id)}
                        >×</button>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {patientHistory.length > 0 && (
            <div className="history-strip">
              <span className="history-label">SESSIONS</span>
              <div className="history-chips">
                <button
                  className={`history-chip history-chip--new ${activeEntryId === null ? "active" : ""}`}
                  onClick={() => {
                    if (recording || transcribing) {
                      // Recording is live OR transcription is in progress — just navigate
                      // back to the new-session view without stopping anything.
                      // The transcript is still accumulating / being written; the user
                      // can see it and act when ready.
                      setActiveEntryId(null);
                      setEditMode(false);
                      setMobileTab("record");
                    } else {
                      newSession();
                    }
                  }}
                  title={recording ? "Go back to live recording" : transcribing ? "Go back to transcription in progress" : "Start a new session"}>
                  {recording ? (
                    <span className="chip-rec-dot" style={{ width: 7, height: 7, borderRadius: "50%", background: "#ef4444", display: "inline-block", marginRight: 2, animation: "rec-pulse 1s ease-in-out infinite" }} />
                  ) : transcribing ? (
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#f59e0b", display: "inline-block", marginRight: 2, animation: "rec-pulse 1s ease-in-out infinite" }} />
                  ) : (
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                  )}
                  {recording ? "Live Recording" : transcribing ? "Transcribing…" : "New Session"}
                </button>
                {patientHistory.map(entry => {
                  const isDeleting = deletingEntryId === entry.id;
                  return isDeleting ? (
                    <span key={entry.id} className="history-chip history-chip--confirm">
                      <span className="history-chip-confirm-label">Delete this session?</span>
                      <button className="history-chip-confirm-yes" onClick={() => deleteEntry(entry.id)}>Yes</button>
                      <button className="history-chip-confirm-no"  onClick={() => setDeletingEntryId(null)}>No</button>
                    </span>
                  ) : (
                    <span key={entry.id} className={`history-chip history-chip--deletable ${activeEntry?.id === entry.id ? "active" : ""} ${flagged.has(entry.id) ? "flagged" : ""}`}>
                      <button
                        className="history-chip-label"
                        onClick={() => {
                          if (recording) {
                            showToast("⚠️ Recording in progress — stop the recording before switching sessions.", "error");
                            return;
                          }
                          if (transcribing) {
                            showToast("⚠️ Transcription in progress — wait for it to finish before switching sessions.", "error");
                            return;
                          }
                          setEditMode(false);
                          setActiveEntryId(entry.id); setTranscript(entry.transcript); setDeletingEntryId(null);
                        }}>
                        {flagged.has(entry.id) && <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 3, color: "#ef4444" }}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/></svg>}
                        {entry.collateralTranscript?.trim() && (
                          <span className="chip-collateral-dot" title="Collateral / family interview recorded for this session" />
                        )}
                        {formatDate(entry.date)}
                      </button>
                      <button
                        className="history-chip-delete"
                        title="Delete this session"
                        onClick={e => { e.stopPropagation(); setDeletingEntryId(entry.id); }}>
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          </div>

          {viewOriginalOpen && activeEntry?.rawText && (
            <div className="modal-overlay" onClick={() => setViewOriginalOpen(false)}>
              <div className="modal original-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2a5 5 0 1 0 0 10A5 5 0 0 0 12 2z" stroke="currentColor" strokeWidth="2"/><path d="M3 21l3-3m0 0a7 7 0 1 0 0-9.9A7 7 0 0 0 6 18z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    <h3 className="modal-title">Original Output</h3>
                  </div>
                  <button className="modal-close" onClick={() => setViewOriginalOpen(false)}>✕</button>
                </div>
                <div className="original-modal-body">
                  <p className="original-modal-note">This is the unmodified original report. It has not been altered.</p>
                  <pre className="original-modal-pre">{activeEntry.rawText}</pre>
                </div>
              </div>
            </div>
          )}

          {/* ── Full-screen expanded report modal ── */}
          {reportExpanded && activeEntry?.rawText && (
            <div className="modal-overlay" onClick={() => setReportExpanded(false)} style={{ zIndex: 1100 }}>
              <div
                className="modal"
                onClick={e => e.stopPropagation()}
                style={{ width: "min(900px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", borderRadius: 12, overflow: "hidden" }}
              >
                <div className="modal-header" style={{ flexShrink: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path d="M9 12h6M9 16h6M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    <h3 className="modal-title">Clinical Report</h3>
                    {selectedPatient && <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 400 }}>· {selectedPatient.name}</span>}
                  </div>
                  <button className="modal-close" onClick={() => setReportExpanded(false)}>✕</button>
                </div>
                <div style={{ overflowY: "auto", flex: 1, padding: "0 4px 12px" }}>
                  {activeEntry.editedHtml ? (
                    <EditedReportView html={activeEntry.editedHtml} onCodeClick={fetchIcdSummary} />
                  ) : (
                    <ReportBlocks rawText={activeEntry.rawText} date={activeEntry.date} doctor={doctor} patientName={selectedPatient?.name} isFlagged={isFlagged} scaleScores={activeEntry.scaleScores} onIcdClick={fetchIcdSummary} />
                  )}
                </div>
              </div>
            </div>
          )}

          {selectedPatient && (
            <div id="tour-sessions" className="report-tab-bar">
              {activeEntry?.rawText && (
                <button className={`report-tab-btn ${reportTab === "clinical" ? "active" : ""}`} onClick={() => setReportTab("clinical")}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 12h6M9 16h6M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  Clinical Report
                </button>
              )}
              {activeEntry?.rawText && (
                <button className={`report-tab-btn ${reportTab === "patient" ? "active" : ""}`} onClick={() => setReportTab("patient")}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  Patient Letter
                  {patientDocLoading && <span className="tab-loading-dot" />}
                </button>
              )}
              <button className={`report-tab-btn ${reportTab === "progress" ? "active" : ""}`} onClick={() => setReportTab("progress")}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 3v18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M7 16l4-4 4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Progress
              </button>
            </div>
          )}

          <div className="report-area">
            {activeEntry?.rawText && reportTab === "clinical" && sessionComparisons[activeEntry.id] && (
              <div className="session-comparison-bar">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                  <path d="M9 19l-7-7 7-7M20 18v-2a4 4 0 0 0-4-4H5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M15 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span>{sessionComparisons[activeEntry.id]}</span>
              </div>
            )}
            {selectedPatient && reportTab === "progress" ? (
              <ErrorBoundary name="progress-tab">
                <ProgressTab sessions={patientHistory} />
              </ErrorBoundary>
            ) : !selectedPatient ? (
              <div className="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" opacity=".3"><path d="M9 12h6M9 16h6M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="1.5"/></svg>
                <p className="empty-title">Select a patient to begin</p>
                <p className="empty-sub">Choose a patient from the sidebar to view their sessions and reports.</p>
              </div>
            ) : loading ? (
              streamingRawText ? (
                <div className="report-streaming-container">
                  <div className="report-streaming-indicator">
                    <span className="streaming-pulse" />
                    <span className="streaming-label">Documenting session — sections appear as they complete</span>
                  </div>
                  <ReportBlocks
                    rawText={streamingRawText}
                    date={new Date().toISOString()}
                    doctor={doctor}
                    isFlagged={false}
                  />
                </div>
              ) : (
                <div className="empty-state">
                  <style>{`@keyframes gen-msg-fade{0%{opacity:0;transform:translateY(5px)}30%{opacity:1;transform:translateY(0)}100%{opacity:1;transform:translateY(0)}}`}</style>
                  <div className="spinner" />
                  <p
                    key={genMsgIndex}
                    style={{ fontSize: 14, color: "var(--text-muted)", margin: "10px 0 0", textAlign: "center", animation: "gen-msg-fade 2.5s ease forwards", fontWeight: 400, lineHeight: 1.5 }}
                  >
                    {GEN_MESSAGES[genMsgIndex]}
                  </p>
                </div>
              )
            ) : error ? (
              <div className="error-box">{error}</div>
            ) : activeEntry?.rawText ? (
              reportJustReady && reportTab === "clinical" && !editMode ? (
                <div className="report-ready-banner" onAnimationEnd={() => {}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M20 6L9 17l-5-5" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span>Report complete — please review before use</span>
                  <button className="report-ready-dismiss" onClick={() => setReportJustReady(false)}>×</button>
                </div>
              ) : null
            ) : null}
            {!loading && !error && activeEntry?.rawText && reportTab !== "progress" ? (
              reportTab === "patient" ? (
                <>
                  {!activeEntry.patientDocMd && !patientDocLoading && activeEntry.rawText && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "24px 0 8px" }}>
                      <button
                        className="edit-action-btn"
                        style={{ fontSize: 13, padding: "8px 20px", minHeight: 44 }}
                        onClick={() => generatePatientDoc(activeEntry.rawText ?? "", activeEntry.id, selectedPatient!, true)}
                      >
                        Generate Patient Letter
                      </button>
                    </div>
                  )}
                  <PatientDocument
                  key={`${activeEntry.id}-${patientDocLang}`}
                  patientName={selectedPatient!.name}
                  date={activeEntry.date}
                  doctor={doctor}
                  lang={patientDocLang}
                  onSetLang={handleSetPatientDocLang}
                  loading={patientDocLoading && !activeEntry.patientDocMd}
                  translationLoading={translationLoadingLang === patientDocLang}
                  mdByLang={{
                    en: activeEntry.patientDocMd,
                    hi: activeEntry.patientDocHindiMd,
                    mr: activeEntry.patientDocMarathiMd,
                    bn: activeEntry.patientDocBengaliMd,
                    ta: activeEntry.patientDocTamilMd,
                    te: activeEntry.patientDocTeluguMd,
                  }}
                  editedHtmlByLang={{
                    en: activeEntry.patientDocEditedHtmlEn,
                    hi: activeEntry.patientDocEditedHtmlHi,
                  }}
                  sessionMeds={activeMedRecord.medications.filter(m => m.status === "active")}
                  onPrintRx={printRx}
                  onPrintIndividualRx={printIndividualRx}
                  onSaveEdits={savePatientDocEdits}
                  onRegenerate={activeEntry.patientDocMd && !patientDocLoading ? () => generatePatientDoc(activeEntry.rawText ?? "", activeEntry.id, selectedPatient!, true) : undefined}
                />
                </>
              ) : editMode ? (
                <ReportEditor
                  key={activeEntry.id}
                  initialHtml={activeEntry.editedHtml ?? DOMPurify.sanitize(markedSync(activeEntry.rawText))}
                  onChange={() => {}}
                  onSave={saveEdits}
                  onDiscard={() => setEditMode(false)}
                />
              ) : activeEntry.editedHtml ? (
                <div className="report-edited-view">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                    <div className="report-edited-badge" style={{ margin: 0 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                      Edited · {formatDate(activeEntry.editedAt!)}
                    </div>
                    {reportTab === "clinical" && !editMode && (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <button className="edit-action-btn" style={{ fontSize: 12, padding: "6px 12px" }} onClick={() => setReportExpanded(true)} title="Expand report to full screen">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ marginRight: 4, verticalAlign: "middle" }}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          Expand
                        </button>
                        <button className="edit-action-btn" style={{ fontSize: 12, padding: "6px 12px" }} onClick={() => { navigator.clipboard.writeText(activeEntry.rawText ?? "").then(() => { setReportCopied(true); setTimeout(() => setReportCopied(false), 2000); }); }}>
                          {reportCopied ? "✓ Copied" : "Copy Report"}
                        </button>
                      </div>
                    )}
                  </div>
                  <EditedReportView html={activeEntry.editedHtml} onCodeClick={fetchIcdSummary} />
                </div>
              ) : (
                <ReportBlocks
                  rawText={activeEntry.rawText}
                  date={activeEntry.date}
                  doctor={doctor}
                  patientName={selectedPatient?.name}
                  isFlagged={isFlagged}
                  scaleScores={activeEntry.scaleScores}
                  onIcdClick={fetchIcdSummary}
                  hasCollateral={!!activeEntry.collateralTranscript?.trim()}
                  onExpand={() => setReportExpanded(true)}
                  onCopy={() => { navigator.clipboard.writeText(activeEntry.rawText ?? "").then(() => { setReportCopied(true); setTimeout(() => setReportCopied(false), 2000); }); }}
                  copied={reportCopied}
                />
              )
            ) : !loading && !error ? (
              <div className="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" opacity=".3"><path d="M9 12h6M9 16h6M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="1.5"/></svg>
                <p className="empty-title">Ready when you are</p>
                <p className="empty-sub">Paste a session transcript above, then choose Generate to produce a structured report. You can also press Ctrl + Enter.</p>
              </div>
            ) : null}
          </div>

          </div>
          </div>

          <div className="bottom-bar">
            <button className={`flag-btn ${isFlagged ? "flagged" : ""}`} title={isFlagged ? "Remove flag" : "Flag this session"} onClick={toggleFlag} disabled={!activeEntry}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill={isFlagged ? "currentColor" : "none"}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            {(() => {
              const wc = transcript.trim() ? transcript.trim().split(/\s+/).filter(Boolean).length : 0;
              const tooShort = wc > 0 && wc < 50;
              const shortWarn = wc >= 50 && wc <= 100;
              const genDisabled = !selectedPatient || !transcript.trim() || wc < 50 || loading;
              return (
                <div id="tour-generate" className="generate-wrap">
                  <div className="generate-row">
                    <button className="generate-btn" onClick={generateReport} disabled={genDisabled} title="Generate (Ctrl+Enter)">
                      {loading ? (
                        <>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="mic-spinner"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                          Generating report...
                        </>
                      ) : (
                        <>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          Generate Clinical Report
                        </>
                      )}
                    </button>
                    <select
                      className="format-select"
                      value={doctor.noteFormat ?? "SOAP"}
                      onChange={e => handleNoteFormatChange(e.target.value as NoteFormat)}
                      title="Note format"
                    >
                      <option value="SOAP">SOAP</option>
                      <option value="DAP">DAP</option>
                      <option value="BIRP">BIRP</option>
                      <option value="PIRP">PIRP</option>
                      <option value="NIMHANS">NIMHANS Proforma</option>
                    </select>
                  </div>
                  {tooShort && (
                    <div className="transcript-too-short">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                      Transcript too short for a reliable report — minimum 50 words needed. Current: {wc} word{wc !== 1 ? "s" : ""}.
                    </div>
                  )}
                  {shortWarn && (
                    <div className="transcript-short-warn">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                      Short transcript — report may have limited accuracy.
                    </div>
                  )}
                  {!loading && collateralTranscript.trim() && (
                    <div className="collateral-inclusion-pill">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                        <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2"/>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                      </svg>
                      Collateral interview will be included in this report
                    </div>
                  )}
                  {generateError && !loading && (
                    failedMidStream ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.35)", borderRadius: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, color: "#fbbf24" }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                          <span style={{ fontSize: 12, color: "#fbbf24", fontWeight: 600, lineHeight: 1.4 }}>Report interrupted mid-generation</span>
                        </div>
                        <span style={{ fontSize: 12, color: "rgba(251,191,36,0.85)", lineHeight: 1.5 }}>Your transcript is safe. Tap Retry to regenerate the full report.</span>
                        <button
                          onClick={generateReport}
                          style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6, background: "rgba(251,191,36,0.18)", border: "1px solid rgba(251,191,36,0.5)", color: "#fbbf24", borderRadius: 7, padding: "6px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: "0.01em" }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.51 15a9 9 0 1 0 .49-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          Retry Generation
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontSize: 12, color: "#f87171" }}>
                        <span style={{ lineHeight: 1.5 }}>{generateError}</span>
                        <button
                          onClick={generateReport}
                          style={{ alignSelf: "flex-start", background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)", color: "#f87171", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                        >
                          Try again
                        </button>
                      </div>
                    )
                  )}
                </div>
              );
            })()}
            <span className="dpdp-notice" title="Audio is transcribed via our service. Report text is processed securely. Patient names and phone numbers are stripped before transmission.">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              Smart · PII stripped before upload
            </span>
            {activeEntry?.rawText && !editMode && (
              <>
                {activeEntry.editedHtml && (
                  <button className="edit-action-btn view-original-btn" title="View original output" onClick={() => setViewOriginalOpen(true)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/></svg>
                    Original
                  </button>
                )}
                <button className="edit-action-btn edit-report-btn" title="Edit this report" onClick={() => setEditMode(true)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  Edit Report
                </button>
              </>
            )}
            {activeEntry?.rawText && !editMode && (
              <div className="export-dropdown-wrap">
                <button className="export-icon-btn" title="Export / Print" onClick={() => setExportMenuOpen(v => !v)}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                {exportMenuOpen && (
                  <>
                    <div className="export-overlay" onClick={() => setExportMenuOpen(false)} />
                    <div className="export-menu export-menu--up">
                      <button className="export-menu-item" onClick={() => { printReport(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><polyline points="6 9 6 2 18 2 18 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><rect x="6" y="14" width="12" height="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        Print
                      </button>
                      <button className="export-menu-item" onClick={() => { exportReport(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        PDF
                      </button>
                      <button className="export-menu-item" onClick={() => { exportWord(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        Word (.docx)
                      </button>
                      <button className="export-menu-item" onClick={() => { exportImage(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="2"/><polyline points="21 15 16 10 5 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        Image
                      </button>
                      <div style={{ height: "1px", background: "rgba(255,255,255,0.07)", margin: "4px 0" }} />
                      <button className="export-menu-item" onClick={() => { exportFullHistory(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="8" y1="13" x2="16" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="8" y1="17" x2="13" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                        Full History PDF
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {medModalOpen && selectedPatient && (
            <MedModal
              mode={medModalMode}
              patientName={selectedPatient.name}
              record={activeMedRecord}
              prescribedBy={doctor.name}
              sessionId={activeEntry?.id}
              drafts={medModalMode === "review" ? medDrafts : undefined}
              onSave={saveMedRecord}
              onClose={() => setMedModalOpen(false)}
            />
          )}
        </main>
        </ErrorBoundary>

        {/* ── Transcript panel ── */}
        <ErrorBoundary name="transcript-panel">
          <Suspense fallback={<div className="panel-loading"><div className="spinner" /></div>}>
            <TranscriptPanel
              transcriptOpen={transcriptOpen}
              setTranscriptOpen={setTranscriptOpen}
              remoteRecording={remoteRecording}
              selectedPatient={selectedPatient}
              recording={recording}
              transcribing={transcribing}
              elapsed={elapsed}
              audioLevel={audioLevel}
              silentFrames={silentFrames}
              fmtTime={fmtTime}
              toggleRecording={toggleRecording}
              cancelRecording={cancelRecording}
              cancelTranscription={cancelTranscription}
              activeEntryId={activeEntryId}
              liveConnected={liveConnected}
              setScanModalOpen={openScanModal}
              transcript={transcript}
              setTranscript={setTranscript}
              transcriptView={transcriptView}
              setTranscriptView={setTranscriptView}
              doctor={doctor}
              draftBanner={draftBanner}
              setDraftBanner={setDraftBanner}
              collateralTranscript={collateralTranscript}
              setCollateralTranscript={setCollateralTranscript}
              collateralRecording={collateralRecording}
              collateralTranscribing={collateralTranscribing}
              collateralElapsed={collateralElapsed}
              collateralAudioLevel={collateralAudioLevel}
              collateralSilentFrames={collateralSilentFrames}
              toggleCollateralRecording={toggleCollateralRecording}
              cancelCollateralRecording={cancelCollateralRecording}
              cancelCollateralTranscription={cancelCollateralTranscription}
            />
          </Suspense>
        </ErrorBoundary>

        {/* ── Mobile bottom nav ── */}
        <nav className="mobile-nav">
          <button
            className={`mobile-nav-btn ${mobileTab === "patients" ? "active" : ""}`}
            onClick={() => setMobileTab("patients")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Patients
          </button>
          <button
            className={`mobile-nav-btn ${mobileTab === "report" ? "active" : ""}`}
            onClick={() => setMobileTab("report")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M9 12h6M9 16h6M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Report
          </button>
          <button
            className={`mobile-nav-btn ${mobileTab === "record" ? "active" : ""} ${recording ? "recording" : ""}`}
            onClick={() => {
              if (selectedId === null) return;
              setMobileTab("record");
              // If recording is live OR transcription is in progress and user tapped
              // the Record tab from another tab, snap back to the new-session slot
              // so the live transcript / transcribing indicator is visible.
              if (recording || transcribing) {
                setActiveEntryId(null);
                setEditMode(false);
              }
            }}
            title={selectedId === null ? "Select a patient first" : undefined}
            disabled={selectedId === null}
            style={selectedId === null ? { opacity: 0.35, cursor: "not-allowed" } : undefined}
          >
            {recording ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="9" fill="rgba(239,68,68,0.2)" stroke="#ef4444" strokeWidth="2"/>
                <circle cx="12" cy="12" r="4" fill="#ef4444"/>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="2" width="6" height="13" rx="3" stroke="currentColor" strokeWidth="2"/>
                <path d="M5 10a7 7 0 0 0 14 0M12 19v3M9 22h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            )}
            {recording ? "Recording…" : "Record"}
          </button>
        </nav>

        {/* ── Mobile: floating action bar shown only on report tab ── */}
        {mobileTab === "report" && selectedPatient && (
          <div className="mobile-action-bar">
            <button className="mobile-action-btn" onClick={() => setMobileTranscriptOpen(o => !o)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              <span>Transcript</span>
            </button>
            <button className="mobile-action-btn" onClick={openManageMeds}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M9 11V6a3 3 0 0 1 6 0v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M12 15v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              <span>Meds</span>
            </button>
            {activeMedRecord.medications.filter(m => m.status === "active").length > 0 && (
              <button className="mobile-action-btn" onClick={printRx}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h10M4 17h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18 14l2 2-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <span>Rx</span>
              </button>
            )}
            <button className="mobile-action-btn" onClick={() => setMobileApptListOpen(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              <span>Appt</span>
            </button>
            {activeEntry?.rawText && (
              <div className="export-dropdown-wrap" style={{ position: "relative" }}>
                <button className="mobile-action-btn" onClick={() => setExportMenuOpen(v => !v)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  <span>Export</span>
                </button>
                {exportMenuOpen && (
                  <>
                    <div className="export-overlay" onClick={() => setExportMenuOpen(false)} />
                    <div className="export-menu--up" style={{ position: "fixed", bottom: "140px", right: "16px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "9px", padding: "4px", minWidth: "130px", boxShadow: "0 8px 24px rgba(0,0,0,0.25)", display: "flex", flexDirection: "column", gap: "1px", zIndex: 300 }}>
                      <button className="export-menu-item" onClick={() => { printReport(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><polyline points="6 9 6 2 18 2 18 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><rect x="6" y="14" width="12" height="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        Print
                      </button>
                      <button className="export-menu-item" onClick={() => { exportReport(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        PDF
                      </button>
                      <button className="export-menu-item" onClick={() => { exportWord(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        Word (.docx)
                      </button>
                      <button className="export-menu-item" onClick={() => { exportImage(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="2"/><polyline points="21 15 16 10 5 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        Image
                      </button>
                      <div style={{ height: "1px", background: "rgba(255,255,255,0.07)", margin: "4px 0" }} />
                      <button className="export-menu-item" onClick={() => { exportFullHistory(); setExportMenuOpen(false); }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="8" y1="13" x2="16" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="8" y1="17" x2="13" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                        Full History PDF
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {activeEntry && (
              <button className="mobile-action-btn" onClick={toggleFlag} style={isFlagged ? { color:"#ef4444" } : {}}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill={isFlagged ? "#ef4444" : "none"}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="4" y1="22" x2="4" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                <span>Flag</span>
              </button>
            )}
            {activeEntry?.rawText && !editMode && (
              <button className="mobile-action-btn" onClick={() => setEditMode(true)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                <span>Edit</span>
              </button>
            )}
            {selectedPatient && (
              <button className="mobile-action-btn" onClick={() => selectedPatient && exportPatientJson(selectedPatient)} title="Export patient data as JSON">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="18" cy="5" r="3" stroke="currentColor" strokeWidth="2"/><circle cx="6" cy="12" r="3" stroke="currentColor" strokeWidth="2"/><circle cx="18" cy="19" r="3" stroke="currentColor" strokeWidth="2"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                <span>Share</span>
              </button>
            )}
            {selectedPatient && deleteStep === 0 && (
              <button className="mobile-action-btn" style={{ color: "#ef4444" }} onClick={() => setDeleteStep(1)} title="Delete patient">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                <span>Delete</span>
              </button>
            )}
          </div>
        )}

        {/* ── Mobile: transcript + generate slide-up drawer ── */}
        {mobileTab === "report" && mobileTranscriptOpen && (
          <>
            <div
              className="mobile-transcript-drawer-overlay"
              onClick={() => setMobileTranscriptOpen(false)}
            />
            <div className="mobile-transcript-drawer">
              <div className="mobile-transcript-drawer-handle" />
              <div className="mobile-transcript-drawer-header">
                <span>Transcript &amp; Generate</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    onClick={() => { setMobileTranscriptOpen(false); openScanModal(); }}
                    title="Scan paper document"
                    style={{
                      background: "none",
                      border: "1.5px solid var(--border)",
                      borderRadius: 10,
                      padding: "12px 20px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      color: "#f59e0b",
                      fontSize: 14,
                      fontWeight: 700,
                      width: "100%",
                      marginTop: 12,
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
                      <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                      <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
                      <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                      <line x1="7" y1="12" x2="17" y2="12"/>
                    </svg>
                    Scan Doc
                  </button>
                  <button
                    className="mobile-transcript-drawer-close"
                    onClick={() => setMobileTranscriptOpen(false)}
                  >✕</button>
                </div>
              </div>
              <div className="mobile-transcript-drawer-body">
              {mediaRecorderUnsupported && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 12px", marginBottom: 8, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.35)", borderRadius: 8, fontSize: 12, color: "#fbbf24", lineHeight: 1.5 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: 1 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  Your browser may not fully support audio recording. For the best experience, please use Google Chrome or Microsoft Edge. Recording may not work correctly on Safari or older browsers.
                </div>
              )}
                {draftBanner && (
                  <div style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#f59e0b", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span>Draft restored from your last session.</span>
                    <button onClick={() => setDraftBanner(false)} style={{ background: "none", border: "none", color: "#f59e0b", cursor: "pointer", fontSize: 14, padding: "0 0 0 8px", minWidth: 44, minHeight: 44 }}>×</button>
                  </div>
                )}
                <textarea
                  className="transcript-textarea"
                  placeholder={"Paste session transcript here…\n\nExample:\nDoctor: How have you been feeling?\nPatient: Not well, trouble sleeping…"}
                  value={transcript}
                  onChange={e => setTranscript(e.target.value)}
                />
                {(() => {
                  const wc = transcript.trim() ? transcript.trim().split(/\s+/).filter(Boolean).length : 0;
                  const tooShort = wc > 0 && wc < 50;
                  const genDisabled = !selectedPatient || !transcript.trim() || wc < 50 || loading;
                  return (
                    <>
                      {tooShort && (
                        <div className="transcript-too-short">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                          Too short — min 50 words. Current: {wc} word{wc !== 1 ? "s" : ""}.
                        </div>
                      )}
                      <button
                        className="generate-btn"
                        onClick={() => { generateReport(); if (!loading) setMobileTranscriptOpen(false); }}
                        disabled={genDisabled}
                      >
                        {loading ? (
                          <>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="mic-spinner"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                            Generating report...
                          </>
                        ) : (
                          <>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            Generate Clinical Report
                          </>
                        )}
                      </button>
                      {generateError && !loading && (
                        failedMidStream ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.35)", borderRadius: 10 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, color: "#fbbf24" }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                              <span style={{ fontSize: 12, color: "#fbbf24", fontWeight: 600, lineHeight: 1.4 }}>Report interrupted mid-generation</span>
                            </div>
                            <span style={{ fontSize: 12, color: "rgba(251,191,36,0.85)", lineHeight: 1.5 }}>Your transcript is safe. Tap Retry to regenerate the full report.</span>
                            <button
                              onClick={generateReport}
                              style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6, background: "rgba(251,191,36,0.18)", border: "1px solid rgba(251,191,36,0.5)", color: "#fbbf24", borderRadius: 7, padding: "6px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: "0.01em" }}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.51 15a9 9 0 1 0 .49-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              Retry Generation
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontSize: 12, color: "#f87171" }}>
                            <span style={{ lineHeight: 1.5 }}>{generateError}</span>
                            <button
                              onClick={generateReport}
                              style={{ alignSelf: "flex-start", background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)", color: "#f87171", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                            >
                              Try again
                            </button>
                          </div>
                        )
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          </>
        )}
      </div>

      {noteModalOpen && (
        <div className="modal-overlay" onClick={() => setNoteModalOpen(false)} style={{ zIndex: 1050 }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ width: "min(480px, 95vw)" }}>
            <div className="modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <h3 className="modal-title">Session Note</h3>
                {selectedPatient && <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 400 }}>· {selectedPatient.name}</span>}
              </div>
              <button className="modal-close" onClick={() => setNoteModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.6 }}>
                Private notes for this session — not included in the report. Saved automatically.
              </p>
              <textarea
                style={{
                  width: "100%", minHeight: 180, fontSize: 13,
                  padding: "10px 12px", background: "var(--bg-card)", border: "1px solid var(--border)",
                  borderRadius: 8, color: "var(--text-primary)", resize: "vertical",
                  fontFamily: "inherit", lineHeight: 1.6, outline: "none", boxSizing: "border-box",
                }}
                placeholder={activeEntryId
                  ? "Private follow-up notes, reminders, impressions — not included in the report…"
                  : "Generate a report first to save notes to this session."}
                value={sessionNotes}
                disabled={!activeEntryId}
                onChange={e => handleNotesChange(e.target.value)}
                autoFocus
              />
              {!activeEntryId && (
                <p style={{ fontSize: 11, color: "#f59e0b", marginTop: 8 }}>
                  Generate a report for this patient first to enable notes.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {icdPopover && icdAnchor && (
        <div
          className="icd-popover"
          style={{
            position: "fixed",
            top: icdAnchor.top,
            left: Math.min(icdAnchor.left, window.innerWidth - 296),
            width: "min(280px, calc(100vw - 16px))",
            background: "#1a1a2e",
            border: "1px solid rgba(20,184,166,0.3)",
            borderRadius: 10,
            padding: 12,
            fontSize: 12,
            zIndex: 1200,
            lineHeight: 1.6,
            color: "var(--text-muted)",
          }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6, color: /^\d/.test(icdPopover.code) ? "#a78bfa" : "#14b8a6" }}>
            {/^\d/.test(icdPopover.code) ? "DSM-5-TR Reference" : "ICD-10 Reference"}
          </div>
          {icdPopover.loading && (
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="spinner" style={{ width: 14, height: 14 }} />
              Loading...
            </span>
          )}
          {icdPopover.error && !icdPopover.loading && (
            <span
              style={{ color: "#f87171", cursor: "pointer" }}
              onClick={() => {
                localStorage.removeItem(`psych_${/^\d/.test(icdPopover.code) ? "dsm" : "icd"}_${icdPopover.code}`);
                const rect = {
                  bottom: icdAnchor.top,
                  left: icdAnchor.left,
                  top: icdAnchor.top - 20,
                  right: icdAnchor.left,
                  width: 0,
                  height: 0,
                  x: icdAnchor.left,
                  y: icdAnchor.top - 20,
                  toJSON: () => ({}),
                } as DOMRect;
                void fetchIcdSummary(icdPopover.code, rect);
              }}
            >
              Could not load. Tap to retry.
            </span>
          )}
          {icdPopover.text && !icdPopover.loading && (
            <>
              <div style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>{icdPopover.text}</div>
              <button
                onClick={() => navigator.clipboard.writeText(icdPopover.text)}
                style={{
                  background: "none", border: "1px solid rgba(20,184,166,0.3)",
                  borderRadius: 6, padding: "4px 10px", color: "#14b8a6",
                  cursor: "pointer", fontSize: 11, minHeight: 44,
                }}
              >Copy</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Report section parser ───────────────────────────────────────
interface ParsedSection { title: string; content: string; isPriority?: boolean; }

function parseRawSections(raw: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let priorityAdded = false;

  // Pass 1: walk ### sections. If a PRIORITY FLAG heading is found,
  // capture its content instead of silently dropping it.
  const parts = raw.split(/(?=^###\s)/m);
  for (const part of parts) {
    const firstNL = part.indexOf("\n");
    if (firstNL === -1) continue;
    const heading = part.slice(0, firstNL).replace(/^###\s*/, "").replace(/^\d+\.\s*/, "").trim();
    const content = part.slice(firstNL + 1).trim();
    if (!heading || !content) continue;

    if (/PRIORITY\s*FLAG/i.test(heading)) {
      if (!priorityAdded) {
        // Prefer the inline-bold text if the AI nested it inside the section.
        const boldMatch = content.match(/\*\*PRIORITY\s*FLAG[^\n*]*\*\*/i);
        const flagContent = boldMatch
          ? boldMatch[0].replace(/^\*\*|\*\*$/g, "").replace(/^PRIORITY\s*FLAG\s*:?\s*/i, "").trim()
          : content;
        sections.push({ title: "PRIORITY FLAG", content: flagContent || content, isPriority: true });
        priorityAdded = true;
      }
      continue;
    }
    sections.push({ title: heading, content });
  }

  // Pass 2: some models emit the flag as a standalone bold line outside any ### section,
  // e.g. **PRIORITY FLAG:(moderate-high) ...** or **PRIORITY FLAG: ...**
  // Also catch it when it appears as the very first line with no ### heading.
  if (!priorityAdded) {
    const inlineMatch = raw.match(/\*\*PRIORITY\s*FLAG[^\n*]+\*\*/i);
    if (inlineMatch) {
      const raw_ = inlineMatch[0].replace(/^\*\*|\*\*$/g, "");
      const flagContent = raw_.replace(/^PRIORITY\s*FLAG\s*:?\s*/i, "").trim();
      sections.unshift({ title: "PRIORITY FLAG", content: flagContent || raw_, isPriority: true });
      priorityAdded = true;
    }
  }

  // Pass 3: unbolded plain-text PRIORITY FLAG line (some models omit the **)
  if (!priorityAdded) {
    const plainMatch = raw.match(/^PRIORITY\s*FLAG\s*:?\s*(.+)$/im);
    if (plainMatch) {
      const flagContent = plainMatch[1].trim();
      sections.unshift({ title: "PRIORITY FLAG", content: flagContent, isPriority: true });
    }
  }

  return sections;
}

// Renders saved edited HTML but makes ICD-10 and DSM-5-TR codes clickable
function EditedReportView({ html, onCodeClick }: {
  html: string;
  onCodeClick: (code: string, rect: DOMRect) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = DOMPurify.sanitize(html);
    // Find all text nodes and linkify codes
    const re = /\b([A-Z]\d{2}(?:\.\d{1,2})?|\d{3}\.\d{2})\b/g;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) textNodes.push(node as Text);
    for (const tn of textNodes) {
      const text = tn.nodeValue ?? "";
      if (!re.test(text)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const code = m[1];
        const isDsm = /^\d/.test(code);
        const span = document.createElement("span");
        span.textContent = code;
        span.style.color = isDsm ? "#a78bfa" : "#14b8a6";
        span.style.textDecoration = "underline dotted";
        span.style.cursor = "pointer";
        span.title = isDsm ? "DSM-5-TR code — tap for reference" : "ICD-10 code — tap for reference";
        span.addEventListener("click", (e) => {
          e.stopPropagation();
          onCodeClick(code, (e.currentTarget as HTMLElement).getBoundingClientRect());
        });
        frag.appendChild(span);
        last = m.index + m[0].length;
      }
      re.lastIndex = 0;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      tn.parentNode?.replaceChild(frag, tn);
    }
  }, [html]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={ref} className="report-wrap" />;
}

function linkifyIcdText(text: string, onIcdClick: (code: string, rect: DOMRect) => void): ReactNode[] {
  // Matches ICD-10 codes (e.g. F32.1) AND DSM-5-TR numeric codes (e.g. 296.22, 300.02)
  const re = /\b([A-Z]\d{2}(?:\.\d{1,2})?|\d{3}\.\d{2})\b/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const code = m[1];
    const isDsm = /^\d/.test(code);
    nodes.push(
      <span
        key={`icd-${m.index}-${code}`}
        style={{ color: isDsm ? "#a78bfa" : "#14b8a6", textDecoration: "underline dotted", cursor: "pointer", fontSize: "inherit" }}
        title={isDsm ? "DSM-5-TR code — tap for reference" : "ICD-10 code — tap for reference"}
        onClick={(e) => { e.stopPropagation(); onIcdClick(code, e.currentTarget.getBoundingClientRect()); }}
      >{code}</span>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : [text];
}

function linkifyIcdChildren(children: ReactNode, onIcdClick: (code: string, rect: DOMRect) => void): ReactNode {
  if (typeof children === "string") return linkifyIcdText(children, onIcdClick);
  if (Array.isArray(children)) return children.map((c, i) => <span key={i}>{linkifyIcdChildren(c, onIcdClick)}</span>);
  return children;
}

function CollapsibleBlock({ title, content, isPriority, defaultOpen = true, onIcdClick }: {
  title: string; content: string; isPriority?: boolean; defaultOpen?: boolean;
  onIcdClick?: (code: string, rect: DOMRect) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const mdComponents = onIcdClick ? {
    p: ({ children }: { children?: ReactNode }) => <p>{linkifyIcdChildren(children, onIcdClick)}</p>,
    li: ({ children }: { children?: ReactNode }) => <li>{linkifyIcdChildren(children, onIcdClick)}</li>,
    strong: ({ children }: { children?: ReactNode }) => {
      // Detect SOAP/DAP/BIRP/PIRP sub-section headers: **S - Subjective**, **O - Objective**, etc.
      const text = typeof children === "string" ? children : (Array.isArray(children) ? children.join("") : "");
      const isSoapHeader = /^[SOABIRDP]\s*[-–]\s*\w/i.test(text);
      if (isSoapHeader) {
        return <span className="soap-subheader">{linkifyIcdChildren(children, onIcdClick)}</span>;
      }
      return <strong>{linkifyIcdChildren(children, onIcdClick)}</strong>;
    },
    em: ({ children }: { children?: ReactNode }) => <em>{linkifyIcdChildren(children, onIcdClick)}</em>,
  } : {
    strong: ({ children }: { children?: ReactNode }) => {
      const text = typeof children === "string" ? children : (Array.isArray(children) ? children.join("") : "");
      const isSoapHeader = /^[SOABIRDP]\s*[-–]\s*\w/i.test(text);
      if (isSoapHeader) {
        return <span className="soap-subheader">{children}</span>;
      }
      return <strong>{children}</strong>;
    },
  };
  return (
    <div className={`report-block ${isPriority ? "report-block--priority" : ""}`}>
      <button className="report-block-header" onClick={() => setOpen(o => !o)}>
        <span className="report-block-title">
          {isPriority && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 5, flexShrink: 0 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13" stroke="white" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="17" x2="12.01" y2="17" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          )}
          {title}
        </span>
        <svg className="report-block-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="report-block-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

const SCALE_COLORS: Record<string, { bg: string; text: string }> = {
  "PHQ-9":  { bg: "#6366f1", text: "#fff" },
  "GAD-7":  { bg: "#f59e0b", text: "#fff" },
  "C-SSRS": { bg: "#ef4444", text: "#fff" },
};

function ScalesCard({ scores }: { scores: ScaleScore[] }) {
  return (
    <div className="scales-card">
      <div className="scales-card-header">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <path d="M9 12l3 3L22 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Scales Administered
      </div>
      <div className="scales-card-rows">
        {scores.map(s => {
          const color = SCALE_COLORS[s.scale] ?? { bg: "#64748b", text: "#fff" };
          return (
            <div key={s.scale} className="scales-card-row">
              <span className="scales-card-badge" style={{ background: color.bg, color: color.text }}>{s.scale}</span>
              {s.score !== null && <span className="scales-card-score">{s.score}</span>}
              <span className="scales-card-severity">{s.severity}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReportBlocks({ rawText, date, doctor, patientName, isFlagged, scaleScores, onIcdClick, onExpand, onCopy, copied, hasCollateral }: {
  rawText: string; date: string; doctor: DoctorProfile; patientName?: string; isFlagged: boolean; scaleScores?: ScaleScore[];
  onIcdClick?: (code: string, rect: DOMRect) => void;
  onExpand?: () => void; onCopy?: () => void; copied?: boolean; hasCollateral?: boolean;
}) {
  const sections = parseRawSections(rawText);
  return (
    <div className="report-wrap">
      <div className="report-title-row">
        <div>
          <h3 className="report-heading">Be Present. We'll Remember.</h3>
          <p className="report-meta">
            {formatDate(date)}
            {" · "}
            <span className="report-meta-doctor">{doctor.name}</span>
            {doctor.specialty ? `, ${doctor.specialty}` : ""}
            {doctor.clinic ? ` — ${doctor.clinic}` : ""}
            {patientName && (
              <>{" · Patient: "}<span className="report-meta-patient">{patientName}</span></>
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {isFlagged && <span className="flagged-badge">⚑ Flagged</span>}
          {hasCollateral && (
            <div className="report-collateral-badge">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              Collateral included
            </div>
          )}
          {onExpand && (
            <button className="edit-action-btn" style={{ fontSize: 12, padding: "6px 12px" }} onClick={onExpand} title="Expand report to full screen">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ marginRight: 4, verticalAlign: "middle" }}>
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Expand
            </button>
          )}
          {onCopy && (
            <button className="edit-action-btn" style={{ fontSize: 12, padding: "6px 12px" }} onClick={onCopy}>
              {copied ? "✓ Copied" : "Copy Report"}
            </button>
          )}
        </div>
      </div>
      {scaleScores && scaleScores.length > 0 && <ScalesCard scores={scaleScores} />}
      <div className="report-blocks-list">
        {sections.map((sec, i) => (
          <CollapsibleBlock key={i} title={sec.title} content={sec.content} isPriority={sec.isPriority} defaultOpen={sec.isPriority || i === 0} onIcdClick={onIcdClick} />
        ))}
      </div>
      <div className="ai-warning">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        <span><strong>Smart Documentation:</strong> This report was generated by our smart documentation service. Do not rely solely on this output for clinical decisions. Always apply your professional judgment and verify all information before use.</span>
      </div>
    </div>
  );
}

// ── MFA Setup Component ────────────────────────────────────────
function MfaSetup() {
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [factorId, setFactorId] = useState("");
  const [enrolled, setEnrolled] = useState<boolean | null>(null);

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data }) => {
      const verified = data?.totp?.find((f: { status: string }) => f.status === "verified");
      setEnrolled(!!verified);
    });
  }, []);

  async function startEnroll() {
    setBusy(true); setError("");
    const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: "totp", issuer: "Sphota", friendlyName: "Sphota Authenticator" });
    if (err || !data) { setError(err?.message ?? "Enrollment failed"); setBusy(false); return; }
    setFactorId(data.id);
    setQr(data.totp.qr_code);
    setSecret(data.totp.secret);
    setBusy(false);
  }

  async function verifyEnroll(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
    if (chErr) { setError(chErr.message); setBusy(false); return; }
    const { error: vErr } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code: code.trim() });
    if (vErr) { setError("Invalid code. Try again."); setBusy(false); return; }
    setSuccess(true); setEnrolled(true); setQr(""); setSecret(""); setBusy(false);
  }

  async function unenroll() {
    if (!confirm("Remove 2FA from your account?")) return;
    const { data } = await supabase.auth.mfa.listFactors();
    const factor = data?.totp?.find((f: { status: string; id: string }) => f.status === "verified");
    if (factor) await supabase.auth.mfa.unenroll({ factorId: factor.id });
    setEnrolled(false); setSuccess(false);
  }

  if (enrolled === null) return <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</p>;

  if (enrolled) return (
    <div style={{ padding: "16px", borderRadius: 10, border: "1px solid rgba(45,212,160,0.3)", background: "rgba(45,212,160,0.05)" }}>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#2dd4a0" }}>✓ Two-factor authentication is enabled</p>
      <button onClick={unenroll} style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Remove 2FA</button>
    </div>
  );

  if (success) return (
    <div style={{ padding: "16px", borderRadius: 10, border: "1px solid rgba(45,212,160,0.3)", background: "rgba(45,212,160,0.05)" }}>
      <p style={{ margin: 0, fontSize: 13, color: "#2dd4a0" }}>✓ Two-factor authentication enabled successfully.</p>
    </div>
  );

  return (
    <div style={{ padding: "16px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-card)" }}>
      <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Enable Two-Factor Authentication</p>
      {!qr ? (
        <button onClick={startEnroll} disabled={busy} style={{ padding: "9px 20px", borderRadius: 8, background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
          {busy ? "Setting up…" : "Set up 2FA"}
        </button>
      ) : (
        <form onSubmit={verifyEnroll}>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>Scan this QR code with Google Authenticator, Authy, or any TOTP app:</p>
          <img src={qr} alt="2FA QR Code" style={{ width: 160, height: 160, borderRadius: 8, marginBottom: 12, display: "block" }} />
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, wordBreak: "break-all" }}>Manual key: {secret}</p>
          <input
            type="text" inputMode="numeric" placeholder="Enter 6-digit code"
            maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-base)", color: "var(--text-primary)", fontSize: 18, letterSpacing: "0.3em", textAlign: "center", boxSizing: "border-box", marginBottom: 10 }}
          />
          {error && <p style={{ color: "#f87171", fontSize: 12, margin: "0 0 10px" }}>{error}</p>}
          <button type="submit" disabled={busy || code.length !== 6} style={{ width: "100%", padding: "10px", borderRadius: 8, background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
            {busy ? "Verifying…" : "Activate 2FA"}
          </button>
        </form>
      )}
    </div>
  );
}

function ProfileModal({ draft, onChange, onSave, onClose, onPrintConsent, onChangePin }: {
  draft: DoctorProfile; onChange: (d: DoctorProfile) => void; onSave: () => void; onClose: () => void; onPrintConsent: () => void; onChangePin?: () => void;
}) {
  const [autoLockMins, setAutoLockMins] = useState<string>(() => localStorage.getItem("psych_autolock_mins") ?? "5");
  const [backupStatus, setBackupStatus] = useState<"idle" | "exporting" | "done">("idle");
  const [restoreStatus, setRestoreStatus] = useState<"idle" | "confirming" | "restoring">("idle");
  const [restoreError, setRestoreError] = useState("");
  const [pendingBackup, setPendingBackup] = useState<object | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleteAccountStep, setDeleteAccountStep] = useState<0 | 1 | 2>(0);
  const [deleteAccountError, setDeleteAccountError] = useState("");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteStatus, setInviteStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [inviteMsg, setInviteMsg] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [receptionistList, setReceptionistList] = useState<{ id: string; name: string; email: string }[]>([]);
  const [receptionistListLoading, setReceptionistListLoading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function loadReceptionistList() {
    setReceptionistListLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const resp = await fetch("/api/receptionist/manage", {
        headers: { "Authorization": `Bearer ${session.access_token}` },
      });
      const text = await resp.text();
      if (resp.ok && text) {
        try { setReceptionistList(JSON.parse(text)); } catch { /* ignore parse error */ }
      }
    } catch { /* silent */ } finally { setReceptionistListLoading(false); }
  }

  useEffect(() => { loadReceptionistList(); }, []);

  async function handleRemoveReceptionist(id: string) {
    setRemovingId(id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const resp = await fetch(`/api/receptionist/manage?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${session.access_token}` },
      });
      // Read text to drain the body — avoids "body already consumed" errors
      await resp.text();
      if (resp.ok) {
        setReceptionistList(prev => prev.filter(r => r.id !== id));
        await loadReceptionistList(); // confirm removal from server
      }
    } catch { /* silent */ } finally { setRemovingId(null); }
  }

  async function handleInviteReceptionist() {
    if (!inviteEmail.trim() || !inviteEmail.includes("@")) {
      setInviteMsg("Please enter a valid email address.");
      setInviteStatus("error");
      return;
    }
    setInviteStatus("sending");
    setInviteMsg("");
    setInviteLink(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Not signed in — please reload and try again.");

      const email = inviteEmail.trim().toLowerCase();
      const uid = session.user.id;

      const { data: invite, error: inviteErr } = await supabase
        .from("receptionist_invites")
        .insert({
          doctor_user_id: uid,
          email: email,
          used: false,
        })
        .select()
        .single();

      if (inviteErr) throw new Error(inviteErr.message ?? "Could not create invite. Check Supabase table exists.");

      const origin = window.location.origin || "https://sphota.vercel.app";
      const link = `${origin}/?invite_code=${encodeURIComponent(invite.id)}&invite_email=${encodeURIComponent(email)}&doctor_id=${encodeURIComponent(uid)}`;

      setInviteStatus("done");
      setInviteLink(link);
      setInviteMsg("Link ready — copy and send it directly to your receptionist. No email is sent.");
      setInviteEmail("");
      loadReceptionistList();
    } catch (e: any) {
      setInviteStatus("error");
      setInviteMsg(e.message ?? "Failed to create invite. Please try again.");
    }
  }

  async function handleDeleteAccount() {
    setDeleteAccountStep(2);
    setDeleteAccountError("");
    try {
      await db.deleteAccount();
      window.location.reload();
    } catch (e: any) {
      setDeleteAccountError(e.message || "Deletion failed. Please try again.");
      setDeleteAccountStep(1);
    }
  }

  async function handleExport() {
    setBackupStatus("exporting");
    try {
      const data = await db.exportBackup();
      const date = new Date().toISOString().slice(0, 10);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `sphota-backup-${date}.json`; a.click();
      URL.revokeObjectURL(url);
      setBackupStatus("done");
      setTimeout(() => setBackupStatus("idle"), 3000);
    } catch {
      setBackupStatus("idle");
      setRestoreError("Export failed. Please try again.");
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setRestoreError("");
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!Array.isArray(data.patients)) {
          setRestoreError("Invalid backup file: missing patients data.");
          return;
        }
        setPendingBackup(data);
        setRestoreStatus("confirming");
      } catch {
        setRestoreError("Could not read file. Make sure it's a valid Sphota backup.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function confirmRestore() {
    if (!pendingBackup) return;
    setRestoreStatus("restoring");
    setRestoreError("");
    try {
      await db.importBackup(pendingBackup as Parameters<typeof db.importBackup>[0]);
      window.location.reload();
    } catch (e: any) {
      setRestoreError(e.message || "Restore failed. Please try again.");
      setRestoreStatus("idle");
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Doctor Profile</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <label className="modal-label">Full Name</label>
          <input className="modal-input" value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })} placeholder="Dr. First Last" />
          <label className="modal-label">Specialty</label>
          <input className="modal-input" value={draft.specialty} onChange={e => onChange({ ...draft, specialty: e.target.value })} placeholder="e.g. Psychiatry" />
          <label className="modal-label">Clinic / Practice Name</label>
          <input className="modal-input" value={draft.clinic} onChange={e => onChange({ ...draft, clinic: e.target.value })} placeholder="e.g. Westside Mental Health" />
          <label className="modal-label">Phone / Contact Number</label>
          <input className="modal-input" value={draft.contact ?? ""} onChange={e => onChange({ ...draft, contact: e.target.value })} placeholder="e.g. +91 98765 43210" />
          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "20px 0 16px" }} />
          <p className="modal-label" style={{ marginBottom: 12, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>Security</p>
          <label className="modal-label">Auto-lock after inactivity</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
            {[
              { label: "5 min",  value: "5"  },
              { label: "10 min", value: "10" },
              { label: "15 min", value: "15" },
              { label: "20 min", value: "20" },
              { label: "Never",  value: "0"  },
            ].map(opt => {
              const active = autoLockMins === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setAutoLockMins(opt.value);
                    localStorage.setItem("psych_autolock_mins", opt.value);
                    window.dispatchEvent(new Event("psych_autolock_changed"));
                  }}
                  style={{
                    padding: "6px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                    border: active ? "1.5px solid var(--accent)" : "1.5px solid var(--border)",
                    background: active ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "var(--bg-card)",
                    color: active ? "var(--accent)" : "var(--text-muted)",
                    fontWeight: active ? 600 : 400,
                    transition: "all 0.15s",
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, marginBottom: 0 }}>
            Locks the app and requires PIN re-entry after the selected idle period.
          </p>

          <label className="modal-label" style={{ marginTop: 14 }}>PIN</label>
          <button
            type="button"
            onClick={() => { onClose(); setTimeout(() => onChangePin?.(), 100); }}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "8px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
              border: "1.5px solid var(--border)", background: "var(--bg-card)",
              color: "var(--text-muted)", fontWeight: 500, width: "fit-content",
              transition: "all 0.15s",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            Change PIN
          </button>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, marginBottom: 0 }}>
            Change your app lock PIN.
          </p>

          <label className="modal-label" style={{ marginTop: 14 }}>Data retention — auto-delete old sessions</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
            {[
              { label: "1 year",  value: "1"     },
              { label: "3 years", value: "3"     },
              { label: "5 years", value: "5"     },
              { label: "Never",   value: "never" },
            ].map(opt => {
              const active = (draft.dataRetentionYears ?? "never") === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ ...draft, dataRetentionYears: opt.value as DoctorProfile["dataRetentionYears"] })}
                  style={{
                    padding: "6px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                    border: active ? "1.5px solid var(--accent)" : "1.5px solid var(--border)",
                    background: active ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "var(--bg-card)",
                    color: active ? "var(--accent)" : "var(--text-muted)",
                    fontWeight: active ? 600 : 400,
                    transition: "all 0.15s",
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, marginBottom: 0 }}>
            Sessions older than this will be flagged for deletion on next login. DPDP Act 2023 §8(7).
          </p>

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "20px 0 16px" }} />
          <p className="modal-label" style={{ marginBottom: 12, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>Two-Factor Authentication</p>
          <MfaSetup />

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "20px 0 16px" }} />
          <p className="modal-label" style={{ marginBottom: 12, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>Receptionist</p>

          {/* ── Current receptionists ── */}
          {receptionistListLoading ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", marginBottom: 12 }}>
              <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</span>
            </div>
          ) : receptionistList.length > 0 ? (
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>Linked Receptionist</p>
              {receptionistList.map(r => (
                <div key={r.id} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  background: "var(--bg-card, #1a1a1d)", border: "1px solid var(--border)",
                  borderRadius: 8, padding: "10px 12px", marginBottom: 6,
                }}>
                  <div style={{
                    width: 30, height: 30, borderRadius: "50%",
                    background: "rgba(59,130,246,0.15)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 700, color: "#93c5fd", flexShrink: 0,
                  }}>
                    {(r.email || r.name || "R").charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                      {r.email || r.name || "Receptionist"}
                    </div>
                    {r.email && r.name && r.name !== r.email && (
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{r.name}</div>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemoveReceptionist(r.id)}
                    disabled={removingId === r.id}
                    style={{
                      padding: "5px 11px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
                      border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.08)",
                      color: "#f87171", flexShrink: 0, transition: "all 0.15s",
                    }}
                  >
                    {removingId === r.id ? "Removing…" : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
            Generate a link to send to your receptionist. They can sign up directly — no email confirmation required.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="modal-input"
              style={{ flex: 1, marginBottom: 0 }}
              type="email"
              placeholder="receptionist@example.com"
              value={inviteEmail}
              onChange={e => { setInviteEmail(e.target.value); setInviteStatus("idle"); setInviteMsg(""); }}
              disabled={inviteStatus === "sending"}
            />
            <button
              className="modal-cancel"
              style={{ flexShrink: 0, padding: "0 16px" }}
              onClick={handleInviteReceptionist}
              disabled={inviteStatus === "sending" || !inviteEmail.trim()}
            >
              {inviteStatus === "sending" ? "Generating…" : "Generate Link"}
            </button>
          </div>
          {inviteMsg && (
            <p style={{ fontSize: 12, color: inviteStatus === "done" ? "#10b981" : "#ef4444", marginTop: 8, marginBottom: inviteLink ? 8 : 0 }}>
              {inviteMsg}
            </p>
          )}
          {inviteLink && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", background: "var(--bg-card, #1a1a2e)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inviteLink}</span>
              <button
                className="modal-cancel"
                style={{ flexShrink: 0, padding: "4px 10px", fontSize: 11 }}
                onClick={() => { navigator.clipboard.writeText(inviteLink); }}
              >
                Copy
              </button>
            </div>
          )}

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "20px 0 16px" }} />
          <p className="modal-label" style={{ marginBottom: 12, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>Data Backup &amp; Restore</p>

          <button
            type="button"
            onClick={onPrintConsent}
            style={{
              width: "100%", padding: "9px 14px", borderRadius: 8,
              border: "1px solid var(--border-mid)", background: "var(--bg-raised)",
              color: "var(--text-secondary)", fontSize: 13, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            Print Patient Consent Form (DPDP)
          </button>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="modal-cancel"
              style={{ flex: 1 }}
              onClick={handleExport}
              disabled={backupStatus === "exporting"}
            >
              {backupStatus === "exporting" ? "Exporting…" : backupStatus === "done" ? "✓ Downloaded" : "⬇ Backup Data"}
            </button>
            <button
              className="modal-cancel"
              style={{ flex: 1 }}
              onClick={() => { setRestoreError(""); fileInputRef.current?.click(); }}
              disabled={restoreStatus === "restoring"}
            >
              ⬆ Restore from Backup
            </button>
            <input ref={fileInputRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleFileChange} />
          </div>

          {restoreStatus === "confirming" && (
            <div style={{ marginTop: 12, padding: "12px", background: "var(--bg-card)", borderRadius: 8, border: "1px solid var(--border)" }}>
              <p style={{ fontSize: 13, color: "var(--text)", marginBottom: 10 }}>
                This will <strong>overwrite all current data</strong> with the backup. Are you sure?
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="modal-cancel" style={{ flex: 1 }} onClick={() => { setRestoreStatus("idle"); setPendingBackup(null); }}>Cancel</button>
                <button className="modal-save" style={{ flex: 1 }} onClick={confirmRestore}>Yes, Restore</button>
              </div>
            </div>
          )}

          {restoreStatus === "restoring" && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, textAlign: "center" }}>Restoring data…</p>
          )}

          {restoreError && (
            <p style={{ fontSize: 12, color: "#ef4444", marginTop: 10 }}>{restoreError}</p>
          )}

          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 10 }}>
            Backup includes all patients, reports, and medications. Restore replaces everything.
          </p>

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "20px 0 16px" }} />
          <p className="modal-label" style={{ marginBottom: 10, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>Account</p>
          <button
            type="button"
            onClick={async () => {
              localStorage.removeItem("psych_pending_country");
              sessionStorage.clear();
              await supabase.auth.signOut();
              window.location.href = "/";
            }}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 8, marginBottom: 16,
              border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.07)",
              color: "#f87171", fontSize: 13, fontWeight: 600, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="16 17 21 12 16 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="21" y1="12" x2="9" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            Sign Out
          </button>

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "0 0 16px" }} />
          <p className="modal-label" style={{ marginBottom: 12, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "#ef4444" }}>Danger Zone</p>

          <button
            className="download-all-data-btn"
            onClick={handleExport}
            disabled={backupStatus === "exporting"}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            {backupStatus === "exporting" ? "Preparing download…" : backupStatus === "done" ? "✓ Download started" : "Download All My Data"}
          </button>

          {deleteAccountStep === 0 && (
            <>
              {/* Withdraw Consent — DPDP Act 2023 */}
              <button
                className="delete-account-btn"
                style={{ background: "rgba(20,184,166,0.08)", borderColor: "rgba(20,184,166,0.25)", color: "#14b8a6" }}
                onClick={async () => {
                  if (!confirm("Withdraw consent? You will be shown the consent screen again on next login. Your data is not deleted.")) return;
                  await fetch("/api/consent?action=withdraw", {
                    method: "POST", credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ consentType: "terms_and_privacy" }),
                  });
                  alert("Consent withdrawn. You will be logged out.");
                  window.location.href = "/api/logout";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="16 17 21 12 16 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="21" y1="12" x2="9" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Withdraw Consent (DPDP)
              </button>

              <button
                className="delete-account-btn"
                onClick={() => setDeleteAccountStep(1)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                Delete My Account
              </button>
            </>
          )}

          {deleteAccountStep === 1 && (
            <div className="delete-account-confirm-box">
              <div className="delete-account-confirm-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </div>
              <p className="delete-account-confirm-text">
                This will permanently delete your account and all patient data. This cannot be undone.
              </p>
              {deleteAccountError && (
                <p style={{ fontSize: 12, color: "#ef4444", marginTop: 8, marginBottom: 0 }}>{deleteAccountError}</p>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button className="modal-cancel" style={{ flex: 1 }} onClick={() => { setDeleteAccountStep(0); setDeleteAccountError(""); }}>
                  Cancel
                </button>
                <button className="delete-account-confirm-btn" style={{ flex: 1 }} onClick={handleDeleteAccount}>
                  Yes, delete everything
                </button>
              </div>
            </div>
          )}

          {deleteAccountStep === 2 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0" }}>
              <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Deleting your account and all data…</span>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-save" onClick={onSave}>Save Profile</button>
        </div>
      </div>
    </div>
  );
}
