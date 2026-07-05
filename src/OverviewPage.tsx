import { useState, useEffect, useRef } from "react";
import type { DoctorProfile, Patient, ReportEntry, Theme, Appointment } from "./types";
import { supabase } from "./supabase";

interface OverviewPageProps {
  doctor: DoctorProfile;
  doctorId: string;
  patients: Patient[];
  history: Record<number, ReportEntry[]>;
  appointments?: Appointment[];
  apiKeyAvailable: boolean;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
  onSelectPatient: (id: number) => void;
  onEditProfile: () => void;
  onUpgrade?: () => void;
  monthlyCount?: number;
  userPlan?: string;
  isUnlimited?: boolean;
  feedbackBonusUsed?: boolean;
  isLoading?: boolean;
}

const STATUS_COLOR: Record<"active" | "waiting" | "done", string> = {
  active: "#22c55e",
  waiting: "#f59e0b",
  done: "#6b7280",
};

const STATUS_LABEL: Record<"active" | "waiting" | "done", string> = {
  active: "In Session",
  waiting: "Waiting",
  done: "Completed",
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function formatFullDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (isToday) {
    return (
      "Today · " +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    );
  }
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  );
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function WeekCalendar({
  appointments, patients, onSelectPatient, onBack,
}: {
  appointments: Appointment[];
  patients: Patient[];
  onSelectPatient: (id: number) => void;
  onBack: () => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  const monday = new Date(today);
  const dow = today.getDay();
  monday.setDate(today.getDate() + (dow === 0 ? -6 : 1 - dow) + weekOffset * 7);
  monday.setHours(0, 0, 0, 0);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });

  const firstIso = days[0].toISOString().slice(0, 10);
  const lastIso  = days[6].toISOString().slice(0, 10);
  const weekAppts = appointments.filter(a => a.date >= firstIso && a.date <= lastIso);

  function fmtTimeStr(time: string) {
    const [hh, mm] = time.split(":");
    const h = parseInt(hh);
    return `${h > 12 ? h - 12 : h || 12}:${mm} ${h >= 12 ? "PM" : "AM"}`;
  }

  const rangeLabel =
    days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " – " +
    days[6].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="week-cal">
      <div className="week-cal-header">
        <div className="week-cal-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/>
            <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          {rangeLabel}
        </div>
        <div className="week-cal-nav">
          {weekOffset !== 0 && (
            <button className="week-cal-nav-btn week-cal-reset" onClick={() => setWeekOffset(0)}>
              This week
            </button>
          )}
          <button className="week-cal-nav-btn" onClick={() => setWeekOffset(o => o - 1)} title="Previous week">‹</button>
          <button className="week-cal-nav-btn" onClick={() => setWeekOffset(o => o + 1)} title="Next week">›</button>
        </div>
      </div>
      <div className="week-cal-grid">
        {days.map((day, i) => {
          const isoDate = day.toISOString().slice(0, 10);
          const isToday = isoDate === todayIso;
          const dayAppts = weekAppts
            .filter(a => a.date === isoDate)
            .sort((a, b) => a.time.localeCompare(b.time));
          return (
            <div key={i} className={`week-cal-day ${isToday ? "week-cal-day--today" : ""}`}>
              <div className="week-cal-day-header">
                <span className="week-cal-day-name">
                  {day.toLocaleDateString("en-US", { weekday: "short" })}
                </span>
                <span className={`week-cal-day-num ${isToday ? "wcd-today" : ""}`}>
                  {day.getDate()}
                </span>
              </div>
              <div className="week-cal-day-appts">
                {dayAppts.map(a => {
                  const patient = patients.find(p => p.id === a.patientId);
                  if (!patient) return null;
                  return (
                    <button
                      key={a.id}
                      className="week-cal-appt"
                      onClick={() => { onSelectPatient(a.patientId); onBack(); }}
                      title={`${patient.name} · ${fmtTimeStr(a.time)}${a.notes ? ` · ${a.notes}` : ""}`}
                    >
                      <span className="week-cal-appt-time">{fmtTimeStr(a.time)}</span>
                      <span className="week-cal-appt-name">{patient.name}</span>
                    </button>
                  );
                })}
                {dayAppts.length === 0 && (
                  <span className="week-cal-empty">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Waiting Room component (real-time) ────────────────────────
function WaitingRoom({ doctorId, patients, onSelectPatient, onBack }: {
  doctorId: string;
  patients: Patient[];
  onSelectPatient: (id: number) => void;
  onBack: () => void;
}) {
  const [livePatients, setLivePatients] = useState<(Patient & { checkedInAt?: string | null })[]>([]);
  const [now, setNow] = useState(Date.now());
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Tick every minute for "waiting X mins" counter
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // Load waiting patients from Supabase (with checked_in_at)
  async function loadWaiting() {
    const { data } = await supabase
      .from("patients")
      .select("id, name, age, gender, status, checked_in_at")
      .eq("doctor_id", doctorId)
      .eq("status", "waiting");
    setLivePatients((data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as number,
      name: r.name as string,
      age: (r.age as number) ?? 0,
      gender: (r.gender as string) ?? "Unknown",
      time: "",
      status: "waiting" as const,
      checkedInAt: (r.checked_in_at as string) ?? null,
    })));
  }

  useEffect(() => {
    loadWaiting();
    const ch = supabase
      .channel(`waiting-room-${doctorId}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "patients",
        filter: `doctor_id=eq.${doctorId}`,
      }, () => { loadWaiting(); })
      .subscribe();
    channelRef.current = ch;
    return () => { supabase.removeChannel(ch); };
  }, [doctorId]);

  function waitingMins(isoStr: string | null): string {
    if (!isoStr) return "";
    const mins = Math.floor((now - new Date(isoStr).getTime()) / 60000);
    if (mins < 1) return "just arrived";
    if (mins === 1) return "1 min";
    return `${mins} mins`;
  }

  return (
    <div className="ov-card" style={{ borderColor: livePatients.length > 0 ? "rgba(245,158,11,0.3)" : undefined }}>
      <div className="ov-card-header">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="8" r="4" stroke="#f59e0b" strokeWidth="2"/>
          <path d="M4 20a8 8 0 0 1 16 0" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        <span style={{ color: "#f59e0b" }}>Waiting Room</span>
        {livePatients.length > 0 && (
          <span style={{
            marginLeft: "auto", fontSize: 11, background: "#f59e0b", color: "#000",
            borderRadius: 10, padding: "1px 8px", fontWeight: 700, animation: "pulse 2s infinite",
          }}>
            {livePatients.length} waiting
          </span>
        )}
      </div>
      {livePatients.length === 0 ? (
        <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ display: "block", margin: "0 auto 8px", opacity: 0.3 }}>
            <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M4 20a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          No patients waiting right now
          <div style={{ fontSize: 11, marginTop: 4, color: "var(--text-dim)" }}>
            Updates live when receptionist checks patients in
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }}>
          {livePatients.map(p => (
            <button
              key={p.id}
              className="ov-schedule-row"
              onClick={() => { onSelectPatient(p.id); onBack(); }}
              style={{ borderLeft: "3px solid #f59e0b" }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: "50%", background: "rgba(245,158,11,0.15)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700, color: "#f59e0b", flexShrink: 0,
              }}>
                {p.name.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2)}
              </div>
              <div className="ov-sched-info" style={{ flex: 1 }}>
                <span className="ov-sched-name">{p.name}</span>
                <span className="ov-sched-meta">{p.age} y/o · {p.gender}</span>
              </div>
              {p.checkedInAt && (
                <span style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600, flexShrink: 0 }}>
                  ⏱ {waitingMins(p.checkedInAt)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OverviewPage({
  doctor,
  doctorId,
  patients,
  history,
  appointments = [],
  apiKeyAvailable,
  theme,
  onToggleTheme,
  onBack,
  onSelectPatient,
  onEditProfile,
  onUpgrade,
  monthlyCount = 0,
  userPlan = "free",
  isUnlimited = false,
  feedbackBonusUsed = false,
  isLoading = false,
}: OverviewPageProps) {
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityFilter, setActivityFilter] = useState<"all" | "active" | "waiting" | "done">("all");
  const [waitingOpen,  setWaitingOpen]  = useState(true);
  const [scheduleOpen, setScheduleOpen] = useState(true);
  const [reportsOpen,  setReportsOpen]  = useState(true);

  const totalReports = Object.values(history).reduce((sum, arr) => sum + arr.length, 0);
  const activeSessions = patients.filter((p) => p.status === "active").length;
  const patientsWithReports = Object.keys(history).filter(
    (id) => history[Number(id)]?.length > 0
  ).length;

  const recentReports: { patient: Patient; entry: ReportEntry }[] = [];
  for (const patient of patients) {
    const entries = history[patient.id] ?? [];
    for (const entry of entries) {
      recentReports.push({ patient, entry });
    }
  }
  recentReports.sort((a, b) => new Date(b.entry.date).getTime() - new Date(a.entry.date).getTime());
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const latestReports = recentReports.filter(r => new Date(r.entry.date) >= threeDaysAgo).slice(0, 12);

  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const sessionsThisMonth = recentReports.filter(r => r.entry.date.startsWith(currentMonthKey));
  const uniquePatientsThisMonth = new Set(sessionsThisMonth.map(r => r.patient.id)).size;
  const diagnosisCounts: Record<string, number> = {};
  for (const { entry } of sessionsThisMonth) {
    const diag = entry.report?.diagnosis;
    if (diag) {
      const key = diag.slice(0, 40).trim();
      diagnosisCounts[key] = (diagnosisCounts[key] ?? 0) + 1;
    }
  }
  const topDiagnoses = Object.entries(diagnosisCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayAppts = appointments
    .filter(a => a.date === todayStr)
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(a => ({ appt: a, patient: patients.find(p => p.id === a.patientId) }))
    .filter(x => x.patient);

  const tips = [
    { icon: "⌃↵", text: "Press Ctrl+Enter anywhere to generate a report instantly." },
    { icon: "🖊", text: "Click your doctor badge (top-right) to update your name, specialty, and clinic." },
    { icon: "📋", text: "Paste raw session dialogue — structure is extracted automatically." },
    { icon: "🕐", text: "Each patient keeps a full report history. Click SESSIONS chips to review past visits." },
    { icon: "💾", text: "Use the download button to export any report as a timestamped text file." },
  ];

  const steps = [
    { n: 1, title: "Select a patient", desc: "Choose from the sidebar or use the search box." },
    { n: 2, title: "Paste the transcript", desc: "Use the Session Transcript panel on the right side." },
    { n: 3, title: "Generate the report", desc: "Click the green button or press Ctrl+Enter." },
    { n: 4, title: "Review & edit", desc: "Read through the auto-generated structured note." },
    { n: 5, title: "Export or archive", desc: "Download the report or keep it in session history." },
  ];

  const statusOrder: Record<Patient["status"], number> = { active: 0, waiting: 1, done: 2 };
  const filteredActivityPatients = patients
    .filter(p => activityFilter === "all" || p.status === activityFilter)
    .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name));

  const activityTabs: { key: typeof activityFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "active", label: "In Session" },
    { key: "waiting", label: "Waiting" },
    { key: "done", label: "Done" },
  ];

  return (
    <div className="ov-shell">
      {/* ── Top bar ── */}
      <header className="topbar">
        <div className="topbar-left">
          <button className="ov-back-btn ov-back-btn--clinical" onClick={onBack}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Open Clinical Workspace
          </button>
          <span className="topbar-subtitle" style={{ borderLeft: "1px solid var(--border-mid)", paddingLeft: 12 }}>
            Dashboard
          </span>
        </div>
        <div className="topbar-right">
          <button
            className="theme-btn"
            onClick={() => setActivityOpen(true)}
            title="Clinic activity"
            style={{ minWidth: 44, minHeight: 44 }}
          >
            ⋯
          </button>
          {onUpgrade && (
            <button
              className="theme-btn boost-icon-btn"
              onClick={onUpgrade}
              title="Upgrade plan"
              style={{ minWidth: 36, minHeight: 36, color: "#f59e0b", padding: "6px" }}
            >
              <svg className="boost-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="currentColor" fillOpacity="0.15"/>
              </svg>
            </button>
          )}
          <button className="theme-btn" onClick={onToggleTheme} title="Toggle theme">
            {theme === "dark" ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="2" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <button className="doctor-badge" onClick={onEditProfile} title="Edit doctor profile">
            <span className="doctor-avatar">{getInitials(doctor.name)}</span>
            <div>
              <div className="doctor-name">{doctor.name}</div>
              <div className="doctor-specialty">
                {doctor.specialty}
                {doctor.clinic ? ` · ${doctor.clinic}` : ""}
              </div>
            </div>
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="ov-body">
        {/* Greeting */}
        <div className="ov-greeting">
          <div>
            <h1 className="ov-greeting-title">
              {greeting()}, <span>{doctor.name.replace(/^Dr\.\s*/i, "Dr. ")}</span>
            </h1>
            <p className="ov-greeting-sub">
              {formatFullDate()}
              {doctor.specialty ? ` · ${doctor.specialty}` : ""}
              {doctor.clinic ? ` — ${doctor.clinic}` : ""}
            </p>
          </div>
          <button className="ov-new-session-btn" onClick={onBack}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Start New Session
          </button>
        </div>

        {/* Stats row */}
        <div className="ov-stats-row">
          <div className="ov-stat-card">
            <div className="ov-stat-icon ov-stat-green">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <div className="ov-stat-value">
                {isLoading ? <span style={{ opacity: 0.3, fontSize: 14 }}>…</span> : patients.length}
              </div>
              <div className="ov-stat-label">Total Patients</div>
            </div>
          </div>

          <div className="ov-stat-card">
            <div className="ov-stat-icon ov-stat-amber">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <div className="ov-stat-value">
                {isLoading ? <span style={{ opacity: 0.3, fontSize: 14 }}>…</span> : activeSessions}
              </div>
              <div className="ov-stat-label">Active Sessions</div>
            </div>
          </div>

          <div className="ov-stat-card">
            <div className="ov-stat-icon ov-stat-blue">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M9 12h6M9 16h6M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
            <div>
              <div className="ov-stat-value">
                {isLoading ? <span style={{ opacity: 0.3, fontSize: 14 }}>…</span> : totalReports}
              </div>
              <div className="ov-stat-label">Reports Generated</div>
            </div>
          </div>

          <div className="ov-stat-card">
            <div className="ov-stat-icon ov-stat-purple">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M9 12h6M9 16h6M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
            <div>
              <div className="ov-stat-value">
                {isLoading ? <span style={{ opacity: 0.3, fontSize: 14 }}>…</span> : patientsWithReports}
              </div>
              <div className="ov-stat-label">Patients Documented</div>
            </div>
          </div>

          <div className={`ov-stat-card ov-stat-api ${apiKeyAvailable ? "api-ok" : "api-err"}`}>
            <div className={`ov-stat-icon ${apiKeyAvailable ? "ov-stat-green" : "ov-stat-red"}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <div className="ov-stat-value ov-api-status">
                <span className={`ov-api-dot ${apiKeyAvailable ? "green" : "red"}`} />
                {apiKeyAvailable ? "Connected" : "No API Key"}
              </div>
              <div className="ov-stat-label">Smart Service</div>
            </div>
          </div>
        </div>

        {/* ── Monthly Analytics ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12, marginBottom: 20 }}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
              Sessions This Month
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "var(--text)" }}>{sessionsThisMonth.length}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {uniquePatientsThisMonth} unique patient{uniquePatientsThisMonth !== 1 ? "s" : ""}
            </div>
          </div>
          {topDiagnoses.length > 0 && (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                Top Diagnoses This Month
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {topDiagnoses.map(([diag, count]) => (
                  <div key={diag} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{diag}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", flexShrink: 0 }}>{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
              Total Reports
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "var(--text)" }}>{totalReports}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>across {patientsWithReports} patient{patientsWithReports !== 1 ? "s" : ""}</div>
          </div>

          {/* ── Usage this month ── */}
          {(() => {
            const resetDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
              .toLocaleDateString("en-IN", { day: "numeric", month: "short" });

            if (isUnlimited) {
              const planLabel = userPlan.charAt(0).toUpperCase() + userPlan.slice(1);
              return (
                <div style={{ background: "var(--surface)", border: "1px solid rgba(34,197,94,0.18)", borderRadius: 12, padding: "16px 18px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                    Sessions Used · {planLabel}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontSize: 28, fontWeight: 800, color: "#22c55e" }}>{monthlyCount}</span>
                    <span style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 500 }}>/ ∞</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#22c55e", marginTop: 4, fontWeight: 600 }}>
                    Unlimited · resets {resetDate}
                  </div>
                </div>
              );
            }

            const limit    = feedbackBonusUsed ? 40 : userPlan === "starter" ? 75 : 30;
            const pct      = Math.min(monthlyCount / limit, 1);
            const barColor = pct >= 0.9 ? "#ef4444" : pct >= 0.65 ? "#f59e0b" : "#22c55e";
            const remaining = Math.max(0, limit - monthlyCount);
            const planLabel = userPlan === "starter" ? "Starter" : userPlan === "free" ? "Free" : userPlan.charAt(0).toUpperCase() + userPlan.slice(1);

            return (
              <div
                style={{ background: "var(--surface)", border: `1px solid ${pct >= 0.9 ? "rgba(239,68,68,0.25)" : "var(--border)"}`, borderRadius: 12, padding: "16px 18px", cursor: onUpgrade && userPlan !== "starter" ? "default" : "default" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Sessions · {planLabel}
                  </div>
                  {onUpgrade && userPlan !== "clinical" && userPlan !== "premium" && (
                    <button
                      onClick={onUpgrade}
                      className="boost-icon-btn"
                      title="Upgrade plan"
                      style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 6, padding: "4px 6px", cursor: "pointer", color: "#f59e0b", display: "flex", alignItems: "center" }}
                    >
                      <svg className="boost-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="currentColor" fillOpacity="0.2"/>
                      </svg>
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 28, fontWeight: 800, color: barColor }}>{monthlyCount}</span>
                  <span style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 500 }}>/ {limit}</span>
                </div>
                <div style={{ height: 4, background: "var(--border)", borderRadius: 4, margin: "8px 0 6px", overflow: "hidden" }}>
                  <div style={{ width: `${pct * 100}%`, height: "100%", background: barColor, borderRadius: 4, transition: "width 0.4s" }} />
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {remaining} left · resets {resetDate}
                </div>
              </div>
            );
          })()}
        </div>

        {/* ── Week Calendar ── */}
        <WeekCalendar
          appointments={appointments}
          patients={patients}
          onSelectPatient={onSelectPatient}
          onBack={onBack}
        />

        {/* Main grid */}
        <div className="ov-grid">
          {/* Left col */}
          <div className="ov-col-left">
            {/* Waiting room — live (collapsible) */}
            <div className="ov-card" style={{ padding: 0 }}>
              <div className="ov-card-header" style={{ padding: "12px 16px", cursor: "pointer" }} onClick={() => setWaitingOpen(o => !o)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                Waiting Room
                <button
                  onClick={e => { e.stopPropagation(); setWaitingOpen(o => !o); }}
                  style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 4px" }}
                  aria-label={waitingOpen ? "Collapse" : "Expand"}
                >{waitingOpen ? "▲" : "▼"}</button>
              </div>
              {waitingOpen && (
                <WaitingRoom
                  doctorId={doctorId}
                  patients={patients}
                  onSelectPatient={onSelectPatient}
                  onBack={onBack}
                />
              )}
            </div>

            {/* Today's schedule */}
            <div className="ov-card">
              <div className="ov-card-header" style={{ cursor: "pointer" }} onClick={() => setScheduleOpen(o => !o)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Today's Schedule
                {todayAppts.length > 0 && (
                  <span style={{ fontSize: 11, background: "var(--accent)", color: "#fff", borderRadius: 10, padding: "1px 8px", fontWeight: 600 }}>
                    {todayAppts.length}
                  </span>
                )}
                <button
                  onClick={e => { e.stopPropagation(); setScheduleOpen(o => !o); }}
                  style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 4px" }}
                  aria-label={scheduleOpen ? "Collapse" : "Expand"}
                >{scheduleOpen ? "▲" : "▼"}</button>
              </div>
              {scheduleOpen && <div className="ov-schedule-list">
                {todayAppts.length === 0 ? (
                  <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ display: "block", margin: "0 auto 8px", opacity: 0.3 }}>
                      <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    No appointments scheduled for today.
                    <div style={{ fontSize: 11, marginTop: 4, color: "var(--text-dim)" }}>Use "Add Appt" on a patient to schedule one.</div>
                  </div>
                ) : (
                  todayAppts.map(({ appt, patient }) => {
                    const p = patient!;
                    const reportCount = history[p.id]?.length ?? 0;
                    const [hh, mm] = appt.time.split(":");
                    const h = parseInt(hh);
                    const timeLabel = `${h > 12 ? h - 12 : h || 12}:${mm} ${h >= 12 ? "PM" : "AM"}`;
                    return (
                      <button
                        key={appt.id}
                        className="ov-schedule-row"
                        onClick={() => { onSelectPatient(p.id); onBack(); }}
                      >
                        <span className="ov-sched-time">{timeLabel}</span>
                        <div className="ov-sched-info">
                          <span className="ov-sched-name">{p.name}</span>
                          <span className="ov-sched-meta">
                            {p.age} y/o · {p.gender}{appt.notes ? ` · ${appt.notes}` : ""}
                          </span>
                        </div>
                        <div className="ov-sched-right">
                          <span className="ov-sched-status-badge" style={{ color: STATUS_COLOR[p.status] }}>
                            {STATUS_LABEL[p.status]}
                          </span>
                          {reportCount > 0 ? (
                            <span className="ov-report-pill">{reportCount} report{reportCount > 1 ? "s" : ""}</span>
                          ) : (
                            <span className="ov-no-report-pill">No report</span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>}
            </div>

            {/* Recent reports */}
            <div className="ov-card">
              <div className="ov-card-header" style={{ cursor: "pointer" }} onClick={() => setReportsOpen(o => !o)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M12 8v4l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                </svg>
                Recent Reports
                <span style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
                  (last 3 days)
                </span>
                <button
                  onClick={e => { e.stopPropagation(); setReportsOpen(o => !o); }}
                  style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 4px" }}
                  aria-label={reportsOpen ? "Collapse" : "Expand"}
                >{reportsOpen ? "▲" : "▼"}</button>
              </div>
              {reportsOpen && (latestReports.length === 0 ? (
                <div className="ov-empty-reports">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" opacity=".3">
                    <path d="M9 12h6M9 16h6M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  <p>No reports in the last 3 days</p>
                </div>
              ) : (
                <div className="ov-report-list">
                  {latestReports.map(({ patient, entry }) => (
                    <button
                      key={entry.id}
                      className="ov-report-row"
                      onClick={() => { onSelectPatient(patient.id); onBack(); }}
                    >
                      <div className="ov-report-avatar">{getInitials(patient.name)}</div>
                      <div className="ov-report-info">
                        <span className="ov-report-patient">{patient.name}</span>
                        <span className="ov-report-date">{formatShortDate(entry.date)}</span>
                      </div>
                      <div className="ov-report-snippet">
                        {(() => {
                          const diag = entry.report.diagnosis;
                          if (diag) return diag.slice(0, 60) + (diag.length > 60 ? "…" : "");
                          const secVal = entry.report.sections[0]?.value;
                          if (secVal) return secVal.slice(0, 60) + (secVal.length > 60 ? "…" : "");
                          const raw = entry.rawText ?? "";
                          if (raw) return raw.replace(/#+\s*/g, "").replace(/\*+/g, "").trim().slice(0, 60) + (raw.length > 60 ? "…" : "");
                          return "No report content";
                        })()}
                      </div>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="ov-report-arrow">
                        <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Right col */}
          <div className="ov-col-right">
            {/* Quick start */}
            <div className="ov-card">
              <div className="ov-card-header">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Quick Start
              </div>
              <div className="ov-steps">
                {steps.map((s) => (
                  <div key={s.n} className="ov-step">
                    <span className="ov-step-num">{s.n}</span>
                    <div>
                      <div className="ov-step-title">{s.title}</div>
                      <div className="ov-step-desc">{s.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tips */}
            <div className="ov-card">
              <div className="ov-card-header">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Tips & Shortcuts
              </div>
              <div className="ov-tips">
                {tips.map((t, i) => (
                  <div key={i} className="ov-tip-row">
                    <span className="ov-tip-icon">{t.icon}</span>
                    <span className="ov-tip-text">{t.text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Keyboard shortcuts card */}
            <div className="ov-card">
              <div className="ov-card-header">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <rect x="2" y="6" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
                  <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Keyboard Shortcuts
              </div>
              <div className="ov-shortcuts">
                {[
                  ["Ctrl + Enter", "Generate report"],
                  ["Click logo", "Open this dashboard"],
                  ["Click badge", "Edit doctor profile"],
                  ["Chevron ›", "Collapse transcript panel"],
                ].map(([key, desc]) => (
                  <div key={key} className="ov-shortcut-row">
                    <kbd className="ov-kbd">{key}</kbd>
                    <span className="ov-shortcut-desc">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {activityOpen && (
        <>
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 999 }}
            onClick={() => setActivityOpen(false)}
          />
          <div
            style={{
              position: "fixed", top: 0, right: 0, height: "100%",
              width: "min(320px, 100vw)", background: "#111827",
              borderLeft: "1px solid rgba(255,255,255,0.1)",
              zIndex: 1000, display: "flex", flexDirection: "column",
              overflowY: "auto",
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: 16, borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0,
            }}>
              <span style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>Clinic Activity</span>
              <button
                onClick={() => setActivityOpen(false)}
                style={{
                  background: "none", border: "none", color: "#8898aa",
                  cursor: "pointer", fontSize: 20, minWidth: 44, minHeight: 44,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >×</button>
            </div>
            <div style={{
              display: "flex", overflowX: "auto", gap: 6,
              padding: "12px 16px", flexShrink: 0,
            }}>
              {activityTabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActivityFilter(tab.key)}
                  style={{
                    flexShrink: 0, padding: "8px 14px", borderRadius: 999, border: "none",
                    fontSize: 12, fontWeight: 600, cursor: "pointer", minHeight: 44,
                    background: activityFilter === tab.key ? "#14b8a6" : "transparent",
                    color: activityFilter === tab.key ? "#fff" : "#8898aa",
                  }}
                >{tab.label}</button>
              ))}
            </div>
            <div style={{ flex: 1 }}>
              {filteredActivityPatients.length === 0 ? (
                <p style={{ textAlign: "center", color: "#8898aa", fontSize: 13, padding: "32px 16px" }}>
                  No patients in this category
                </p>
              ) : (
                filteredActivityPatients.map(p => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: "50%",
                      background: "rgba(20,184,166,0.15)", color: "#14b8a6",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: 700, flexShrink: 0,
                    }}>{getInitials(p.name)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 14, color: "#f0f4f8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[p.status], flexShrink: 0 }} />
                        <span style={{ fontSize: 12, color: "#8898aa" }}>{STATUS_LABEL[p.status]}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => { onSelectPatient(p.id); onBack(); setActivityOpen(false); }}
                      style={{
                        background: "none", border: "none", color: "#14b8a6",
                        cursor: "pointer", fontSize: 12, fontWeight: 600,
                        minWidth: 44, minHeight: 44, flexShrink: 0,
                      }}
                    >View →</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
