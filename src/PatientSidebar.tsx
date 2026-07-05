import type { Patient, ReportEntry, PatientMedRecord, Appointment } from "./types";

const STATUS_COLOR: Record<Patient["status"], string> = {
  active: "#22c55e", waiting: "#f59e0b", done: "#6b7280",
};

interface PatientSidebarProps {
  filtered: Patient[];
  patients: Patient[];
  history: Record<number, ReportEntry[]>;
  flagged: Set<string>;
  appointments: Appointment[];
  presenceMap: Record<number, number>;
  selectedId: number | null;
  meds: Record<number, PatientMedRecord>;
  selectedPatient: Patient | null;
  search: string;
  mobileTab: string;
  recording: boolean;
  transcribing: boolean;
  openAddPatient: () => void;
  setSearch: (v: string) => void;
  setSelectedId: (id: number) => void;
  setActiveEntryId: (id: string | null) => void;
  setError: (e: string) => void;
  setTranscript: (t: string) => void;
  setDeleteStep: (n: number) => void;
  setMobileTab: (tab: "patients" | "report" | "record") => void;
  showToast: (msg: string, type?: "success" | "error") => void;
}

export default function PatientSidebar({
  filtered, patients, history, flagged, appointments, presenceMap,
  selectedId, meds, selectedPatient, search, recording, transcribing,
  openAddPatient, setSearch, setSelectedId, setActiveEntryId,
  setError, setTranscript, setDeleteStep, setMobileTab, showToast,
}: PatientSidebarProps) {
  return (
    <aside id="tour-sidebar" className="sidebar">
      <div id="tour-patients" className="sidebar-header">
        <span className="sidebar-title">PATIENTS</span>
        <button className="add-btn" onClick={openAddPatient} title="Add patient">+</button>
      </div>
      <div className="search-wrap">
        <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        <input className="search-input" placeholder="Search patients..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      {patients.length > 0 && (
        <div style={{ display:"flex", flexDirection:"row", gap:12, padding:"4px 8px", alignItems:"center" }}>
          <span style={{ display:"flex", alignItems:"center", gap:4, fontSize:11, color:"var(--text-muted)" }}><span style={{ width:7, height:7, borderRadius:"50%", background:"#22c55e", display:"inline-block" }} />Active</span>
          <span style={{ display:"flex", alignItems:"center", gap:4, fontSize:11, color:"var(--text-muted)" }}><span style={{ width:7, height:7, borderRadius:"50%", background:"#f59e0b", display:"inline-block" }} />Waiting</span>
          <span style={{ display:"flex", alignItems:"center", gap:4, fontSize:11, color:"var(--text-muted)" }}><span style={{ width:7, height:7, borderRadius:"50%", background:"#6b7280", display:"inline-block" }} />Done</span>
        </div>
      )}
      <div className="patient-list">
        {filtered.map(p => {
          const hasFlag = (history[p.id] ?? []).some(e => flagged.has(e.id));
          const todayIso = new Date().toISOString().slice(0, 10);
          const nextAppt = appointments
            .filter(a => a.patientId === p.id && a.date >= todayIso)
            .sort((a, b) => a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date))[0];
          const nextApptLabel = nextAppt
            ? (() => {
                const [hh, mm] = nextAppt.time.split(":");
                const h = parseInt(hh);
                const isToday = nextAppt.date === todayIso;
                const dateLabel = isToday
                  ? "Today"
                  : new Date(nextAppt.date + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
                return `${dateLabel}, ${h > 12 ? h - 12 : h || 12}:${mm} ${h >= 12 ? "PM" : "AM"}`;
              })()
            : null;
          return (
            <button key={p.id} className={`patient-card ${selectedId === p.id ? "selected" : ""}`}
              onClick={() => {
                if (recording) {
                  showToast("⚠️ Recording in progress — stop the recording before switching patients.", "error");
                  return;
                }
                if (transcribing) {
                  showToast("⚠️ Transcription in progress — wait for it to finish before switching patients.", "error");
                  return;
                }
                setSelectedId(p.id); setActiveEntryId(null); setError(""); setTranscript(""); setDeleteStep(0); setMobileTab("report");
              }}>
              <div className="patient-row">
                <span className="patient-name">{p.name}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  {(presenceMap[p.id] ?? 0) > 0 && (
                    <span className="patient-presence-badge" title={`${presenceMap[p.id]} other device${presenceMap[p.id] > 1 ? "s" : ""} viewing`}>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeWidth="2.5"/><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2.5"/></svg>
                      {presenceMap[p.id]}
                    </span>
                  )}
                  {hasFlag && <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ color: "#ef4444" }}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/></svg>}
                  <span className="patient-dot" style={{ background: STATUS_COLOR[p.status] }} />
                </div>
              </div>
              <div className="patient-meta">{p.age} y/o · {p.gender}</div>
              <div className="patient-time">🕐 {p.time}</div>
              {(() => {
                const rec = meds[p.id];
                if (!rec) return null;
                const aC = rec.medications.filter(m => m.status === "active").length;
                const dC = rec.medications.filter(m => m.status === "discontinued").length;
                const alC = rec.allergies.length;
                if (aC === 0 && dC === 0 && alC === 0) return null;
                return (
                  <div className="patient-med-summary">
                    {aC > 0  && <span className="med-dot-active">● {aC}</span>}
                    {dC > 0  && <span className="med-dot-disc">● {dC}</span>}
                    {alC > 0 && <span className="med-dot-allergy">⚠ {alC}</span>}
                  </div>
                );
              })()}
              {nextApptLabel && (
                <div className="patient-next-appt">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                    <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/>
                    <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  {nextApptLabel}
                </div>
              )}
              {(history[p.id]?.length ?? 0) > 0 && (
                <div className="patient-report-count">{history[p.id].length} report{history[p.id].length > 1 ? "s" : ""}</div>
              )}
            </button>
          );
        })}
        {filtered.length === 0 && patients.length === 0 && (
          <div style={{ padding: "20px 12px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
            No patients yet.<br/>Click + to add your first patient.
          </div>
        )}
      </div>
    </aside>
  );
}
