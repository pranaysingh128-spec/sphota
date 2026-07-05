import { supabase } from "./supabase";
import type { DoctorProfile, Patient, PatientMedRecord, ReportEntry, Appointment } from "./types";

// ── Helpers ────────────────────────────────────────────────────
//
// PERFORMANCE FIX: previously every data function (getProfile, getPatients,
// getSessions, getAllMedications, getAppointments, ...) called getUid(), and
// getUid() called supabase.auth.getUser() — a real network round trip to the
// Supabase auth server — on every single invocation. When App.tsx's initial
// loadAll() fires 5+ of these in Promise.all, that meant 5+ *sequential*
// auth round trips queueing up before any real data query could even start,
// which is exactly the "7 duplicate `user` requests taking up to 4+ seconds
// each" pattern seen in production. The user's ID does not change during a
// session, so it only ever needs to be resolved once.
//
// Fix: cache the resolved ID after the first successful lookup, and
// deduplicate concurrent in-flight calls so that N simultaneous getUid()
// callers share a single underlying network request instead of firing N.
let cachedUid: string | null = null;
let inFlightUidPromise: Promise<string> | null = null;

// Call this on sign-out / account switch so a stale or wrong user ID is
// never reused for a different signed-in user.
export function clearCachedUid(): void {
  cachedUid = null;
  inFlightUidPromise = null;
}

// Belt-and-suspenders: also clear automatically on any SIGNED_OUT event,
// regardless of which of the several sign-out call sites in the app
// triggered it. This is the single choke point that guarantees the cache
// can never outlive its session.
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") clearCachedUid();
});

async function resolveUid(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (data.user?.id) return data.user.id;
  // Mobile: session may not be fully restored yet — try getSession as fallback
  const { data: sd } = await supabase.auth.getSession();
  if (sd.session?.user?.id) return sd.session.user.id;
  throw new Error("Not authenticated");
}

async function getUid(): Promise<string> {
  if (cachedUid) return cachedUid;
  if (inFlightUidPromise) return inFlightUidPromise;
  inFlightUidPromise = resolveUid()
    .then(id => {
      cachedUid = id;
      inFlightUidPromise = null;
      return id;
    })
    .catch(err => {
      // Don't cache failures — let the next call retry from scratch.
      inFlightUidPromise = null;
      throw err;
    });
  return inFlightUidPromise;
}

// ══════════════════════════════════════════════════════════════
// DOCTOR PROFILE
// ══════════════════════════════════════════════════════════════

export async function getProfile(): Promise<DoctorProfile | null> {
  const id = await getUid();
  const { data } = await supabase.from("doctors").select("*").eq("id", id).maybeSingle();
  // Check localStorage as a fallback for privacy acceptance (used before the
  // Supabase migration adds the privacy_accepted_at column, or as a quick cache).
  const localPrivacy = localStorage.getItem(`psych_privacy_accepted_${id}`) ?? null;
  if (!data) return null;
  return {
    name:              data.name          ?? "",
    specialty:         data.specialty     ?? "Psychiatry",
    clinic:            data.clinic        ?? "",
    contact:           data.contact       ?? "",
    privacyAcceptedAt: (data as Record<string, unknown>).privacy_accepted_at as string | null
                       ?? localPrivacy,
    dataRegion:        ((data as Record<string, unknown>).data_region as string | null) ?? "India",
    noteFormat:        (((data as Record<string, unknown>).note_format as string | null)
                       ?? localStorage.getItem("psych_note_format")
                       ?? "SOAP") as import("./types").NoteFormat,
    dataRetentionYears: (((data as Record<string, unknown>).data_retention_years as string | null)
                        ?? localStorage.getItem("psych_data_retention_years")
                        ?? "never") as import("./types").DoctorProfile["dataRetentionYears"],
  };
}

