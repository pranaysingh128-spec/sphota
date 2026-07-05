import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase";

// ── Route: /xlog  — unlisted, owner-only ─────────────────────────────────────
// Access gate: user.id must match VITE_OWNER_DOCTOR_ID env var.
// Every API call re-verifies server-side via OWNER_DOCTOR_ID (no VITE_ prefix).
// Other users get a plain 404 — the route is never revealed.

const OWNER_ID = import.meta.env.VITE_OWNER_DOCTOR_ID as string ?? "";

// ── Design tokens ─────────────────────────────────────────────────────────────
const NAVY   = "#080c18";
const CARD   = "#0f1624";
const CARD2  = "#121926";
const BORDER = "rgba(255,255,255,0.07)";
const TEXT1  = "#f0f4f8";
const TEXT2  = "#8898aa";
const TEAL   = "#14b8a6";
const GREEN  = "#4ade80";
const RED    = "#f87171";
const AMBER  = "#fbbf24";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Entry {
  id: string;
  created_at: string;
  doctor_id: string;
  category: "doctor" | "build" | "learning" | "note" | null;
  raw_input: string;
  structured_data: Record<string, any> | null;
  status: string | null;
  doctor_name_normalized: string | null;
}

interface Snapshot {
  totalSignups: number;
  totalReportsGenerated: number;
  activeThisWeek: number;
}

interface Email {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  receivedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

function fmt(dt: string) {
  try {
    return new Date(dt).toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return dt; }
}

function fmtShort(dt: string) {
  try {
    return new Date(dt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch { return dt; }
}

const catColor = (cat: Entry["category"]) =>
  cat === "doctor" ? TEAL : cat === "build" ? "#818cf8" : cat === "learning" ? GREEN : TEXT2;

const catLabel = (cat: Entry["category"]) =>
  cat === "doctor" ? "Doctor" : cat === "build" ? "Build" : cat === "learning" ? "Learning" : "Note";

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: "16px 20px", flex: "1 1 140px", minWidth: 120 }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: TEAL, marginBottom: 4 }}>{value}</div>
      <div style={{ fontSize: 12, color: TEXT2 }}>{label}</div>
    </div>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      background: `${color}18`, color, fontSize: 11, fontWeight: 700,
      padding: "3px 10px", borderRadius: 999, textTransform: "uppercase", letterSpacing: "0.05em",
    }}>
      {text}
    </span>
  );
}

