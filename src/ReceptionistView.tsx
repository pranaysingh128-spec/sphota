import { useState, useEffect, useRef, useMemo } from "react";
import { supabase } from "./supabase";
import type { Patient, Appointment } from "./types";

interface ReceptionistViewProps {
  userId: string;
  userEmail: string;
}

function fmtTime(time: string) {
  const [hh, mm] = time.split(":");
  const h = parseInt(hh);
  return `${h > 12 ? h - 12 : h || 12}:${mm} ${h >= 12 ? "PM" : "AM"}`;
}

function fmtDate(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function minutesAgo(isoStr: string | null): string {
  if (!isoStr) return "";
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000);
  if (diff < 1) return "just now";
  if (diff === 1) return "1 min ago";
  return `${diff} mins ago`;
}

const STATUS_COLOR: Record<string, string> = {
  waiting: "#f59e0b",
  active: "#22c55e",
  done: "#6b7280",
};

const STATUS_BG: Record<string, string> = {
  waiting: "rgba(245,158,11,0.12)",
  active: "rgba(34,197,94,0.12)",
  done: "rgba(107,114,128,0.12)",
};

const STATUS_LABEL: Record<string, string> = {
  waiting: "Waiting",
  active: "In Session",
  done: "Done",
};

type PatientRow = Patient & { phone?: string; reason?: string; address?: string; checkedInAt?: string | null; createdAt?: string | null };

function mapPatient(r: Record<string, unknown>): PatientRow {
  return {
    id: r.id as number,
    name: r.name as string,
    age: (r.age as number) ?? 0,
    gender: (r.gender as string) ?? "Unknown",
    time: (r.time as string) ?? "",
    status: (r.status as "waiting" | "active" | "done") ?? "waiting",
    phone: (r.phone as string) ?? undefined,
    reason: (r.reason as string) ?? undefined,
    address: (r.address as string) ?? undefined,
    checkedInAt: (r.checked_in_at as string) ?? (r.checkedInAt as string) ?? null,
    createdAt: (r.created_at as string) ?? null,
  };
}

function mapAppointment(r: Record<string, unknown>): Appointment {
  return {
    id: r.id as string,
    patientId: (r.patient_id as number) ?? (r.patientId as number),
    date: r.date as string,
    time: r.time as string,
    notes: (r.notes as string) ?? "",
  };
}

function InitialsAvatar({ name, status, size = 40 }: { name: string; status: string; size?: number }) {
  const initials = name.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2);
  const colors: Record<string, { bg: string; text: string }> = {
    waiting: { bg: "rgba(245,158,11,0.2)", text: "#fbbf24" },
    active: { bg: "rgba(34,197,94,0.2)", text: "#4ade80" },
    done: { bg: "rgba(107,114,128,0.2)", text: "#9ca3af" },
  };
  const c = colors[status] ?? colors.waiting;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: c.bg, display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.325, fontWeight: 700, color: c.text, flexShrink: 0,
      border: `1.5px solid ${c.text}33`,
    }}>
      {initials}
    </div>
  );
}

type ActiveTab = "schedule" | "add" | "upcoming" | "calendar";

interface VisitEntry { patientId: number; date: string; }