// ── Privacy consent (DPDP Act 2023) ────────────────────────────
// Persists the doctor's acceptance timestamp to the doctors table and to
// localStorage (as a fallback if the Supabase migration hasn't been applied yet).
// Run the migration in supabase_setup.sql to enable permanent cross-device storage.
export async function acceptPrivacy(): Promise<void> {
  const id = await getUid();
  const acceptedAt = new Date().toISOString();
  // Always write to localStorage so the notice doesn't repeat this session
  // even if the Supabase column hasn't been migrated yet.
  localStorage.setItem(`psych_privacy_accepted_${id}`, acceptedAt);
  // Pick up the country selected at signup and clear the temporary key.
  const pendingCountry = localStorage.getItem("psych_pending_country") ?? null;
  if (pendingCountry) localStorage.removeItem("psych_pending_country");
  const pendingMci = localStorage.getItem("psych_pending_mci") ?? null;
  if (pendingMci) localStorage.removeItem("psych_pending_mci");
  // Best-effort Supabase save — silently ignored if columns don't exist yet.
  try {
    // Also persist the email so admins can identify doctors in the dashboard.
    const { data: { user } } = await supabase.auth.getUser();
    const userEmail = user?.email ?? null;
    await supabase.from("doctors").upsert({
      id,
      privacy_accepted_at: acceptedAt,
      ...(pendingCountry ? { data_region: pendingCountry } : {}),
      ...(pendingMci ? { mci_number: pendingMci } : {}),
      ...(userEmail ? { email: userEmail } : {}),
      updated_at:          acceptedAt,
    }, { onConflict: "id" });
  } catch { /* columns may not exist yet — localStorage fallback is active */ }
}

export async function saveProfile(profile: DoctorProfile): Promise<void> {
  const id = await getUid();
  localStorage.setItem("psych_note_format", profile.noteFormat ?? "SOAP");
  localStorage.setItem("psych_data_retention_years", profile.dataRetentionYears ?? "never");

  // Try with all columns first (including note_format / data_region / data_retention_years added in migrations).
  const { error: err1 } = await supabase.from("doctors").upsert({
    id,
    name:                 profile.name,
    specialty:            profile.specialty,
    clinic:               profile.clinic,
    contact:              profile.contact ?? "",
    data_region:          profile.dataRegion ?? "India",
    note_format:          profile.noteFormat ?? "SOAP",
    data_retention_years: profile.dataRetentionYears ?? "never",
    updated_at:           new Date().toISOString(),
  }, { onConflict: "id" });

  if (!err1) return; // success

  // Fall back to core columns only (older schema without note_format / data_region).
  const { error: err2 } = await supabase.from("doctors").upsert({
    id,
    name:         profile.name,
    specialty:    profile.specialty,
    clinic:       profile.clinic,
    contact:      profile.contact ?? "",
    updated_at:   new Date().toISOString(),
  }, { onConflict: "id" });

  if (err2) {
    // Both attempts failed — propagate so the caller can show an error toast.
    throw new Error(err2.message ?? "Failed to save profile to database");
  }
}

export async function getPinHash(): Promise<string | null> {
  const id = await getUid();
  // Try Supabase first
  try {
    const { data } = await supabase.from("doctors").select("pin_hash").eq("id", id).maybeSingle();
    if (data?.pin_hash) {
      // Keep localStorage in sync
      localStorage.setItem(`sphota_pin_hash_${id}`, data.pin_hash);
      return data.pin_hash;
    }
  } catch { /* fall through to localStorage */ }
  // Fallback: localStorage backup (handles missing column or network issues)
  return localStorage.getItem(`sphota_pin_hash_${id}`) ?? null;
}