// ── Inline editor for structured_data fields ──────────────────────────────────
function InlineField({ label, value, onSave }: { label: string; value: any; onSave: (v: any) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value ?? ""));
  const isBoolean = typeof value === "boolean";

  if (isBoolean) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: TEXT2, minWidth: 120 }}>{label}</span>
        <button
          onClick={() => onSave(!value)}
          style={{ background: value ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.12)", border: `1px solid ${value ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`, borderRadius: 6, padding: "2px 12px", color: value ? GREEN : RED, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
        >
          {value ? "Yes" : "No"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
      <span style={{ fontSize: 12, color: TEXT2, minWidth: 120, paddingTop: 4 }}>{label}</span>
      {editing ? (
        <div style={{ display: "flex", gap: 6, flex: 1 }}>
          <textarea
            value={val}
            onChange={e => setVal(e.target.value)}
            rows={2}
            style={{ flex: 1, background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 7, padding: "4px 8px", color: TEXT1, fontSize: 12, fontFamily: "inherit", resize: "vertical", outline: "none" }}
            autoFocus
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <button onClick={() => { onSave(val); setEditing(false); }} style={{ background: "rgba(20,184,166,0.12)", border: `1px solid rgba(20,184,166,0.3)`, borderRadius: 6, padding: "3px 10px", color: TEAL, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Save</button>
            <button onClick={() => { setVal(String(value ?? "")); setEditing(false); }} style={{ background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 6, padding: "3px 10px", color: TEXT2, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
          </div>
        </div>
      ) : (
        <span
          onClick={() => setEditing(true)}
          style={{ fontSize: 12, color: TEXT1, flex: 1, cursor: "pointer", borderBottom: `1px dashed ${BORDER}`, paddingBottom: 1, lineHeight: 1.5 }}
          title="Click to edit"
        >
          {String(value ?? "—")}
        </span>
      )}
    </div>
  );
}

// ── Entry card ────────────────────────────────────────────────────────────────
function EntryCard({ entry, onUpdate }: { entry: Entry; onUpdate: (updated: Entry) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  async function patchField(key: string, val: any) {
    setSaving(true);
    const newSD = { ...(entry.structured_data ?? {}), [key]: val };
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await fetch("/api/command-log/update-entry", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ id: entry.id, structured_data: newSD }),
    });
    if (res.ok) {
      const j = await res.json() as { entry: Entry };
      onUpdate(j.entry);
    }
    setSaving(false);
  }

  async function patchStatus(newStatus: string) {
    setSaving(true);
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await fetch("/api/command-log/update-entry", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ id: entry.id, status: newStatus }),
    });
    if (res.ok) {
      const j = await res.json() as { entry: Entry };
      onUpdate(j.entry);
    }
    setSaving(false);
  }

  const sd = entry.structured_data ?? {};
  const cat = entry.category;

  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 13, overflow: "hidden", marginBottom: 8 }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{ padding: "13px 16px", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 12 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            {cat && <Badge text={catLabel(cat)} color={catColor(cat)} />}
            {entry.status === "ai_failed" && <Badge text="AI failed" color={AMBER} />}
            {entry.status && entry.status !== "ai_failed" && entry.status !== "pending" && (
              <span style={{ fontSize: 11, color: TEXT2, fontStyle: "italic" }}>{entry.status}</span>
            )}
            <span style={{ fontSize: 11, color: TEXT2 }}>{fmt(entry.created_at)}</span>
            {saving && <span style={{ fontSize: 11, color: TEAL }}>saving…</span>}
          </div>
          <p style={{ fontSize: 13, color: TEXT1, margin: 0, lineHeight: 1.5, whiteSpace: "pre-wrap", display: expanded ? "block" : "-webkit-box", WebkitLineClamp: expanded ? undefined : 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {entry.raw_input}
          </p>
        </div>
        <span style={{ color: TEXT2, fontSize: 16, flexShrink: 0, marginTop: 2 }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div style={{ borderTop: `1px solid ${BORDER}`, padding: "14px 16px", background: CARD2 }}>
          {/* Status field */}
          <InlineField label="status" value={entry.status ?? ""} onSave={patchStatus} />

          {/* Category-specific structured fields */}
          {cat === "doctor" && <>
            <InlineField label="name" value={sd.name} onSave={v => patchField("name", v)} />
            <InlineField label="city" value={sd.city} onSave={v => patchField("city", v)} />
            <InlineField label="contact method" value={sd.contact_method} onSave={v => patchField("contact_method", v)} />
            <InlineField label="stage" value={sd.stage} onSave={v => patchField("stage", v)} />
            <InlineField label="summary" value={sd.summary} onSave={v => patchField("summary", v)} />
            <InlineField label="follow-up needed" value={sd.follow_up_needed} onSave={v => patchField("follow_up_needed", v)} />
            {sd.follow_up_needed && <InlineField label="follow-up what" value={sd.follow_up_what} onSave={v => patchField("follow_up_what", v)} />}
          </>}

          {cat === "build" && <>
            <InlineField label="what changed" value={sd.what_changed} onSave={v => patchField("what_changed", v)} />
            <InlineField label="deployed" value={sd.deployed} onSave={v => patchField("deployed", typeof v === "boolean" ? v : v === "true")} />
            <InlineField label="verified working" value={sd.verified_working} onSave={v => patchField("verified_working", typeof v === "boolean" ? v : v === "true")} />
          </>}

          {cat === "learning" && <>
            <InlineField label="topic" value={sd.topic} onSave={v => patchField("topic", v)} />
            <InlineField label="day number" value={sd.day_number} onSave={v => patchField("day_number", v ? Number(v) : null)} />
            <InlineField label="completed" value={sd.completed} onSave={v => patchField("completed", typeof v === "boolean" ? v : v === "true")} />
          </>}

          {cat === "note" && <>
            <InlineField label="title" value={sd.title} onSave={v => patchField("title", v)} />
            <InlineField label="content" value={sd.content} onSave={v => patchField("content", v)} />
          </>}

          {/* Raw input always preserved below */}
          <details style={{ marginTop: 12 }}>
            <summary style={{ fontSize: 11, color: TEXT2, cursor: "pointer" }}>Raw input (original, never altered)</summary>
            <pre style={{ fontSize: 11, color: TEXT2, margin: "8px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word", background: CARD, borderRadius: 8, padding: 10, border: `1px solid ${BORDER}` }}>
              {entry.raw_input}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

// ── Doctors tab ───────────────────────────────────────────────────────────────
function DoctorsTab({ entries }: { entries: Entry[] }) {
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);

  const doctorEntries = entries.filter(e => e.category === "doctor");
  const groups: Map<string, Entry[]> = new Map();
  for (const e of doctorEntries) {
    const key = e.doctor_name_normalized ?? e.structured_data?.name ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  const sorted = [...groups.entries()].sort((a, b) =>
    new Date(b[1][0].created_at).getTime() - new Date(a[1][0].created_at).getTime()
  );

  if (!sorted.length) return <p style={{ color: TEXT2, padding: "40px 0", textAlign: "center" }}>No doctor entries yet.</p>;

  return (
    <div>
      {sorted.map(([key, docEntries]) => {
        const latest = docEntries[0];
        const sd = latest.structured_data ?? {};
        const isOpen = expandedDoc === key;
        return (
          <div key={key} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, marginBottom: 10, overflow: "hidden" }}>
            <div onClick={() => setExpandedDoc(isOpen ? null : key)} style={{ padding: "14px 18px", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 14 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(20,184,166,0.10)", border: `1px solid rgba(20,184,166,0.15)`, display: "flex", alignItems: "center", justifyContent: "center", color: TEAL, fontWeight: 700, fontSize: 15, flexShrink: 0 }}>
                {(sd.name || key).charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: TEXT1, marginBottom: 4 }}>{sd.name || key}</div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  {sd.city && <span style={{ fontSize: 12, color: TEXT2 }}>📍 {sd.city}</span>}
                  {sd.stage && <Badge text={sd.stage} color={TEAL} />}
                  {sd.follow_up_needed && <Badge text="Follow-up needed" color={AMBER} />}
                </div>
                <p style={{ fontSize: 12, color: TEXT2, margin: "6px 0 0", lineHeight: 1.5 }}>{sd.summary ?? latest.raw_input.slice(0, 100)}</p>
              </div>
              <div style={{ flexShrink: 0, textAlign: "right" }}>
                <div style={{ fontSize: 11, color: TEXT2 }}>{docEntries.length} {docEntries.length === 1 ? "entry" : "entries"}</div>
                <div style={{ fontSize: 11, color: TEXT2, marginTop: 2 }}>{fmtShort(latest.created_at)}</div>
              </div>
              <span style={{ color: TEXT2, fontSize: 14, flexShrink: 0, alignSelf: "center" }}>{isOpen ? "▲" : "▼"}</span>
            </div>
            {isOpen && (
              <div style={{ borderTop: `1px solid ${BORDER}`, padding: "12px 18px", background: CARD2 }}>
                <p style={{ fontSize: 12, color: TEXT2, margin: "0 0 12px" }}>Full history ({docEntries.length} entries)</p>
                {docEntries.map(e => (
                  <div key={e.id} style={{ borderLeft: `3px solid ${TEAL}`, paddingLeft: 12, marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: TEXT2, marginBottom: 4 }}>{fmt(e.created_at)}</div>
                    <div style={{ fontSize: 12, color: TEXT1, marginBottom: 4 }}>Stage: <strong>{e.structured_data?.stage ?? "—"}</strong></div>
                    <p style={{ fontSize: 12, color: TEXT2, margin: 0, lineHeight: 1.5 }}>{e.structured_data?.summary ?? e.raw_input}</p>
                    {e.structured_data?.follow_up_what && (
                      <p style={{ fontSize: 12, color: AMBER, margin: "4px 0 0" }}>→ {e.structured_data.follow_up_what}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Build tab ─────────────────────────────────────────────────────────────────
function BuildTab({ entries, onUpdate }: { entries: Entry[]; onUpdate: (e: Entry) => void }) {
  const build = entries.filter(e => e.category === "build");
  if (!build.length) return <p style={{ color: TEXT2, padding: "40px 0", textAlign: "center" }}>No build entries yet.</p>;
  return (
    <div>
      {build.map(e => {
        const sd = e.structured_data ?? {};
        return (
          <div key={e.id} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px 16px", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: TEXT2 }}>{fmtShort(e.created_at)}</span>
              <Badge text={sd.deployed ? "Deployed ✓" : "Not deployed"} color={sd.deployed ? GREEN : TEXT2} />
              <Badge text={sd.verified_working ? "Verified ✓" : "Not verified"} color={sd.verified_working ? GREEN : RED} />
            </div>
            <p style={{ fontSize: 13, color: TEXT1, margin: 0, lineHeight: 1.5 }}>{sd.what_changed ?? e.raw_input}</p>
          </div>
        );
      })}
    </div>
  );
}

// ── Learning tab ──────────────────────────────────────────────────────────────
function LearningTab({ entries }: { entries: Entry[] }) {
  const learning = entries.filter(e => e.category === "learning");
  if (!learning.length) return <p style={{ color: TEXT2, padding: "40px 0", textAlign: "center" }}>No learning entries yet.</p>;
  return (
    <div>
      {learning.map(e => {
        const sd = e.structured_data ?? {};
        return (
          <div key={e.id} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px 16px", marginBottom: 8, display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: TEXT2 }}>{fmtShort(e.created_at)}</span>
                {sd.day_number != null && <Badge text={`Day ${sd.day_number}`} color="#818cf8" />}
                <Badge text={sd.completed ? "Completed ✓" : "In progress"} color={sd.completed ? GREEN : AMBER} />
              </div>
              <p style={{ fontSize: 13, color: TEXT1, margin: 0, lineHeight: 1.5 }}>{sd.topic ?? e.raw_input}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Gmail panel ───────────────────────────────────────────────────────────────
function GmailPanel() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [expired, setExpired] = useState(false);
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");
  const [connecting, setConnecting] = useState(false);

  const loadEmails = useCallback(async (q = "") => {
    setLoading(true);
    setErr("");
    const headers = await authHeader();
    const res = await fetch(`/api/command-log/gmail-emails?q=${encodeURIComponent(q)}`, { headers });
    const j = await res.json() as any;
    setConnected(j.connected ?? false);
    setExpired(j.expired ?? false);
    if (j.connected && !j.expired) setEmails(j.emails ?? []);
    if (j.error) setErr(j.error);
    setLoading(false);
  }, []);

  useEffect(() => { loadEmails(); }, [loadEmails]);

  // Handle Gmail OAuth redirect result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail_connected") === "1") {
      window.history.replaceState({}, "", "/xlog");
      loadEmails();
    }
    if (params.get("gmail_error")) {
      setErr("Gmail connection failed: " + params.get("gmail_error"));
      window.history.replaceState({}, "", "/xlog");
    }
  }, [loadEmails]);

  async function startOAuth() {
    setConnecting(true);
    const headers = await authHeader();
    const res = await fetch("/api/command-log/gmail-auth", { headers });
    if (!res.ok) { setErr("Failed to start Gmail OAuth — check server config"); setConnecting(false); return; }
    const j = await res.json() as { url: string };
    window.location.href = j.url;
  }

  if (connected === null) return <div style={{ padding: 20, color: TEXT2, textAlign: "center" }}>Loading Gmail status…</div>;

  if (!connected || expired) {
    return (
      <div style={{ padding: "20px 0" }}>
        {err && <p style={{ color: RED, fontSize: 13, marginBottom: 12 }}>{err}</p>}
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: "24px", maxWidth: 420 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 8px", color: TEXT1 }}>
            {expired ? "Reconnect Gmail" : "Connect Gmail"}
          </h3>
          <p style={{ fontSize: 13, color: TEXT2, margin: "0 0 20px", lineHeight: 1.6 }}>
            {expired
              ? "Your Gmail session has expired. Reconnect to continue reading emails."
              : "Connect your Gmail (read-only) to view recent inbox emails here. No emails will ever be sent or modified."}
          </p>
          <button
            onClick={startOAuth}
            disabled={connecting}
            style={{ background: TEAL, border: "none", borderRadius: 10, padding: "11px 24px", color: "#fff", fontWeight: 700, fontSize: 14, cursor: connecting ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: connecting ? 0.6 : 1 }}
          >
            {connecting ? "Redirecting…" : expired ? "Reconnect Gmail →" : "Connect Gmail →"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 0" }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && loadEmails(query)}
          placeholder="Search by sender or keyword…"
          style={{ flex: 1, maxWidth: 360, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 9, padding: "9px 12px", color: TEXT1, fontSize: 13, fontFamily: "inherit", outline: "none" }}
        />
        <button onClick={() => loadEmails(query)} disabled={loading} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 9, padding: "9px 16px", color: TEXT2, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
          {loading ? "…" : "Search"}
        </button>
        <button onClick={() => loadEmails("")} disabled={loading} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 9, padding: "9px 16px", color: TEXT2, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
          ↺ Refresh
        </button>
      </div>
      {err && <p style={{ color: RED, fontSize: 13, marginBottom: 10 }}>{err}</p>}
      {loading && <p style={{ color: TEXT2, textAlign: "center", padding: 30 }}>Loading emails…</p>}
      {!loading && emails.length === 0 && <p style={{ color: TEXT2, textAlign: "center", padding: 30 }}>No emails found.</p>}
      {!loading && emails.map(em => (
        <div key={em.id} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 11, padding: "12px 16px", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: TEXT1, flex: 1 }}>{em.subject || "(no subject)"}</span>
            <span style={{ fontSize: 11, color: TEXT2, flexShrink: 0 }}>{em.receivedAt ? fmtShort(em.receivedAt) : ""}</span>
          </div>
          <div style={{ fontSize: 12, color: TEAL, marginBottom: 5 }}>{em.sender}</div>
          <div style={{ fontSize: 12, color: TEXT2, lineHeight: 1.5 }}>{em.snippet}</div>
        </div>
      ))}
    </div>
  );
}

// ── Input panel ───────────────────────────────────────────────────────────────
function InputPanel({ onNewEntry }: { onNewEntry: (e: Entry) => void }) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [success, setSuccess] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setAiErr("");
    setSuccess(false);
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const res = await fetch("/api/command-log/entry", {
      method: "POST",
      headers,
      body: JSON.stringify({ raw_input: text.trim() }),
    });
    const j = await res.json() as { entry?: Entry; aiError?: string };
    if (j.entry) {
      onNewEntry(j.entry);
      setText("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    }
    if (j.aiError) setAiErr(j.aiError);
    setSubmitting(false);
    textareaRef.current?.focus();
  }

  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16, padding: "20px 20px 16px", marginBottom: 28 }}>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
        placeholder="Type or paste a note… (e.g. 'talked to Dr Bhide, he asked where I studied' or 'asked Claude to fix the collateral bug, deployed v19, still broken')"
        rows={5}
        style={{ width: "100%", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px", color: TEXT1, fontSize: 14, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box", lineHeight: 1.6 }}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        <div>
          {aiErr && <span style={{ fontSize: 12, color: AMBER }}>⚠ AI classification failed — entry saved as note. {aiErr}</span>}
          {success && !aiErr && <span style={{ fontSize: 12, color: GREEN }}>✓ Saved and classified</span>}
          {success && aiErr && <span style={{ fontSize: 12, color: AMBER }}>✓ Saved (AI failed — edit category manually)</span>}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: TEXT2 }}>⌘ + Enter to submit</span>
          <button
            onClick={submit}
            disabled={submitting || !text.trim()}
            style={{ background: TEAL, border: "none", borderRadius: 10, padding: "10px 22px", color: "#fff", fontWeight: 700, fontSize: 14, cursor: submitting || !text.trim() ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: submitting || !text.trim() ? 0.5 : 1, transition: "opacity 0.15s" }}
          >
            {submitting ? "Saving…" : "Save + Classify"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CommandLogPage() {
  const [authState, setAuthState] = useState<"loading" | "unauthorized" | "ready">("loading");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [activeTab, setActiveTab] = useState<"input" | "doctors" | "build" | "learning" | "gmail">("input");

  // ── Auth gate ────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function checkOwner() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !OWNER_ID || user.id !== OWNER_ID) {
        setAuthState("unauthorized");
      } else {
        setAuthState("ready");
      }
    }
    checkOwner();
  }, []);

  // ── Load data ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (authState !== "ready") return;
    async function load() {
      const headers = await authHeader();
      const [entriesRes, snapRes] = await Promise.all([
        fetch("/api/command-log/entries", { headers }),
        fetch("/api/command-log/snapshot", { headers }),
      ]);
      if (entriesRes.ok) {
        const j = await entriesRes.json() as { entries: Entry[] };
        setEntries(j.entries ?? []);
      } else {
        setLoadErr("Failed to load entries");
      }
      if (snapRes.ok) {
        const j = await snapRes.json() as Snapshot;
        setSnapshot(j);
      }
    }
    load();
  }, [authState]);

  function handleNewEntry(e: Entry) {
    setEntries(prev => [e, ...prev]);
  }

  function handleUpdate(updated: Entry) {
    setEntries(prev => prev.map(e => e.id === updated.id ? updated : e));
  }

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh", background: NAVY,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: TEXT1, padding: "0 16px 80px",
  };

  // ── 404 for everyone else ─────────────────────────────────────────────────────
  if (authState === "loading") {
    return (
      <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: TEXT2 }}>…</p>
      </div>
    );
  }

  if (authState === "unauthorized") {
    return (
      <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 72, fontWeight: 800, margin: "0 0 8px", color: TEXT2 }}>404</h1>
          <p style={{ fontSize: 16, color: TEXT2, margin: 0 }}>Page not found</p>
          <button onClick={() => window.location.href = "/"} style={{ marginTop: 20, background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 9, padding: "9px 20px", color: TEXT2, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            Go home
          </button>
        </div>
      </div>
    );
  }

  const tabs = [
    { key: "input",    label: "✏ New Entry" },
    { key: "doctors",  label: `👨‍⚕️ Doctors (${entries.filter(e => e.category === "doctor").length})` },
    { key: "build",    label: `🔧 Build (${entries.filter(e => e.category === "build").length})` },
    { key: "learning", label: `📚 Learning (${entries.filter(e => e.category === "learning").length})` },
    { key: "gmail",    label: "📧 Gmail" },
  ] as const;

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: 900, margin: "0 auto", paddingTop: 36 }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 4px", letterSpacing: "-0.02em" }}>Command Log</h1>
            <p style={{ color: TEXT2, fontSize: 13, margin: 0 }}>Private. Unlisted. Owner only.</p>
          </div>
          <button onClick={() => window.location.href = "/"} style={{ background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 9, padding: "9px 16px", color: TEXT2, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            ← App
          </button>
        </div>

        {/* Admin snapshot */}
        {snapshot && (
          <div style={{ display: "flex", gap: 12, marginBottom: 28, flexWrap: "wrap" }}>
            <StatCard label="Total signups" value={snapshot.totalSignups} />
            <StatCard label="Reports generated" value={snapshot.totalReportsGenerated} />
            <StatCard label="Active this week" value={snapshot.activeThisWeek} />
            <StatCard label="My entries" value={entries.length} />
          </div>
        )}

        {loadErr && <p style={{ color: RED, fontSize: 13, marginBottom: 16 }}>{loadErr}</p>}

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 24, background: CARD2, borderRadius: 13, padding: 4, border: `1px solid ${BORDER}`, overflowX: "auto", flexWrap: "wrap" }}>
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: "8px 18px", borderRadius: 9, border: "none", whiteSpace: "nowrap",
                background: activeTab === tab.key ? CARD : "transparent",
                color: activeTab === tab.key ? TEXT1 : TEXT2,
                fontSize: 13, fontWeight: activeTab === tab.key ? 600 : 400,
                cursor: "pointer", fontFamily: "inherit",
                boxShadow: activeTab === tab.key ? "0 1px 6px rgba(0,0,0,0.3)" : "none",
                transition: "all 0.15s",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "input" && <InputPanel onNewEntry={handleNewEntry} />}

        {activeTab === "input" && entries.length > 0 && (
          <>
            <p style={{ fontSize: 12, color: TEXT2, marginBottom: 12 }}>Recent entries</p>
            {entries.slice(0, 10).map(e => <EntryCard key={e.id} entry={e} onUpdate={handleUpdate} />)}
          </>
        )}

        {activeTab === "doctors" && <DoctorsTab entries={entries} />}
        {activeTab === "build" && <BuildTab entries={entries} onUpdate={handleUpdate} />}
        {activeTab === "learning" && <LearningTab entries={entries} />}
        {activeTab === "gmail" && <GmailPanel />}

      </div>
    </div>
  );
}
