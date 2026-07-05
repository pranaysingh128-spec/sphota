import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabase";

// Access: /admin/feedback
// Auth: requires a logged-in Supabase session with role = 'admin' in the doctors table

const TEAL   = "#14b8a6";
const NAVY   = "#080c18";
const CARD   = "#0f1624";
const CARD2  = "#121926";
const BORDER = "rgba(255,255,255,0.07)";
const TEXT1  = "#f0f4f8";
const TEXT2  = "#8898aa";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FeedbackRow {
  id: string;
  role: string;
  ratings: Record<string, number>;
  choices: Record<string, string>;
  pricing_preference: string;
  open_answers: Record<string, string>;
  contact: { name: string; whatsapp: string; email: string; canContact: string };
  submitted_at: string;
}

interface DoctorRow {
  id: string;
  email: string;
  name: string;
  plan: string;
  plan_expires_at: string | null;
  created_at: string;
  unlimited?: boolean; // joined from report_usage
  total_reports?: number;
  monthly_reports?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function avg(ratings: Record<string, number>): string {
  const vals = Object.values(ratings).filter(v => v > 0);
  if (!vals.length) return "—";
  return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
}

function fmt(dt: string) {
  try {
    return new Date(dt).toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return dt; }
}

function fmtDate(dt: string | null) {
  if (!dt) return "—";
  try { return new Date(dt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return dt; }
}

// ─── Plan badge ──────────────────────────────────────────────────────────────

function PlanBadge({ plan, unlimited }: { plan: string; unlimited?: boolean }) {
  const isUnlim = unlimited || plan === "unlimited" || plan === "clinical" || plan === "premium";
  const color = isUnlim ? "#4ade80"
    : plan === "starter"  ? TEAL
    : TEXT2;
  const bg = isUnlim ? "rgba(74,222,128,0.10)"
    : plan === "starter"  ? "rgba(20,184,166,0.10)"
    : "rgba(255,255,255,0.05)";
  const label = isUnlim ? "Unlimited" : plan.charAt(0).toUpperCase() + plan.slice(1);
  return (
    <span style={{ background: bg, color, fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, textTransform: "uppercase", letterSpacing: "0.04em" }}>
      {label}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AdminFeedbackPage() {
  const [authState, setAuthState] = useState<"loading" | "unauthenticated" | "forbidden" | "admin">("loading");
  const [activeTab, setActiveTab] = useState<"feedback" | "users">("users");

  // Feedback state
  const [rows, setRows]       = useState<FeedbackRow[]>([]);
  const [fbLoading, setFbLoading] = useState(false);
  const [filter, setFilter]   = useState<"all" | "doctor" | "receptionist">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loadErr, setLoadErr]  = useState("");

  // Users state
  const [doctors, setDoctors]       = useState<DoctorRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersErr, setUsersErr]     = useState("");
  const [search, setSearch]         = useState("");
  const [updating, setUpdating]     = useState<string | null>(null); // doctor id being updated
  const [toast, setToast]           = useState<{ msg: string; ok: boolean } | null>(null);

  // ── Auth ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function checkAuth() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setAuthState("unauthenticated"); return; }

      const { data, error } = await supabase
        .from("doctors")
        .select("role")
        .eq("id", user.id)
        .single();

      if (error || !data || data.role !== "admin") {
        setAuthState("forbidden");
        return;
      }
      setAuthState("admin");
    }
    checkAuth();
  }, []);

  // ── Load feedback ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (authState !== "admin" || activeTab !== "feedback") return;
    if (rows.length > 0) return; // already loaded
    setFbLoading(true);
    setLoadErr("");
    supabase
      .from("beta_feedback")
      .select("*")
      .order("submitted_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) setLoadErr(error.message);
        else setRows((data ?? []) as FeedbackRow[]);
        setFbLoading(false);
      });
  }, [authState, activeTab]);

  // ── Load users ──────────────────────────────────────────────────────────────
  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersErr("");
    try {
      const [{ data: docData, error: docErr }, { data: usageData }] = await Promise.all([
        supabase.from("doctors").select("id, email, name, plan, plan_expires_at, created_at").order("created_at", { ascending: false }),
        supabase.from("report_usage").select("user_id, unlimited, count, monthly_count"),
      ]);
      if (docErr) { setUsersErr(docErr.message); setUsersLoading(false); return; }
      const usageMap = new Map((usageData ?? []).map((u: any) => [u.user_id, u]));
      const merged: DoctorRow[] = (docData ?? []).map((d: any) => {
        const u = usageMap.get(d.id) as any;
        return {
          ...d,
          unlimited:      u?.unlimited ?? false,
          total_reports:  u?.count ?? 0,
          monthly_reports: u?.monthly_count ?? 0,
        };
      });
      setDoctors(merged);
    } catch (e: any) {
      setUsersErr(e?.message ?? "Failed to load users");
    }
    setUsersLoading(false);
  }, []);

  useEffect(() => {
    if (authState === "admin" && activeTab === "users") loadUsers();
  }, [authState, activeTab, loadUsers]);

  // ── Toast helper ────────────────────────────────────────────────────────────
  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Grant / Revoke unlimited ─────────────────────────────────────────────────
  async function setUnlimited(doctor: DoctorRow, grant: boolean) {
    setUpdating(doctor.id);
    try {
      const [r1, r2] = await Promise.all([
        supabase.from("doctors").update({
          plan: grant ? "unlimited" : "free",
          plan_expires_at: null,
        }).eq("id", doctor.id),

        supabase.from("report_usage").upsert({
          user_id: doctor.id,
          unlimited: grant,
        }, { onConflict: "user_id" }),
      ]);

      if (r1.error || r2.error) throw new Error(r1.error?.message ?? r2.error?.message);

      setDoctors(prev => prev.map(d =>
        d.id === doctor.id
          ? { ...d, plan: grant ? "unlimited" : "free", unlimited: grant, plan_expires_at: null }
          : d
      ));
      showToast(
        grant
          ? `✓ ${doctor.email} — unlimited access granted`
          : `✓ ${doctor.email} — reverted to free`,
        true
      );
    } catch (e: any) {
      showToast("Failed: " + (e?.message ?? "unknown error"), false);
    }
    setUpdating(null);
  }

  // ── Export feedback CSV ──────────────────────────────────────────────────────
  function exportCsv() {
    const visible = rows.filter(r => filter === "all" || r.role === filter);
    const headers = ["id","role","submitted_at","avg_rating","pricing","frequency","recommend","pay","name","whatsapp","email","canContact","likes","improve","feature","other"];
    const csvRows = visible.map(r => [
      r.id, r.role, r.submitted_at, avg(r.ratings ?? {}),
      r.pricing_preference ?? "",
      r.choices?.frequency ?? "", r.choices?.recommend ?? "", r.choices?.pay ?? "",
      r.contact?.name ?? "", r.contact?.whatsapp ?? "", r.contact?.email ?? "", r.contact?.canContact ?? "",
      (r.open_answers?.likes ?? "").replace(/\n/g, " "),
      (r.open_answers?.improve ?? "").replace(/\n/g, " "),
      (r.open_answers?.feature ?? "").replace(/\n/g, " "),
      (r.open_answers?.other ?? "").replace(/\n/g, " "),
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const csv = [headers.join(","), ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "beta_feedback.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  // ─────────────────────────────────────────────────────────────────────────────

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh", background: NAVY,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: TEXT1, padding: "0 16px 60px",
  };

  if (authState === "loading") {
    return (
      <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: TEXT2 }}>Verifying access…</p>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return (
      <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 360, background: CARD, borderRadius: 18, border: `1px solid ${BORDER}`, padding: "36px 32px", boxShadow: "0 24px 80px rgba(0,0,0,0.4)", textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 12px" }}>Admin Access Required</h1>
          <p style={{ fontSize: 14, color: TEXT2, margin: "0 0 24px", lineHeight: 1.6 }}>Please sign in at the main app first.</p>
          <button onClick={() => window.location.href = "/"} style={{ width: "100%", background: TEAL, border: "none", borderRadius: 10, padding: "12px", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
            Go to Sign In →
          </button>
        </div>
      </div>
    );
  }

  if (authState === "forbidden") {
    return (
      <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 360, background: CARD, borderRadius: 18, border: `1px solid ${BORDER}`, padding: "36px 32px", textAlign: "center" }}>
          <p style={{ fontSize: 16, color: "#f87171", margin: 0 }}>You do not have admin access.</p>
        </div>
      </div>
    );
  }

  // ── Filtered users ────────────────────────────────────────────────────────
  const filteredDoctors = doctors.filter(d =>
    !search.trim() ||
    d.email.toLowerCase().includes(search.toLowerCase()) ||
    (d.name ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const unlimitedCount = doctors.filter(d => d.unlimited || d.plan === "unlimited").length;

  // ── Feedback tab vars ─────────────────────────────────────────────────────
  const visible    = rows.filter(r => filter === "all" || r.role === filter);
  const docCount   = rows.filter(r => r.role === "doctor").length;
  const recepCount = rows.filter(r => r.role === "receptionist").length;
  const allAvg     = rows.length
    ? (rows.map(r => parseFloat(avg(r.ratings ?? {}))).filter(v => !isNaN(v)).reduce((a,b)=>a+b,0) / rows.length).toFixed(1)
    : "—";

  return (
    <div style={pageStyle}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          background: toast.ok ? "rgba(74,222,128,0.15)" : "rgba(248,113,113,0.15)",
          border: `1px solid ${toast.ok ? "rgba(74,222,128,0.35)" : "rgba(248,113,113,0.35)"}`,
          color: toast.ok ? "#4ade80" : "#f87171",
          borderRadius: 10, padding: "10px 20px", fontSize: 13, fontWeight: 600,
          zIndex: 9999, backdropFilter: "blur(8px)", whiteSpace: "nowrap",
          boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        }}>
          {toast.msg}
        </div>
      )}

      <div style={{ maxWidth: 960, margin: "0 auto", paddingTop: 36 }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Sphota Admin</h1>
            <p style={{ color: TEXT2, fontSize: 13, margin: 0 }}>Manage users &amp; view feedback</p>
          </div>
          <button onClick={() => window.location.href = "/"} style={{ background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 9, padding: "9px 16px", color: TEXT2, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            ← Back to App
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 28, background: CARD2, borderRadius: 12, padding: 4, width: "fit-content", border: `1px solid ${BORDER}` }}>
          {(["users", "feedback"] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: "8px 22px", borderRadius: 9, border: "none",
                background: activeTab === tab ? CARD : "transparent",
                color: activeTab === tab ? TEXT1 : TEXT2,
                fontSize: 13, fontWeight: activeTab === tab ? 600 : 400,
                cursor: "pointer", fontFamily: "inherit",
                boxShadow: activeTab === tab ? "0 1px 6px rgba(0,0,0,0.3)" : "none",
                transition: "all 0.15s",
              }}
            >
              {tab === "users" ? "👥 Users" : "📋 Feedback"}
            </button>
          ))}
        </div>

        {/* ══════════════════ USERS TAB ══════════════════ */}
        {activeTab === "users" && (
          <>
            {/* Stats */}
            <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
              {[
                { label: "Total users",  value: doctors.length },
                { label: "Unlimited",    value: unlimitedCount },
                { label: "Free plan",    value: doctors.filter(d => d.plan === "free" && !d.unlimited).length },
                { label: "Reports today (approx)", value: doctors.reduce((s,d) => s + (d.monthly_reports ?? 0), 0) },
              ].map(s => (
                <div key={s.label} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: "16px 20px", flex: "1 1 130px", minWidth: 120 }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: TEAL, marginBottom: 4 }}>{s.value}</div>
                  <div style={{ fontSize: 12, color: TEXT2 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Search + refresh */}
            <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
              <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: TEXT2, pointerEvents: "none" }}>
                  <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by email or name…"
                  style={{ width: "100%", background: CARD, border: `1px solid ${BORDER}`, borderRadius: 9, padding: "9px 12px 9px 34px", color: TEXT1, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                />
              </div>
              <button
                onClick={loadUsers}
                disabled={usersLoading}
                style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 9, padding: "9px 14px", color: TEXT2, fontSize: 13, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ animation: usersLoading ? "spin 1s linear infinite" : "none" }}>
                  <path d="M23 4v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M1 20v-6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Refresh
              </button>
            </div>

            {usersErr && <p style={{ color: "#f87171", fontSize: 13, marginBottom: 12 }}>Error: {usersErr}</p>}
            {usersLoading && <p style={{ color: TEXT2, textAlign: "center", padding: 40 }}>Loading users…</p>}

            {!usersLoading && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {filteredDoctors.length === 0 && (
                  <div style={{ textAlign: "center", padding: 50, color: TEXT2 }}>No users found.</div>
                )}
                {filteredDoctors.map(doc => {
                  const isUnlim = doc.unlimited || doc.plan === "unlimited" || doc.plan === "clinical" || doc.plan === "premium";
                  const isBusy  = updating === doc.id;
                  return (
                    <div key={doc.id} style={{ background: CARD, border: `1px solid ${isUnlim ? "rgba(74,222,128,0.2)" : BORDER}`, borderRadius: 13, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>

                      {/* Avatar */}
                      <div style={{ width: 38, height: 38, borderRadius: 10, background: `rgba(20,184,166,0.12)`, border: `1px solid rgba(20,184,166,0.15)`, display: "flex", alignItems: "center", justifyContent: "center", color: TEAL, fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
                        {(doc.name || doc.email || "?").charAt(0).toUpperCase()}
                      </div>

                      {/* Name + email */}
                      <div style={{ flex: 1, minWidth: 160 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: TEXT1, marginBottom: 2 }}>
                          {doc.name || <span style={{ color: TEXT2, fontStyle: "italic" }}>No name</span>}
                        </div>
                        <div style={{ fontSize: 12, color: TEXT2 }}>{doc.email}</div>
                      </div>

                      {/* Stats */}
                      <div style={{ display: "flex", gap: 16, flexShrink: 0 }}>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: TEXT1 }}>{doc.total_reports ?? 0}</div>
                          <div style={{ fontSize: 10, color: TEXT2 }}>total</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: TEXT1 }}>{doc.monthly_reports ?? 0}</div>
                          <div style={{ fontSize: 10, color: TEXT2 }}>this month</div>
                        </div>
                      </div>

                      {/* Plan badge */}
                      <div style={{ flexShrink: 0 }}>
                        <PlanBadge plan={doc.plan} unlimited={doc.unlimited} />
                        {doc.plan_expires_at && (
                          <div style={{ fontSize: 10, color: TEXT2, marginTop: 3, textAlign: "center" }}>
                            exp {fmtDate(doc.plan_expires_at)}
                          </div>
                        )}
                      </div>

                      {/* Action button */}
                      <button
                        onClick={() => setUnlimited(doc, !isUnlim)}
                        disabled={isBusy}
                        style={{
                          flexShrink: 0,
                          padding: "8px 16px",
                          borderRadius: 9,
                          border: `1.5px solid ${isUnlim ? "rgba(248,113,113,0.4)" : "rgba(74,222,128,0.4)"}`,
                          background: isUnlim ? "rgba(248,113,113,0.08)" : "rgba(74,222,128,0.08)",
                          color: isUnlim ? "#f87171" : "#4ade80",
                          fontSize: 12, fontWeight: 700, cursor: isBusy ? "not-allowed" : "pointer",
                          fontFamily: "inherit", opacity: isBusy ? 0.5 : 1,
                          transition: "all 0.15s", whiteSpace: "nowrap",
                        }}
                      >
                        {isBusy ? "Saving…" : isUnlim ? "✕ Revoke Unlimited" : "⚡ Grant Unlimited"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ══════════════════ FEEDBACK TAB ══════════════════ */}
        {activeTab === "feedback" && (
          <>
            {/* Header row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
              <p style={{ color: TEXT2, fontSize: 14, margin: 0 }}>{rows.length} total responses</p>
              <button onClick={exportCsv} style={{ background: CARD2, border: `1px solid ${BORDER}`, borderRadius: 9, padding: "9px 16px", color: TEXT2, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                ↓ Export CSV
              </button>
            </div>

            {/* Stats */}
            <div style={{ display: "flex", gap: 14, marginBottom: 28, flexWrap: "wrap" }}>
              {[
                { label: "Total responses", value: rows.length },
                { label: "Doctors",         value: docCount },
                { label: "Receptionists",   value: recepCount },
                { label: "Avg rating",      value: allAvg + " / 5" },
              ].map(s => (
                <div key={s.label} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: "16px 20px", flex: "1 1 140px", minWidth: 130 }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: TEAL, marginBottom: 4 }}>{s.value}</div>
                  <div style={{ fontSize: 13, color: TEXT2 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Filter */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              {(["all","doctor","receptionist"] as const).map(f => (
                <button key={f} onClick={() => setFilter(f)} style={{
                  padding: "8px 16px", borderRadius: 999, border: `1.5px solid ${filter===f ? TEAL : BORDER}`,
                  background: filter===f ? `rgba(20,184,166,0.12)` : CARD2,
                  color: filter===f ? TEAL : TEXT2, fontSize: 13, fontWeight: filter===f ? 600 : 400,
                  cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize",
                }}>
                  {f === "all" ? `All (${rows.length})` : f === "doctor" ? `Doctors (${docCount})` : `Receptionists (${recepCount})`}
                </button>
              ))}
            </div>

            {fbLoading && <p style={{ color: TEXT2, textAlign: "center", padding: 40 }}>Loading responses…</p>}
            {loadErr && <p style={{ color: "#f87171", textAlign: "center" }}>Error: {loadErr}</p>}
            {!fbLoading && visible.length === 0 && <div style={{ textAlign: "center", padding: 60, color: TEXT2 }}>No responses yet.</div>}

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {visible.map(row => {
                const open = expanded === row.id;
                return (
                  <div key={row.id} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, overflow: "hidden" }}>
                    <button
                      onClick={() => setExpanded(open ? null : row.id)}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px 20px", background: "none", border: "none", cursor: "pointer", textAlign: "left", flexWrap: "wrap" }}
                    >
                      <span style={{ background: row.role==="doctor" ? "rgba(59,130,246,0.15)" : "rgba(20,184,166,0.12)", color: row.role==="doctor" ? "#60a5fa" : TEAL, fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, textTransform: "uppercase", letterSpacing: "0.04em", flexShrink: 0 }}>
                        {row.role}
                      </span>
                      <span style={{ color: TEXT1, fontSize: 14, fontWeight: 600, flex: 1, minWidth: 100 }}>
                        {row.contact?.name || "Anonymous"}
                        {row.contact?.email && <span style={{ color: TEXT2, fontWeight: 400, marginLeft: 8 }}>{row.contact.email}</span>}
                      </span>
                      <span style={{ color: TEXT2, fontSize: 13, flexShrink: 0 }}>{fmt(row.submitted_at)}</span>
                      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                        <span style={{ background: "rgba(245,158,11,0.12)", color: "#fbbf24", fontSize: 13, fontWeight: 700, padding: "3px 10px", borderRadius: 6 }}>★ {avg(row.ratings ?? {})}</span>
                        {row.pricing_preference && <span style={{ background: "rgba(20,184,166,0.08)", color: TEAL, fontSize: 12, padding: "3px 10px", borderRadius: 6 }}>{row.pricing_preference}</span>}
                      </div>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ color: TEXT2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }}>
                        <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>

                    {open && (
                      <div style={{ borderTop: `1px solid ${BORDER}`, padding: "20px 20px 24px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px 28px" }}>
                        <div>
                          <p style={{ color: TEAL, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Ratings</p>
                          {Object.entries(row.ratings ?? {}).map(([k,v]) => (
                            <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                              <span style={{ color: TEXT2, fontSize: 13, textTransform: "capitalize" }}>{k.replace(/_/g," ")}</span>
                              <span style={{ color: v>=4?"#4ade80":v>=3?"#fbbf24":"#f87171", fontWeight: 700, fontSize: 13 }}>{"★".repeat(v)}{"☆".repeat(5-v)}</span>
                            </div>
                          ))}
                        </div>
                        <div>
                          <p style={{ color: TEAL, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Choices</p>
                          {Object.entries(row.choices ?? {}).map(([k,v]) => (
                            <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                              <span style={{ color: TEXT2, fontSize: 12, textTransform: "capitalize" }}>{k.replace(/_/g," ")}</span>
                              <span style={{ color: TEXT1, fontSize: 12, fontWeight: 600 }}>{v}</span>
                            </div>
                          ))}
                        </div>
                        {row.open_answers && Object.values(row.open_answers).some(v=>v) && (
                          <div style={{ gridColumn: "1 / -1" }}>
                            <p style={{ color: TEAL, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Open Feedback</p>
                            {Object.entries(row.open_answers).filter(([,v])=>v).map(([k,v]) => (
                              <div key={k} style={{ marginBottom: 12 }}>
                                <p style={{ color: TEXT2, fontSize: 12, textTransform: "capitalize", marginBottom: 3 }}>{k.replace(/_/g," ")}</p>
                                <p style={{ color: TEXT1, fontSize: 13, lineHeight: 1.55, background: CARD2, borderRadius: 8, padding: "10px 12px", margin: 0 }}>{v}</p>
                              </div>
                            ))}
                          </div>
                        )}
                        <div>
                          <p style={{ color: TEAL, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Contact</p>
                          {row.contact?.name && <p style={{ color: TEXT1, fontSize: 13, marginBottom: 4 }}><span style={{color:TEXT2}}>Name: </span>{row.contact.name}</p>}
                          {row.contact?.whatsapp && <p style={{ color: TEXT1, fontSize: 13, marginBottom: 4 }}><span style={{color:TEXT2}}>WhatsApp: </span>{row.contact.whatsapp}</p>}
                          {row.contact?.email && <p style={{ color: TEXT1, fontSize: 13, marginBottom: 4 }}><span style={{color:TEXT2}}>Email: </span>{row.contact.email}</p>}
                          {row.contact?.canContact && <p style={{ color: TEXT1, fontSize: 13, marginBottom: 4 }}><span style={{color:TEXT2}}>Can call: </span><span style={{ color: row.contact.canContact==="Yes" ? "#4ade80" : "#f87171" }}>{row.contact.canContact}</span></p>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