export async function setPinHash(hash: string): Promise<void> {
  const id = await getUid();
  // Always save to localStorage immediately so PIN works even if Supabase fails
  localStorage.setItem(`sphota_pin_hash_${id}`, hash);
  // Then try Supabase (best effort)
  try {
    const { error } = await supabase.from("doctors").upsert({
      id,
      pin_hash:   hash,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (error) console.warn("[setPinHash] Supabase upsert failed (localStorage backup active):", error.message);
  } catch (e: any) {
    console.warn("[setPinHash] Supabase threw (localStorage backup active):", e?.message);
  }
}

// ══════════════════════════════════════════════════════════════
// PATIENTS
// ══════════════════════════════════════════════════════════════

export async function getPatients(): Promise<Patient[]> {
  const id = await getUid();
  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .eq("doctor_id", id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(row => ({
    id:     row.id,
    name:   row.name,
    age:    row.age ?? 0,
    gender: row.gender ?? "Unknown",
    time:   row.time ?? "",
    status: row.status ?? "waiting",
  }));
}

export async function createPatient(p: Omit<Patient, "id">): Promise<Patient> {
  const id = await getUid();
  const { data, error } = await supabase
    .from("patients")
    .insert({ doctor_id: id, name: p.name, age: p.age, gender: p.gender, time: p.time, status: p.status })
    .select()
    .single();
  if (error) throw error;
  return { id: data.id, name: data.name, age: data.age ?? 0, gender: data.gender ?? "Unknown", time: data.time ?? "", status: data.status ?? "waiting" };
}

export async function updatePatient(patientId: number, p: Omit<Patient, "id">): Promise<void> {
  const doctorId = await getUid();
  const { error } = await supabase
    .from("patients")
    .update({ name: p.name, age: p.age, gender: p.gender, time: p.time, status: p.status })
    .eq("id", patientId)
    .eq("doctor_id", doctorId);
  if (error) throw error;
}

export async function deletePatient(patientId: number): Promise<void> {
  const doctorId = await getUid();
  await supabase.from("report_entries").delete().eq("patient_id", patientId).eq("doctor_id", doctorId);
  await supabase.from("medications").delete().eq("patient_id", patientId).eq("doctor_id", doctorId);
  const { error } = await supabase.from("patients").delete().eq("id", patientId).eq("doctor_id", doctorId);
  if (error) throw error;
}

// ══════════════════════════════════════════════════════════════
// SESSIONS (report entries)
// ══════════════════════════════════════════════════════════════

function rowToEntry(row: Record<string, unknown>): { entry: ReportEntry; patientId: number } {
  const rawText = (row.raw_text as string) ?? "";
  return {
    patientId: row.patient_id as number,
    entry: {
      id:                     row.id as string,
      date:                   row.date as string,
      transcript:             (row.transcript as string) ?? "",
      rawText:                rawText || undefined,
      editedHtml:             (row.edited_html as string) || undefined,
      editedAt:               (row.edited_at as string) || undefined,
      reviewConfirmedAt:      (row.review_confirmed_at as string) || undefined,
      notes:                  (row.notes as string) ?? "",
      flagged:                (row.flagged as boolean) ?? false,
      patientDocMd:           (row.patient_doc_md as string) || undefined,
      patientDocHindiMd:      (row.patient_doc_hindi_md as string) || undefined,
      patientDocMarathiMd:    (row.patient_doc_marathi_md as string) || undefined,
      patientDocBengaliMd:    (row.patient_doc_bengali_md as string) || undefined,
      patientDocTamilMd:      (row.patient_doc_tamil_md as string) || undefined,
      patientDocTeluguMd:     (row.patient_doc_telugu_md as string) || undefined,
      patientDocEditedHtmlEn: (row.patient_doc_edited_html_en as string) || undefined,
      patientDocEditedHtmlHi: (row.patient_doc_edited_html_hi as string) || undefined,
      scaleScores: (() => {
        const j = row.scale_scores_json as string;
        if (!j) return undefined;
        try { return JSON.parse(j); } catch { return undefined; }
      })(),
      collateralTranscript: (row.collateral_transcript as string) || undefined,
      report: { sections: [], diagnosis: "", plan: [] },
    },
  };
}

export async function getSessions(): Promise<{ patientId: number; entry: ReportEntry }[]> {
  const id = await getUid();
  const { data, error } = await supabase
    .from("report_entries")
    .select("*")
    .eq("doctor_id", id);
  if (error) throw error;
  return (data ?? []).map(row => rowToEntry(row as Record<string, unknown>));
}

export async function createSession(patientId: number, entry: Partial<ReportEntry> & { date: string }): Promise<ReportEntry> {
  const doctorId = await getUid();
  const { data, error } = await supabase
    .from("report_entries")
    .insert({
      doctor_id:   doctorId,
      patient_id:  patientId,
      date:        entry.date,
      transcript:  entry.transcript ?? "",
      raw_text:    entry.rawText ?? "",
      edited_html: entry.editedHtml,
      edited_at:   entry.editedAt,
      notes:       entry.notes ?? "",
      flagged:     entry.flagged ?? false,
      patient_doc_md:           entry.patientDocMd,
      patient_doc_hindi_md:     entry.patientDocHindiMd,
      patient_doc_marathi_md:   entry.patientDocMarathiMd,
      patient_doc_bengali_md:   entry.patientDocBengaliMd,
      patient_doc_tamil_md:     entry.patientDocTamilMd,
      patient_doc_telugu_md:    entry.patientDocTeluguMd,
      patient_doc_edited_html_en: entry.patientDocEditedHtmlEn,
      patient_doc_edited_html_hi: entry.patientDocEditedHtmlHi,
      collateral_transcript: entry.collateralTranscript,
    })
    .select()
    .single();
  if (error) throw error;
  return rowToEntry(data as Record<string, unknown>).entry;
}

export async function updateSession(entryId: string, update: Partial<ReportEntry>): Promise<void> {
  const doctorId = await getUid();

  // Build the patch with ONLY the fields that are explicitly present in `update`.
  // Supabase treats `undefined` values as NULL and will overwrite existing DB
  // columns with NULL for every key that isn't being updated.  We must therefore
  // omit undefined keys entirely so that unrelated columns are left untouched.
  const patch: Record<string, unknown> = {};
  if (update.transcript          !== undefined) patch.transcript           = update.transcript;
  if (update.rawText             !== undefined) patch.raw_text             = update.rawText;
  if (update.editedHtml          !== undefined) patch.edited_html          = update.editedHtml;
  if (update.editedAt            !== undefined) patch.edited_at            = update.editedAt;
  if (update.reviewConfirmedAt   !== undefined) patch.review_confirmed_at  = update.reviewConfirmedAt;
  if (update.notes               !== undefined) patch.notes                = update.notes;
  if (update.flagged             !== undefined) patch.flagged              = update.flagged;
  if (update.patientDocMd        !== undefined) patch.patient_doc_md             = update.patientDocMd;
  if (update.patientDocHindiMd   !== undefined) patch.patient_doc_hindi_md       = update.patientDocHindiMd;
  if (update.patientDocMarathiMd !== undefined) patch.patient_doc_marathi_md     = update.patientDocMarathiMd;
  if (update.patientDocBengaliMd !== undefined) patch.patient_doc_bengali_md     = update.patientDocBengaliMd;
  if (update.patientDocTamilMd   !== undefined) patch.patient_doc_tamil_md       = update.patientDocTamilMd;
  if (update.patientDocTeluguMd  !== undefined) patch.patient_doc_telugu_md      = update.patientDocTeluguMd;
  if (update.patientDocEditedHtmlEn !== undefined) patch.patient_doc_edited_html_en = update.patientDocEditedHtmlEn;
  if (update.patientDocEditedHtmlHi !== undefined) patch.patient_doc_edited_html_hi = update.patientDocEditedHtmlHi;
  if (update.scaleScores         !== undefined) patch.scale_scores_json    = JSON.stringify(update.scaleScores);
  if (update.collateralTranscript !== undefined) patch.collateral_transcript = update.collateralTranscript;

  if (Object.keys(patch).length === 0) return; // nothing to update

  const { error } = await supabase
    .from("report_entries")
    .update(patch)
    .eq("id", entryId)
    .eq("doctor_id", doctorId);
  if (error) throw error;
}

export async function deleteSession(entryId: string): Promise<void> {
  const doctorId = await getUid();
  const { error } = await supabase
    .from("report_entries")
    .delete()
    .eq("id", entryId)
    .eq("doctor_id", doctorId);
  if (error) throw error;
}

// ══════════════════════════════════════════════════════════════
// APPOINTMENTS
// ══════════════════════════════════════════════════════════════

export async function getAppointments(): Promise<Appointment[]> {
  const id = await getUid();
  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("doctor_id", id);
  // If the table doesn't exist yet (migration not run), return empty gracefully
  if (error) {
    console.warn("getAppointments:", error.message, "— run Supabase migration to enable cloud sync");
    return [];
  }
  return (data ?? []).map(row => ({
    id:        row.id        as string,
    patientId: row.patient_id as number,
    date:      row.date      as string,
    time:      row.time      as string,
    notes:     (row.notes    as string) ?? "",
  }));
}

export async function saveAppointment(appt: Appointment): Promise<void> {
  const doctorId = await getUid();
  const { error } = await supabase.from("appointments").upsert({
    id:         appt.id,
    doctor_id:  doctorId,
    patient_id: appt.patientId,
    date:       appt.date,
    time:       appt.time,
    notes:      appt.notes,
  }, { onConflict: "id" });
  if (error) throw error;
}

export async function deleteAppointmentFromDb(id: string): Promise<void> {
  const doctorId = await getUid();
  const { error } = await supabase
    .from("appointments")
    .delete()
    .eq("id", id)
    .eq("doctor_id", doctorId);
  if (error) throw error;
}

// ══════════════════════════════════════════════════════════════
// MEDICATIONS
// ══════════════════════════════════════════════════════════════

export async function getAllMedications(): Promise<Record<number, PatientMedRecord>> {
  const id = await getUid();
  const { data, error } = await supabase.from("medications").select("*").eq("doctor_id", id);
  if (error) throw error;
  const map: Record<number, PatientMedRecord> = {};
  for (const row of data ?? []) {
    map[row.patient_id] = row.data as PatientMedRecord;
  }
  return map;
}

export async function saveMedications(patientId: number, data: PatientMedRecord): Promise<void> {
  const doctorId = await getUid();

  // Attempt 1: upsert (requires unique constraint on doctor_id,patient_id)
  const { error: upsertError } = await supabase.from("medications").upsert(
    { doctor_id: doctorId, patient_id: patientId, data, updated_at: new Date().toISOString() },
    { onConflict: "doctor_id,patient_id" }
  );

  if (!upsertError) return; // success

  // Attempt 2: delete-then-insert fallback (works even without the unique index)
  try {
    await supabase.from("medications")
      .delete()
      .eq("doctor_id", doctorId)
      .eq("patient_id", patientId);

    const { error: insertError } = await supabase.from("medications").insert(
      { doctor_id: doctorId, patient_id: patientId, data, updated_at: new Date().toISOString() }
    );

    if (insertError) throw insertError;
  } catch {
    // Both methods failed — throw original upsert error
    throw upsertError;
  }
}

// ══════════════════════════════════════════════════════════════
// ACCOUNT DELETION (DPDP Act — right to erasure)
// ══════════════════════════════════════════════════════════════

export async function deleteAccount(): Promise<void> {
  const uid = await getUid();

  // 1. Delete all data rows for this doctor directly via Supabase
  // Order matters: children before parents
  const { data: patRows } = await supabase
    .from("patients")
    .select("id")
    .eq("doctor_id", uid);

  const patIds = (patRows ?? []).map((r: Record<string, unknown>) => r.id as number);
  if (patIds.length > 0) {
    await supabase.from("report_entries").delete().eq("doctor_id", uid);
    await supabase.from("medications").delete().eq("doctor_id", uid);
  }
  await supabase.from("appointments").delete().eq("doctor_id", uid);
  await supabase.from("patients").delete().eq("doctor_id", uid);
  await supabase.from("doctors").delete().eq("id", uid);

  // 2. Clear local data
  localStorage.removeItem("psych_appointments");
  localStorage.removeItem("psych_autolock_mins");

  // 3. Delete auth user via server-side API (requires service role — cannot be done client-side)
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? "";
    if (token) {
      await fetch("/api/delete-account", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } catch {
    // Best-effort — data rows already deleted above
  }

  // 4. Sign out
  await supabase.auth.signOut();
}

// ══════════════════════════════════════════════════════════════
// BACKUP / RESTORE
// ══════════════════════════════════════════════════════════════

export async function exportBackup() {
  const doctorId = await getUid();
  const [profileRes, patientsRes, sessionsRes, medsRes] = await Promise.all([
    supabase.from("doctors").select("*").eq("id", doctorId).maybeSingle(),
    supabase.from("patients").select("*").eq("doctor_id", doctorId),
    supabase.from("report_entries").select("*").eq("doctor_id", doctorId),
    supabase.from("medications").select("*").eq("doctor_id", doctorId),
  ]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    doctor:   profileRes.data ?? null,
    patients: patientsRes.data ?? [],
    sessions: sessionsRes.data ?? [],
    medications: medsRes.data ?? [],
  };
}

export async function importBackup(backup: {
  doctor?: Record<string, unknown> | null;
  patients?: Record<string, unknown>[];
  sessions?: Record<string, unknown>[];
  medications?: Record<string, unknown>[];
}) {
  const doctorId = await getUid();
  const pats = backup.patients ?? [];
  const sess = backup.sessions ?? [];
  const meds = backup.medications ?? [];

  // Delete existing data
  const existingPats = await supabase.from("patients").select("id").eq("doctor_id", doctorId);
  for (const p of existingPats.data ?? []) {
    await supabase.from("report_entries").delete().eq("patient_id", p.id).eq("doctor_id", doctorId);
    await supabase.from("medications").delete().eq("patient_id", p.id).eq("doctor_id", doctorId);
  }
  await supabase.from("patients").delete().eq("doctor_id", doctorId);

  // Restore doctor profile
  if (backup.doctor) {
    const d = backup.doctor;
    await supabase.from("doctors").upsert({
      id: doctorId,
      name: d.name ?? "", specialty: d.specialty ?? "", clinic: d.clinic ?? "",
      contact: d.contact ?? "",
    }, { onConflict: "id" });
  }

  // Restore patients, remapping IDs
  const idMap: Record<number, number> = {};
  for (const p of pats) {
    const { data } = await supabase.from("patients")
      .insert({ doctor_id: doctorId, name: p.name, age: p.age, gender: p.gender, time: p.time ?? "", status: p.status ?? "waiting" })
      .select("id").single();
    if (data) idMap[p.id as number] = data.id;
  }

  for (const s of sess) {
    const newPatientId = idMap[s.patient_id as number];
    if (!newPatientId) continue;
    await supabase.from("report_entries").insert({
      doctor_id:  doctorId,
      patient_id: newPatientId,
      date:        s.date,
      transcript:  s.transcript,
      raw_text:    s.raw_text,
      edited_html: s.edited_html,
      edited_at:   s.edited_at,
      notes:       s.notes,
      flagged:     s.flagged,
      patient_doc_md:             s.patient_doc_md,
      patient_doc_hindi_md:       s.patient_doc_hindi_md,
      patient_doc_marathi_md:     s.patient_doc_marathi_md,
      patient_doc_bengali_md:     s.patient_doc_bengali_md,
      patient_doc_tamil_md:       s.patient_doc_tamil_md,
      patient_doc_telugu_md:      s.patient_doc_telugu_md,
      patient_doc_edited_html_en: s.patient_doc_edited_html_en,
      patient_doc_edited_html_hi: s.patient_doc_edited_html_hi,
      scale_scores_json:          s.scale_scores_json,
    });
  }

  for (const m of meds) {
    const newPatientId = idMap[m.patient_id as number];
    if (!newPatientId) continue;
    await supabase.from("medications").upsert(
      { doctor_id: doctorId, patient_id: newPatientId, data: m.data },
      { onConflict: "doctor_id,patient_id" }
    );
  }

  return { patientsRestored: pats.length };
}