export default function ReceptionistView({ userId, userEmail }: ReceptionistViewProps) {
  const [linkedDoctorId, setLinkedDoctorId] = useState<string | null>(() => {
    return sessionStorage.getItem(`psych_recep_linked_${userId}`) ?? null;
  });
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [visitHistory, setVisitHistory] = useState<VisitEntry[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    const s = localStorage.getItem(`psych_recep_tab_${userId}`);
    return (s === "schedule" || s === "add" || s === "upcoming" || s === "calendar") ? s as ActiveTab : "schedule";
  });
  useEffect(() => { localStorage.setItem(`psych_recep_tab_${userId}`, activeTab); }, [activeTab, userId]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Search and filter state
  const [patientSearch, setPatientSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "waiting" | "active" | "done">("all");

  // Add patient form
  const [form, setForm] = useState({ name: "", age: "", gender: "Female", phone: "", reason: "", address: "" });
  const [formBusy, setFormBusy] = useState(false);
  const [formMsg, setFormMsg] = useState("");

  // Appointment form
  const [apptForm, setApptForm] = useState({ patientId: "", date: "", time: "", notes: "" });
  const [apptBusy, setApptBusy] = useState(false);
  const [apptMsg, setApptMsg] = useState("");

  // Reschedule
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [rescheduleForm, setRescheduleForm] = useState({ date: "", time: "", notes: "" });
  const [rescheduleBusy, setRescheduleBusy] = useState(false);

  // Cancel appointment
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  // Soft-delete patient
  const [deletePatientId, setDeletePatientId] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Edit patient details
  const [editPatient, setEditPatient] = useState<PatientRow | null>(null);
  const [editForm, setEditForm] = useState({ name: "", age: "", gender: "Female", phone: "", reason: "", address: "" });
  const [editBusy, setEditBusy] = useState(false);
  const [editMsg, setEditMsg] = useState("");

  // Visit history expansion
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null);

  // Calendar tab
  const [calendarDate, setCalendarDate] = useState<string>(() => new Date().toISOString().slice(0, 10));

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const todayStr = new Date().toISOString().slice(0, 10);
  const in7Days = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  async function apiFetch(path: string, options: RequestInit = {}) {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? "";
    const res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        ...((options.headers as Record<string, string>) ?? {}),
      },
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { if (text.trim()) data = JSON.parse(text); } catch (_e) { /* non-JSON body */ }
    if (!res.ok) {
      const msg = (data as { message?: string })?.message || text.slice(0, 120) || ("Error " + res.status);
      throw new Error(msg);
    }
    return data;
  }

  async function loadDashboard() {
    const data = await apiFetch("/api/receptionist/dashboard");
    const d = data as { linkedDoctorId: string | null; patients: Record<string, unknown>[]; appointments: Record<string, unknown>[]; visitHistory?: Record<string, unknown>[] };
    setLinkedDoctorId(d.linkedDoctorId ?? null);
    if (d.linkedDoctorId) {
      sessionStorage.setItem(`psych_recep_linked_${userId}`, d.linkedDoctorId);
    } else {
      sessionStorage.removeItem(`psych_recep_linked_${userId}`);
    }
    setPatients((d.patients ?? []).map(r => mapPatient(r)));
    setAppointments((d.appointments ?? []).map(r => mapAppointment(r)));
    setVisitHistory((d.visitHistory ?? []).map(r => ({ patientId: r.patient_id as number, date: r.date as string })));
  }

  useEffect(() => {
    async function init() {
      try {
        await loadDashboard();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }
    init();

    pollRef.current = setInterval(() => {
      loadDashboard().catch(() => {});
    }, 60_000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [userId]);

  useEffect(() => {
    if (!linkedDoctorId) return;

    const patientsChannel = supabase
      .channel(`recep-patients-${linkedDoctorId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "patients", filter: `doctor_id=eq.${linkedDoctorId}` },
        () => { loadDashboard().catch(() => {}); })
      .subscribe();

    const apptChannel = supabase
      .channel(`recep-appointments-${linkedDoctorId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments", filter: `doctor_id=eq.${linkedDoctorId}` },
        () => { loadDashboard().catch(() => {}); })
      .subscribe();

    return () => {
      supabase.removeChannel(patientsChannel);
      supabase.removeChannel(apptChannel);
    };
  }, [linkedDoctorId]);

  async function updateStatus(patientId: number, status: "waiting" | "active" | "done") {
    setPatients(prev => prev.map(p => p.id === patientId ? { ...p, status } : p));
    try {
      await apiFetch(`/api/receptionist/patients/${patientId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update status");
      await loadDashboard();
    }
  }

  async function handleAddPatient(e: React.FormEvent) {
    e.preventDefault();
    setFormMsg(""); setFormBusy(true);
    try {
      if (!form.name.trim()) throw new Error("Name is required.");
      await apiFetch("/api/receptionist/patients", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          age: form.age,
          gender: form.gender,
          phone: form.phone.trim() || null,
          reason: form.reason.trim() || null,
          address: form.address.trim() || null,
        }),
      });
      setForm({ name: "", age: "", gender: "Female", phone: "", reason: "", address: "" });
      setFormMsg("Patient added successfully!");
      await loadDashboard();
      setActiveTab("schedule");
      setTimeout(() => setFormMsg(""), 3000);
    } catch (e: unknown) {
      setFormMsg(e instanceof Error ? e.message : "Failed to add patient");
    } finally {
      setFormBusy(false);
    }
  }

  async function handleAddAppointment(e: React.FormEvent) {
    e.preventDefault();
    setApptMsg(""); setApptBusy(true);
    try {
      if (!apptForm.patientId || !apptForm.date || !apptForm.time) throw new Error("Patient, date and time are required.");
      await apiFetch("/api/receptionist/appointments", {
        method: "POST",
        body: JSON.stringify({ patientId: apptForm.patientId, date: apptForm.date, time: apptForm.time, notes: apptForm.notes.trim() }),
      });
      setApptForm({ patientId: "", date: "", time: "", notes: "" });
      setApptMsg("Appointment scheduled!");
      await loadDashboard();
      setTimeout(() => setApptMsg(""), 3000);
    } catch (e: unknown) {
      setApptMsg(e instanceof Error ? e.message : "Failed to schedule appointment");
    } finally {
      setApptBusy(false);
    }
  }

  function openReschedule(a: Appointment) {
    setRescheduleId(a.id);
    setRescheduleForm({ date: a.date, time: a.time, notes: a.notes });
  }

  async function handleReschedule(apptId: string) {
    if (!rescheduleForm.date || !rescheduleForm.time) return;
    setRescheduleBusy(true);
    try {
      await apiFetch(`/api/receptionist/appointments/${apptId}`, {
        method: "PATCH",
        body: JSON.stringify({ date: rescheduleForm.date, time: rescheduleForm.time, notes: rescheduleForm.notes.trim() }),
      });
      setRescheduleId(null);
      await loadDashboard();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to reschedule");
    } finally {
      setRescheduleBusy(false);
    }
  }

  async function handleCancelAppt(apptId: string) {
    setCancelBusy(true);
    try {
      await apiFetch(`/api/receptionist/appointments/${apptId}`, { method: "DELETE" });
      setCancelConfirmId(null);
      await loadDashboard();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to cancel appointment");
    } finally {
      setCancelBusy(false);
    }
  }

  // Soft-delete patient (hidden from receptionist, doctor still sees)
  async function handleDeletePatient(patientId: number) {
    setDeleteBusy(true);
    try {
      await apiFetch(`/api/receptionist/patients/${patientId}`, { method: "DELETE" });
      setDeletePatientId(null);
      setPatients(prev => prev.filter(p => p.id !== patientId));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to remove patient");
    } finally {
      setDeleteBusy(false);
    }
  }

  function openEditPatient(p: PatientRow) {
    setEditPatient(p);
    setEditForm({
      name: p.name,
      age: String(p.age ?? ""),
      gender: p.gender ?? "Female",
      phone: p.phone ?? "",
      reason: p.reason ?? "",
      address: p.address ?? "",
    });
    setEditMsg("");
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editPatient) return;
    setEditBusy(true); setEditMsg("");
    try {
      await apiFetch(`/api/receptionist/patients/${editPatient.id}/details`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editForm.name.trim(),
          age: editForm.age,
          gender: editForm.gender,
          phone: editForm.phone.trim() || null,
          reason: editForm.reason.trim() || null,
          address: editForm.address.trim() || null,
        }),
      });
      setEditPatient(null);
      await loadDashboard();
    } catch (e: unknown) {
      setEditMsg(e instanceof Error ? e.message : "Failed to save changes");
    } finally {
      setEditBusy(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.reload();
  }

  const stats = useMemo(() => ({
    total: patients.length,
    waiting: patients.filter(p => p.status === "waiting").length,
    active: patients.filter(p => p.status === "active").length,
    done: patients.filter(p => p.status === "done").length,
  }), [patients]);

  const todayAppts = appointments
    .filter(a => a.date === todayStr)
    .sort((a, b) => a.time.localeCompare(b.time));

  const upcomingAppts = appointments
    .filter(a => a.date > todayStr && a.date <= in7Days)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  // Today's patients (checked in today or created today)
  const todayPatients = useMemo(() => {
    let list = patients.filter(p => {
      const checkinDate = p.checkedInAt ? p.checkedInAt.slice(0, 10) : null;
      const createdDate = p.createdAt ? p.createdAt.slice(0, 10) : null;
      return checkinDate === todayStr || createdDate === todayStr;
    });
    if (statusFilter !== "all") list = list.filter(p => p.status === statusFilter);
    if (patientSearch.trim()) {
      const q = patientSearch.toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.phone && p.phone.includes(q)) ||
        (p.reason && p.reason.toLowerCase().includes(q))
      );
    }
    const order = { waiting: 0, active: 1, done: 2 };
    return [...list].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  }, [patients, patientSearch, statusFilter, todayStr]);

  // Calendar: patients that visited on the selected date
  const calendarPatients = useMemo(() => {
    // Patients with checkedInAt on that date
    const fromCheckin = patients.filter(p => {
      const d = p.checkedInAt?.slice(0, 10) ?? p.createdAt?.slice(0, 10);
      return d === calendarDate;
    });
    // Also gather patient IDs that have a clinical session on that date
    const fromSessions = visitHistory
      .filter(v => v.date === calendarDate)
      .map(v => v.patientId);
    // Merge: unique patients
    const seen = new Set(fromCheckin.map(p => p.id));
    const extras = fromSessions
      .filter(id => !seen.has(id))
      .map(id => patients.find(p => p.id === id))
      .filter(Boolean) as PatientRow[];
    return [...fromCheckin, ...extras];
  }, [patients, visitHistory, calendarDate]);

  // Visit dates per patient (from report_entries)
  const visitsByPatient = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const v of visitHistory) {
      if (!map[v.patientId]) map[v.patientId] = [];
      if (!map[v.patientId].includes(v.date)) map[v.patientId].push(v.date);
    }
    // Sort each desc
    for (const id in map) map[id].sort((a, b) => b.localeCompare(a));
    return map;
  }, [visitHistory]);

  // Live clock for waiting time refresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60000);
    return () => clearInterval(t);
  }, []);

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "9px 11px", borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.25)",
    color: "#f1f5f9", fontSize: 13, outline: "none", boxSizing: "border-box",
  };

  // ── Patient card component (shared between today and calendar views) ──────
  function PatientCard({ p, showDate = false }: { p: PatientRow; showDate?: boolean }) {
    const appt = todayAppts.find(a => a.patientId === p.id);
    const waitingMins = p.checkedInAt && p.status === "waiting"
      ? Math.floor((Date.now() - new Date(p.checkedInAt).getTime()) / 60000)
      : null;
    const patientVisits = visitsByPatient[p.id] ?? [];
    const isHistoryOpen = expandedHistory === p.id;
    const canEdit = p.status === "waiting";

    return (
      <div style={{
        background: p.status === "active" ? "rgba(34,197,94,0.04)" : "rgba(255,255,255,0.03)",
        borderRadius: 12,
        border: `1px solid ${p.status === "active" ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.07)"}`,
        overflow: "hidden",
        transition: "all 0.15s",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
          <InitialsAvatar name={p.name} status={p.status} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: "#f1f5f9" }}>{p.name}</span>
              {p.status === "active" && (
                <span style={{ fontSize: 10, fontWeight: 700, color: "#4ade80", background: "rgba(34,197,94,0.15)", borderRadius: 10, padding: "1px 7px" }}>
                  IN SESSION
                </span>
              )}
              {waitingMins !== null && waitingMins >= 15 && (
                <span style={{ fontSize: 10, fontWeight: 700, color: "#fb923c", background: "rgba(249,115,22,0.15)", borderRadius: 10, padding: "1px 7px" }}>
                  {waitingMins}m wait
                </span>
              )}
              {patientVisits.length > 0 && (
                <button
                  onClick={() => setExpandedHistory(isHistoryOpen ? null : p.id)}
                  style={{
                    fontSize: 10, fontWeight: 600, color: "#93c5fd",
                    background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.25)",
                    borderRadius: 10, padding: "1px 8px", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 3,
                  }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  {patientVisits.length} visit{patientVisits.length !== 1 ? "s" : ""}
                </button>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span>{p.age} y/o · {p.gender}</span>
              {p.phone && (
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6.18 6.18l.95-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  {p.phone}
                </span>
              )}
              {p.reason && (
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  {p.reason}
                </span>
              )}
              {showDate && p.checkedInAt && (
                <span style={{ color: "#a78bfa" }}>{fmtDate(p.checkedInAt.slice(0, 10))}</span>
              )}
              {!showDate && (appt ? (
                <span style={{ color: "#93c5fd" }}>Appt: {fmtTime(appt.time)}</span>
              ) : (
                <span>Walk-in</span>
              ))}
            </div>
            {p.checkedInAt && p.status === "waiting" && !showDate && (
              <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 3 }}>
                ⏱ Waiting {minutesAgo(p.checkedInAt)}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
            {/* Status transition buttons */}
            {(["waiting", "active", "done"] as const).filter(s => s !== p.status).map(s => (
              <button
                key={s}
                onClick={() => updateStatus(p.id, s)}
                title={`Mark as ${STATUS_LABEL[s]}`}
                style={{
                  padding: "5px 10px", borderRadius: 7,
                  border: `1px solid ${STATUS_COLOR[s]}44`,
                  background: STATUS_BG[s],
                  color: STATUS_COLOR[s],
                  fontSize: 11, fontWeight: 600, cursor: "pointer",
                  transition: "all 0.15s", whiteSpace: "nowrap",
                }}
              >
                → {STATUS_LABEL[s]}
              </button>
            ))}

            {/* Edit button — only when waiting */}
            {canEdit && (
              <button
                onClick={() => openEditPatient(p)}
                title="Edit patient details"
                style={{
                  padding: "5px 8px", borderRadius: 7,
                  border: "1px solid rgba(99,102,241,0.4)",
                  background: "rgba(99,102,241,0.1)",
                  color: "#a5b4fc", fontSize: 11, fontWeight: 600, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 3,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Edit
              </button>
            )}

            {/* Status badge */}
            <div style={{
              minWidth: 72, textAlign: "center",
              padding: "5px 10px", borderRadius: 8,
              background: STATUS_BG[p.status],
              border: `1px solid ${STATUS_COLOR[p.status]}44`,
              color: STATUS_COLOR[p.status],
              fontSize: 12, fontWeight: 700, flexShrink: 0,
            }}>
              {STATUS_LABEL[p.status]}
            </div>

            {/* WhatsApp notify */}
            {p.phone && (
              <a
                href={`https://wa.me/${p.phone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(`Hello ${p.name}, your appointment is ready. Please proceed to the clinic. Thank you! 🙏`)}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Notify via WhatsApp"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                  background: "rgba(37,211,102,0.12)",
                  border: "1px solid rgba(37,211,102,0.3)",
                  color: "#25d366", textDecoration: "none", fontSize: 15,
                }}
              >
                💬
              </a>
            )}

            {/* Delete (soft) button */}
            <button
              onClick={() => setDeletePatientId(p.id)}
              title="Remove patient from your view"
              style={{
                width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.25)",
                color: "#f87171", cursor: "pointer",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
        </div>

        {/* Expandable visit history */}
        {isHistoryOpen && patientVisits.length > 0 && (
          <div style={{
            padding: "10px 16px 12px",
            borderTop: "1px solid rgba(59,130,246,0.15)",
            background: "rgba(59,130,246,0.04)",
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              Visit History (clinical sessions)
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {patientVisits.map(date => (
                <span key={date} style={{
                  fontSize: 12, padding: "3px 10px", borderRadius: 20,
                  background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.25)",
                  color: "#93c5fd", fontWeight: 600,
                }}>
                  {fmtDate(date)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-theme="dark" style={{
      minHeight: "100vh", height: "100vh", overflowY: "auto",
      background: "linear-gradient(135deg,#080d1a,#0a1628 50%,#0d0d0f)",
      fontFamily: "system-ui,sans-serif", color: "#f1f5f9",
    }}>
      {/* Header */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 28px", borderBottom: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(8,13,26,0.9)", backdropFilter: "blur(12px)",
        position: "sticky", top: 0, zIndex: 50,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "linear-gradient(135deg,#1d4ed8,#3b82f6)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 2a5 5 0 1 0 0 10A5 5 0 0 0 12 2zM4 20a8 8 0 0 1 16 0" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <span style={{ fontWeight: 700, color: "#f1f5f9", fontSize: 15 }}>Sphota</span>
            <span style={{ fontSize: 11, background: "rgba(59,130,246,0.2)", color: "#93c5fd", borderRadius: 10, padding: "2px 8px", marginLeft: 8, fontWeight: 600 }}>
              Reception
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#64748b" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", display: "inline-block", boxShadow: "0 0 6px #22c55e" }} />
            Live
          </div>
          <span className="recep-header-email" style={{ fontSize: 12, color: "#64748b" }}>{userEmail}</span>
          <button onClick={handleSignOut} style={{
            padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)",
            background: "transparent", color: "#94a3b8", fontSize: 12, cursor: "pointer",
          }}>
            Sign Out
          </button>
        </div>
      </header>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 300 }}>
          <div className="spinner" />
        </div>
      ) : !linkedDoctorId ? (
        <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center", padding: "0 24px" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔄</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Almost there…</h2>
          <p style={{ color: "#94a3b8", lineHeight: 1.6 }}>
            Your account is being set up. This should only take a moment — please refresh the page in a few seconds.
          </p>
          <button
            onClick={() => { setLoading(true); loadDashboard().catch(() => {}).finally(() => setLoading(false)); }}
            style={{
              marginTop: 20, padding: "10px 24px", borderRadius: 9,
              background: "#3b82f6", color: "#fff", border: "none",
              fontSize: 14, fontWeight: 600, cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 20px 80px" }}>

          {error && (
            <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>
              {error}
              <button onClick={() => setError("")} style={{ marginLeft: 8, background: "none", border: "none", color: "#fca5a5", cursor: "pointer", fontSize: 13 }}>✕</button>
            </div>
          )}

          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 24 }}>
            {[
              { label: "Today", value: stats.total, color: "#93c5fd", bg: "rgba(59,130,246,0.08)" },
              { label: "Waiting", value: stats.waiting, color: "#fbbf24", bg: "rgba(245,158,11,0.08)" },
              { label: "In Session", value: stats.active, color: "#4ade80", bg: "rgba(34,197,94,0.08)" },
              { label: "Done", value: stats.done, color: "#6b7280", bg: "rgba(107,114,128,0.08)" },
            ].map(s => (
              <div key={s.label} style={{
                background: s.bg, border: `1px solid ${s.color}33`,
                borderRadius: 12, padding: "14px 16px",
                display: "flex", flexDirection: "column", gap: 4,
              }}>
                <span style={{ fontSize: 22, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</span>
                <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{s.label}</span>
              </div>
            ))}
          </div>

          {/* Tab bar */}
          <div className="recep-tabs" style={{ display: "flex", gap: 4, marginBottom: 24, background: "rgba(255,255,255,0.04)", borderRadius: 12, padding: 4 }}>
            {([
              { key: "schedule" as ActiveTab, label: "Today", icon: (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              )},
              { key: "calendar" as ActiveTab, label: "Calendar", icon: (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="8" cy="16" r="1.5" fill="currentColor"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/><circle cx="16" cy="16" r="1.5" fill="currentColor"/></svg>
              )},
              { key: "add" as ActiveTab, label: "Add Patient", icon: (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              )},
              { key: "upcoming" as ActiveTab, label: "Upcoming", icon: (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              )},
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  flex: 1, padding: "9px 12px", borderRadius: 9, border: "none", cursor: "pointer",
                  fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  background: activeTab === tab.key ? "#3b82f6" : "transparent",
                  color: activeTab === tab.key ? "#fff" : "#94a3b8",
                  transition: "all 0.15s",
                }}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* ── TODAY'S SCHEDULE ── */}
          {activeTab === "schedule" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>
                  {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                </h2>
                <button
                  onClick={() => { setLoading(true); loadDashboard().catch(() => {}).finally(() => setLoading(false)); }}
                  style={{
                    padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)",
                    background: "transparent", color: "#94a3b8", fontSize: 12, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 5,
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M21 3v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M8 16H3v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Refresh
                </button>
              </div>

              {/* Search + Filter row */}
              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200, position: "relative" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{
                    position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
                    color: "#64748b", pointerEvents: "none",
                  }}>
                    <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
                    <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  <input
                    type="text"
                    placeholder="Search by name, phone, or reason…"
                    value={patientSearch}
                    onChange={e => setPatientSearch(e.target.value)}
                    style={{ ...inputStyle, paddingLeft: 32, background: "rgba(255,255,255,0.05)" }}
                  />
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  {(["all", "waiting", "active", "done"] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      style={{
                        padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                        fontSize: 12, fontWeight: 600,
                        background: statusFilter === s ? (s === "all" ? "#3b82f6" : STATUS_BG[s]) : "rgba(255,255,255,0.05)",
                        color: statusFilter === s ? (s === "all" ? "#fff" : STATUS_COLOR[s]) : "#94a3b8",
                        transition: "all 0.15s",
                      }}
                    >
                      {s === "all" ? "All" : STATUS_LABEL[s]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Patient list */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
                {todayPatients.length === 0 ? (
                  <div style={{ padding: "32px 20px", textAlign: "center", color: "#64748b", fontSize: 14, background: "rgba(255,255,255,0.03)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.07)" }}>
                    {patientSearch || statusFilter !== "all"
                      ? "No patients match your search/filter."
                      : "No patients yet today. Use \"Add Patient\" to register a walk-in."}
                  </div>
                ) : (
                  todayPatients.map(p => <PatientCard key={p.id} p={p} />)
                )}
              </div>

              {/* Today's scheduled appointments */}
              {todayAppts.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    Scheduled Appointments Today
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {todayAppts.map(a => {
                      const p = patients.find(pat => pat.id === a.patientId);
                      return (
                        <div key={a.id} style={{
                          display: "flex", alignItems: "center", gap: 12,
                          background: "rgba(59,130,246,0.05)", borderRadius: 10,
                          border: "1px solid rgba(59,130,246,0.15)", padding: "10px 14px",
                        }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#93c5fd", minWidth: 64 }}>{fmtTime(a.time)}</span>
                          <span style={{ flex: 1, fontSize: 14, color: "#e2e8f0" }}>{p?.name ?? "Unknown"}</span>
                          {a.notes && <span style={{ fontSize: 12, color: "#64748b" }}>{a.notes}</span>}
                          {p && (
                            <span style={{ fontSize: 12, fontWeight: 600, color: STATUS_COLOR[p.status] }}>
                              {STATUS_LABEL[p.status]}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── CALENDAR VIEW ── */}
          {activeTab === "calendar" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0", margin: 0 }}>
                  Browse by Date
                </h2>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    onClick={() => {
                      const d = new Date(calendarDate + "T12:00:00");
                      d.setDate(d.getDate() - 1);
                      setCalendarDate(d.toISOString().slice(0, 10));
                    }}
                    style={{
                      width: 34, height: 34, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)",
                      background: "transparent", color: "#94a3b8", fontSize: 16, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    ‹
                  </button>
                  <input
                    type="date"
                    value={calendarDate}
                    onChange={e => setCalendarDate(e.target.value)}
                    style={{
                      padding: "8px 12px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(0,0,0,0.3)", color: "#f1f5f9", fontSize: 14,
                      colorScheme: "dark", cursor: "pointer",
                    }}
                  />
                  <button
                    onClick={() => {
                      const d = new Date(calendarDate + "T12:00:00");
                      d.setDate(d.getDate() + 1);
                      setCalendarDate(d.toISOString().slice(0, 10));
                    }}
                    style={{
                      width: 34, height: 34, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)",
                      background: "transparent", color: "#94a3b8", fontSize: 16, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    ›
                  </button>
                  {calendarDate !== todayStr && (
                    <button
                      onClick={() => setCalendarDate(todayStr)}
                      style={{
                        padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(59,130,246,0.4)",
                        background: "rgba(59,130,246,0.1)", color: "#93c5fd", fontSize: 12, fontWeight: 600, cursor: "pointer",
                      }}
                    >
                      Today
                    </button>
                  )}
                </div>
              </div>

              {/* Selected date label */}
              <div style={{
                padding: "10px 16px", borderRadius: 10, marginBottom: 16,
                background: calendarDate === todayStr ? "rgba(59,130,246,0.08)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${calendarDate === todayStr ? "rgba(59,130,246,0.3)" : "rgba(255,255,255,0.07)"}`,
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="4" width="18" height="18" rx="2" stroke={calendarDate === todayStr ? "#93c5fd" : "#64748b"} strokeWidth="2"/>
                  <path d="M16 2v4M8 2v4M3 10h18" stroke={calendarDate === todayStr ? "#93c5fd" : "#64748b"} strokeWidth="2" strokeLinecap="round"/>
                </svg>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>
                    {new Date(calendarDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                  </span>
                  {calendarDate === todayStr && <span style={{ fontSize: 12, color: "#93c5fd", marginLeft: 8, fontWeight: 600 }}>Today</span>}
                </div>
                <div style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700, color: "#64748b" }}>
                  {calendarPatients.length} patient{calendarPatients.length !== 1 ? "s" : ""}
                </div>
              </div>

              {/* Appointments on this date */}
              {(() => {
                const dayAppts = appointments
                  .filter(a => a.date === calendarDate)
                  .sort((a, b) => a.time.localeCompare(b.time));
                if (dayAppts.length === 0) return null;
                return (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                      Scheduled Appointments
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {dayAppts.map(a => {
                        const p = patients.find(pat => pat.id === a.patientId);
                        return (
                          <div key={a.id} style={{
                            display: "flex", alignItems: "center", gap: 12,
                            background: "rgba(59,130,246,0.05)", borderRadius: 10,
                            border: "1px solid rgba(59,130,246,0.15)", padding: "10px 14px",
                          }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "#93c5fd", minWidth: 64 }}>{fmtTime(a.time)}</span>
                            <span style={{ flex: 1, fontSize: 14, color: "#e2e8f0" }}>{p?.name ?? "Unknown patient"}</span>
                            {a.notes && <span style={{ fontSize: 12, color: "#64748b" }}>{a.notes}</span>}
                            {p && <span style={{ fontSize: 12, fontWeight: 600, color: STATUS_COLOR[p.status] }}>{STATUS_LABEL[p.status]}</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Patient cards for this date */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {calendarPatients.length === 0 ? (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: "#64748b", fontSize: 14, background: "rgba(255,255,255,0.03)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.07)" }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>📅</div>
                    No patients found for this date.
                    {calendarDate === todayStr && (
                      <div style={{ marginTop: 8 }}>
                        <button
                          onClick={() => setActiveTab("add")}
                          style={{
                            padding: "8px 16px", borderRadius: 8, border: "none",
                            background: "#3b82f6", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
                          }}
                        >
                          + Register a patient
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  calendarPatients.map(p => <PatientCard key={p.id} p={p} showDate={calendarDate !== todayStr} />)
                )}
              </div>
            </div>
          )}

          {/* ── ADD PATIENT / APPOINTMENT ── */}
          {activeTab === "add" && (
            <div className="recep-add-grid">
              {/* Add Patient */}
              <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 14, border: "1px solid rgba(255,255,255,0.07)", padding: 24 }}>
                <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 18, color: "#e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 7, background: "rgba(59,130,246,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round"/></svg>
                  </div>
                  Register New Patient
                </h3>
                <form onSubmit={handleAddPatient} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {[
                    { label: "Full Name *", key: "name", type: "text", placeholder: "Patient full name" },
                    { label: "Age", key: "age", type: "number", placeholder: "e.g. 34" },
                    { label: "Phone Number", key: "phone", type: "tel", placeholder: "e.g. 9876543210" },
                    { label: "Reason for Visit", key: "reason", type: "text", placeholder: "Chief complaint" },
                    { label: "Address (optional)", key: "address", type: "text", placeholder: "Patient address" },
                  ].map(f => (
                    <div key={f.key}>
                      <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 5 }}>{f.label}</label>
                      <input
                        type={f.type}
                        placeholder={f.placeholder}
                        value={form[f.key as keyof typeof form]}
                        onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                        disabled={formBusy}
                        style={inputStyle}
                      />
                    </div>
                  ))}
                  <div>
                    <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 5 }}>Gender</label>
                    <select
                      value={form.gender}
                      onChange={e => setForm(prev => ({ ...prev, gender: e.target.value }))}
                      disabled={formBusy}
                      style={{ ...inputStyle }}
                    >
                      <option>Female</option>
                      <option>Male</option>
                      <option>Other</option>
                    </select>
                  </div>
                  {formMsg && (
                    <div style={{
                      padding: "9px 12px", borderRadius: 8, fontSize: 13,
                      background: formMsg.includes("success") ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      border: `1px solid ${formMsg.includes("success") ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: formMsg.includes("success") ? "#4ade80" : "#f87171",
                    }}>
                      {formMsg}
                    </div>
                  )}
                  <button type="submit" disabled={formBusy} style={{
                    padding: "11px", borderRadius: 9, border: "none",
                    background: formBusy ? "#334155" : "linear-gradient(135deg,#2563eb,#3b82f6)",
                    color: "#fff", fontSize: 14, fontWeight: 700,
                    cursor: formBusy ? "not-allowed" : "pointer", marginTop: 4,
                    boxShadow: formBusy ? "none" : "0 4px 12px rgba(59,130,246,0.3)",
                  }}>
                    {formBusy ? "Registering…" : "Register Patient"}
                  </button>
                </form>
              </div>

              {/* Schedule Appointment */}
              <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 14, border: "1px solid rgba(255,255,255,0.07)", padding: 24 }}>
                <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 18, color: "#e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 7, background: "rgba(16,185,129,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="#34d399" strokeWidth="2"/><path d="M16 2v4M8 2v4M3 10h18" stroke="#34d399" strokeWidth="2" strokeLinecap="round"/></svg>
                  </div>
                  Schedule Appointment
                </h3>
                <form onSubmit={handleAddAppointment} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 5 }}>Patient *</label>
                    <select
                      value={apptForm.patientId}
                      onChange={e => setApptForm(prev => ({ ...prev, patientId: e.target.value }))}
                      disabled={apptBusy}
                      style={inputStyle}
                    >
                      <option value="">Select patient…</option>
                      {patients.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 5 }}>Date *</label>
                    <input type="date" value={apptForm.date} onChange={e => setApptForm(prev => ({ ...prev, date: e.target.value }))} disabled={apptBusy} min={todayStr} style={{ ...inputStyle, colorScheme: "dark" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 5 }}>Time *</label>
                    <input type="time" value={apptForm.time} onChange={e => setApptForm(prev => ({ ...prev, time: e.target.value }))} disabled={apptBusy} style={{ ...inputStyle, colorScheme: "dark" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 5 }}>Notes (optional)</label>
                    <input type="text" placeholder="e.g. Follow-up, First visit…" value={apptForm.notes} onChange={e => setApptForm(prev => ({ ...prev, notes: e.target.value }))} disabled={apptBusy} style={inputStyle} />
                  </div>
                  {apptMsg && (
                    <div style={{
                      padding: "9px 12px", borderRadius: 8, fontSize: 13,
                      background: apptMsg.includes("scheduled") ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      border: `1px solid ${apptMsg.includes("scheduled") ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: apptMsg.includes("scheduled") ? "#4ade80" : "#f87171",
                    }}>
                      {apptMsg}
                    </div>
                  )}
                  <button type="submit" disabled={apptBusy} style={{
                    padding: "11px", borderRadius: 9, border: "none",
                    background: apptBusy ? "#334155" : "linear-gradient(135deg,#059669,#10b981)",
                    color: "#fff", fontSize: 14, fontWeight: 700,
                    cursor: apptBusy ? "not-allowed" : "pointer", marginTop: 4,
                    boxShadow: apptBusy ? "none" : "0 4px 12px rgba(16,185,129,0.3)",
                  }}>
                    {apptBusy ? "Scheduling…" : "Schedule Appointment"}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* ── UPCOMING APPOINTMENTS ── */}
          {activeTab === "upcoming" && (
            <div>
              <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: "#e2e8f0" }}>
                Next 7 Days
              </h2>
              {upcomingAppts.length === 0 ? (
                <div style={{ padding: "40px 20px", textAlign: "center", color: "#64748b", fontSize: 14, background: "rgba(255,255,255,0.03)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.07)" }}>
                  No upcoming appointments in the next 7 days.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {upcomingAppts.map(a => {
                    const p = patients.find(pat => pat.id === a.patientId);
                    const dateLabel = new Date(a.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
                    const isRescheduling = rescheduleId === a.id;
                    return (
                      <div key={a.id} style={{
                        background: "rgba(255,255,255,0.03)", borderRadius: 12,
                        border: `1px solid ${isRescheduling ? "rgba(59,130,246,0.4)" : "rgba(255,255,255,0.07)"}`,
                        overflow: "hidden",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 16px" }}>
                          <div style={{
                            textAlign: "center", minWidth: 56,
                            background: "rgba(59,130,246,0.1)", borderRadius: 8, padding: "6px 4px",
                          }}>
                            <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>{dateLabel.split(",")[0]}</div>
                            <div style={{ fontSize: 14, color: "#93c5fd", fontWeight: 800 }}>{dateLabel.split(",")[1]?.trim()}</div>
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 14, color: "#f1f5f9" }}>{p?.name ?? "Unknown"}</div>
                            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                              {fmtTime(a.time)}{a.notes ? ` · ${a.notes}` : ""}
                            </div>
                          </div>
                          {p && (
                            <span style={{ fontSize: 12, fontWeight: 600, color: STATUS_COLOR[p.status], marginRight: 4 }}>
                              {STATUS_LABEL[p.status]}
                            </span>
                          )}
                          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                            <button
                              onClick={() => isRescheduling ? setRescheduleId(null) : openReschedule(a)}
                              style={{
                                padding: "5px 10px", borderRadius: 7, border: "1px solid rgba(59,130,246,0.4)",
                                background: isRescheduling ? "rgba(59,130,246,0.2)" : "transparent",
                                color: "#93c5fd", fontSize: 12, fontWeight: 600, cursor: "pointer",
                              }}
                            >
                              {isRescheduling ? "Cancel edit" : "Reschedule"}
                            </button>
                            <button
                              onClick={() => setCancelConfirmId(a.id)}
                              style={{
                                padding: "5px 10px", borderRadius: 7, border: "1px solid rgba(239,68,68,0.3)",
                                background: "transparent", color: "#f87171", fontSize: 12, fontWeight: 600, cursor: "pointer",
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>

                        {isRescheduling && (
                          <div style={{
                            padding: "12px 16px", borderTop: "1px solid rgba(59,130,246,0.2)",
                            background: "rgba(59,130,246,0.04)",
                            display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap",
                          }}>
                            <div>
                              <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>New Date</label>
                              <input type="date" value={rescheduleForm.date} min={todayStr}
                                onChange={e => setRescheduleForm(prev => ({ ...prev, date: e.target.value }))}
                                style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#f1f5f9", fontSize: 13, colorScheme: "dark" }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>New Time</label>
                              <input type="time" value={rescheduleForm.time}
                                onChange={e => setRescheduleForm(prev => ({ ...prev, time: e.target.value }))}
                                style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#f1f5f9", fontSize: 13, colorScheme: "dark" }}
                              />
                            </div>
                            <div style={{ flex: 1, minWidth: 140 }}>
                              <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>Notes</label>
                              <input type="text" value={rescheduleForm.notes}
                                onChange={e => setRescheduleForm(prev => ({ ...prev, notes: e.target.value }))}
                                placeholder="Optional notes"
                                style={{ width: "100%", padding: "7px 10px", borderRadius: 7, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#f1f5f9", fontSize: 13, boxSizing: "border-box" }}
                              />
                            </div>
                            <button
                              onClick={() => handleReschedule(a.id)}
                              disabled={rescheduleBusy || !rescheduleForm.date || !rescheduleForm.time}
                              style={{
                                padding: "7px 16px", borderRadius: 7, border: "none",
                                background: rescheduleBusy ? "#475569" : "#3b82f6",
                                color: "#fff", fontSize: 13, fontWeight: 600,
                                cursor: rescheduleBusy ? "not-allowed" : "pointer",
                              }}
                            >
                              {rescheduleBusy ? "Saving…" : "Save"}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── EDIT PATIENT MODAL ── */}
      {editPatient && (
        <div
          onClick={() => !editBusy && setEditPatient(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: "20px",
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "#0f172a", border: "1px solid rgba(99,102,241,0.3)",
              borderRadius: 16, padding: "28px 28px 24px", maxWidth: 460, width: "100%",
              boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(99,102,241,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>Edit Patient Details</h3>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>Only available while patient is waiting</p>
              </div>
            </div>

            <form onSubmit={handleSaveEdit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                { label: "Full Name *", key: "name", type: "text", placeholder: "Patient full name" },
                { label: "Age", key: "age", type: "number", placeholder: "e.g. 34" },
                { label: "Phone Number", key: "phone", type: "tel", placeholder: "e.g. 9876543210" },
                { label: "Reason for Visit", key: "reason", type: "text", placeholder: "Chief complaint" },
                { label: "Address", key: "address", type: "text", placeholder: "Patient address" },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 5 }}>{f.label}</label>
                  <input
                    type={f.type}
                    placeholder={f.placeholder}
                    value={editForm[f.key as keyof typeof editForm]}
                    onChange={e => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    disabled={editBusy}
                    style={inputStyle}
                  />
                </div>
              ))}
              <div>
                <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 5 }}>Gender</label>
                <select
                  value={editForm.gender}
                  onChange={e => setEditForm(prev => ({ ...prev, gender: e.target.value }))}
                  disabled={editBusy}
                  style={inputStyle}
                >
                  <option>Female</option>
                  <option>Male</option>
                  <option>Other</option>
                  <option>Prefer not to say</option>
                </select>
              </div>

              {editMsg && (
                <div style={{
                  padding: "9px 12px", borderRadius: 8, fontSize: 13,
                  background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171",
                }}>
                  {editMsg}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setEditPatient(null)}
                  disabled={editBusy}
                  style={{
                    flex: 1, padding: "10px", borderRadius: 9,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "transparent", color: "#94a3b8",
                    fontSize: 14, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editBusy}
                  style={{
                    flex: 2, padding: "10px", borderRadius: 9, border: "none",
                    background: editBusy ? "#334155" : "linear-gradient(135deg,#4f46e5,#6366f1)",
                    color: "#fff", fontSize: 14, fontWeight: 700,
                    cursor: editBusy ? "not-allowed" : "pointer",
                    boxShadow: editBusy ? "none" : "0 4px 12px rgba(99,102,241,0.3)",
                  }}
                >
                  {editBusy ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── DELETE PATIENT CONFIRMATION MODAL ── */}
      {deletePatientId !== null && (() => {
        const p = patients.find(pt => pt.id === deletePatientId);
        return (
          <div
            onClick={() => !deleteBusy && setDeletePatientId(null)}
            style={{
              position: "fixed", inset: 0, zIndex: 200,
              background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: "#0f172a", border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 16, padding: "28px 32px", maxWidth: 400, width: "90%",
                boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
              }}
            >
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(239,68,68,0.12)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>
                Remove from your list?
              </h3>
              <p style={{ margin: "0 0 8px", fontSize: 13, color: "#94a3b8", lineHeight: 1.5 }}>
                {p && <><strong style={{ color: "#e2e8f0" }}>{p.name}</strong> will be hidden from your view.<br /></>}
                The doctor will still see this patient and their records. Only the doctor can permanently delete a patient.
              </p>
              <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                <button
                  onClick={() => setDeletePatientId(null)}
                  disabled={deleteBusy}
                  style={{
                    flex: 1, padding: "10px", borderRadius: 9,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "transparent", color: "#94a3b8",
                    fontSize: 14, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  Keep them
                </button>
                <button
                  onClick={() => handleDeletePatient(deletePatientId!)}
                  disabled={deleteBusy}
                  style={{
                    flex: 1, padding: "10px", borderRadius: 9,
                    border: "none", background: deleteBusy ? "#7f1d1d" : "#dc2626",
                    color: "#fff", fontSize: 14, fontWeight: 600,
                    cursor: deleteBusy ? "not-allowed" : "pointer",
                  }}
                >
                  {deleteBusy ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── CANCEL APPOINTMENT MODAL ── */}
      {cancelConfirmId && (() => {
        const appt = appointments.find(a => a.id === cancelConfirmId);
        const patient = appt ? patients.find(p => p.id === appt.patientId) : null;
        const dateLabel = appt
          ? new Date(appt.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
          : "";
        return (
          <div
            onClick={() => !cancelBusy && setCancelConfirmId(null)}
            style={{
              position: "fixed", inset: 0, zIndex: 200,
              background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: "#0f172a", border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 16, padding: "28px 32px", maxWidth: 380, width: "90%",
                boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
              }}
            >
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(239,68,68,0.12)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>Cancel this appointment?</h3>
              <p style={{ margin: "0 0 20px", fontSize: 13, color: "#94a3b8", lineHeight: 1.5 }}>
                {patient?.name && <><strong style={{ color: "#e2e8f0" }}>{patient.name}</strong> — </>}
                {dateLabel} at {appt ? fmtTime(appt.time) : ""}
                <br />This cannot be undone.
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={() => setCancelConfirmId(null)}
                  disabled={cancelBusy}
                  style={{
                    flex: 1, padding: "10px", borderRadius: 9,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "transparent", color: "#94a3b8",
                    fontSize: 14, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  Keep it
                </button>
                <button
                  onClick={() => handleCancelAppt(cancelConfirmId)}
                  disabled={cancelBusy}
                  style={{
                    flex: 1, padding: "10px", borderRadius: 9,
                    border: "none", background: cancelBusy ? "#7f1d1d" : "#dc2626",
                    color: "#fff", fontSize: 14, fontWeight: 600,
                    cursor: cancelBusy ? "not-allowed" : "pointer",
                  }}
                >
                  {cancelBusy ? "Cancelling…" : "Yes, cancel it"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
