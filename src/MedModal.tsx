import { useState, useEffect } from "react";
import type { Medication, PatientMedRecord, MedDraft } from "./types";
import { checkInteractions } from "./interactions";
import { correctDrugName } from "./drugSpellcheck";
import { supabase } from "./supabase";

async function getAuthToken(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  } catch { return ""; }
}

const MOA_SYSTEM_PROMPT =
  "You are a psychiatry pharmacology reference. For the given medication provide a brief clinical summary in exactly this format:\n" +
  "Class: [drug class]\n" +
  "MOA: [mechanism in max 15 words]\n" +
  "Psychiatric use: [primary indication, max 10 words]\n" +
  "Onset: [clinical onset timeframe]\n" +
  "Key note: [one important clinical pearl, max 15 words]\n" +
  "Keep total under 60 words.\n" +
  "If the drug name appears misspelled, infer the correct medication and provide info for the correct drug. " +
  "If you corrected the spelling, start with \"Corrected: [correct name]\" on its own line.";

async function fetchMoaFromApi(drugName: string, enteredAs?: string): Promise<string> {
  const token = await getAuthToken();
  const userContent = enteredAs && enteredAs !== drugName
    ? `Drug: ${drugName} (entered as: ${enteredAs})`
    : `Drug: ${drugName}`;

  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      messages: [
        { role: "system", content: MOA_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      taskType: "utility",
    }),
  });

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const err = await res.json() as { message?: string };
      if (err.message) msg = err.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  // API streams SSE — read chunks and assemble full result
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const event = JSON.parse(jsonStr) as { chunk?: string; done?: boolean; result?: string; error?: string };
        if (event.error) throw new Error(event.error);
        if (event.chunk) result += event.chunk;
        if (event.done && event.result) result = event.result;
      } catch (e: any) {
        if (e?.message && !e.message.startsWith("Unexpected token")) throw e;
      }
    }
  }

  if (!result.trim()) throw new Error("Empty response from server");
  return result.trim();
}

type ModalMode = "review" | "manage";
type ManageTab = "active" | "discontinued" | "allergies";

interface Props {
  mode: ModalMode;
  patientName: string;
  record: PatientMedRecord;
  prescribedBy: string;
  sessionId?: string;
  drafts?: MedDraft[];
  onSave: (record: PatientMedRecord) => void;
  onClose: () => void;
}

const EMPTY_MED = (): Omit<Medication, "id"> => ({
  name: "", dose: "", frequency: "",
  startDate: new Date().toISOString().slice(0, 10),
  prescribedBy: "",
  status: "active",
});

export default function MedModal({ mode, patientName, record, prescribedBy, sessionId, drafts, onSave, onClose }: Props) {
  const [tab, setTab]             = useState<ManageTab>("active");
  const [meds, setMeds]           = useState<Medication[]>(() => [...record.medications]);
  const [allergies, setAllergies] = useState<string[]>(() => [...record.allergies]);

  // ── Medicine info popover (Class / MOA / Onset / Key note) — click a
  // medicine's name to open, same lookup that used to live in the med card. ──
  const [moaOpen, setMoaOpen] = useState<Record<string, boolean>>({});
  const [moaData, setMoaData] = useState<Record<string, { text: string; loading: boolean; error: boolean }>>({});

  async function fetchMoa(drugName: string) {
    const key = drugName.toLowerCase().trim();
    const cacheKey = `psych_moa_${key}`;

    if (moaData[key]?.text) {
      setMoaOpen(prev => ({ ...prev, [key]: !prev[key] }));
      return;
    }

    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      setMoaData(prev => ({ ...prev, [key]: { text: cached, loading: false, error: false } }));
      setMoaOpen(prev => ({ ...prev, [key]: true }));
      return;
    }

    setMoaData(prev => ({ ...prev, [key]: { text: "", loading: true, error: false } }));
    setMoaOpen(prev => ({ ...prev, [key]: true }));

    const { corrected, wasCorrected } = correctDrugName(drugName);
    const lookupName = wasCorrected ? corrected : drugName;

    const load = async (attempt: number): Promise<string> => {
      try {
        return await fetchMoaFromApi(lookupName, wasCorrected ? drugName : undefined);
      } catch (err) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 800 * attempt));
          return load(attempt + 1);
        }
        throw err;
      }
    };

    try {
      const result = await load(1);
      localStorage.setItem(cacheKey, result);
      setMoaData(prev => ({ ...prev, [key]: { text: result, loading: false, error: false } }));
    } catch {
      setMoaData(prev => ({ ...prev, [key]: { text: "", loading: false, error: true } }));
    }
  }

  function MedInfoPanel({ drugName }: { drugName: string }) {
    const key = drugName.toLowerCase().trim();
    const moa = moaData[key];
    if (!moaOpen[key]) return null;
    return (
      <div style={{
        padding: "8px 10px 10px 10px",
        background: "rgba(20,184,166,0.05)",
        borderTop: "1px solid rgba(20,184,166,0.15)",
        fontSize: 12, lineHeight: 1.7,
        color: "var(--text-muted, #8898aa)",
      }}>
        {moa?.loading && (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="spinner" style={{ width: 14, height: 14 }} />
            Loading...
          </span>
        )}
        {moa?.error && !moa.loading && (
          <span style={{ color: "#f87171" }}>Could not load. Click the name to retry.</span>
        )}
        {moa?.text && !moa.loading && (
          <div style={{ whiteSpace: "pre-wrap" }}>{moa.text}</div>
        )}
      </div>
    );
  }

  // Review mode state
  const [reviewRows, setReviewRows] = useState<MedDraft[]>(() =>
    drafts?.length ? drafts.map(d => ({ ...d, include: true })) : [{ name: "", dose: "", frequency: "", include: true }]
  );

  // Manage mode: add-new form
  const [addOpen, setAddOpen]     = useState(false);
  const [addDraft, setAddDraft]   = useState<Omit<Medication,"id">>(EMPTY_MED());

  // Discontinue form
  const [discId, setDiscId]       = useState<string | null>(null);
  const [discReason, setDiscReason] = useState("");

  // Allergy input
  const [allergyInput, setAllergyInput] = useState("");

  // Edit form
  const [editId, setEditId]       = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Medication | null>(null);

  useEffect(() => {
    setAddDraft(d => ({ ...d, prescribedBy }));
  }, [prescribedBy]);

  // ── Review mode save ──────────────────────────────────────────
  function saveReview() {
    const toAdd = reviewRows
      .filter(r => r.include && r.name.trim())
      .map(r => ({
        id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: r.name.trim(),
        dose: r.dose.trim(),
        frequency: r.frequency.trim(),
        startDate: new Date().toISOString().slice(0, 10),
        prescribedBy,
        sessionId,
        status: "active" as const,
      }));
    const merged = dedup([...toAdd, ...meds]);
    onSave({ medications: merged, allergies });
  }

  function dedup(list: Medication[]): Medication[] {
    const seen = new Set<string>();
    return list.filter(m => {
      const k = m.name.toLowerCase().trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ── Manage mode actions ───────────────────────────────────────
  function addMed() {
    if (!addDraft.name.trim()) return;
    const next: Medication = { ...addDraft, id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, status: "active" };
    setMeds(prev => dedup([next, ...prev]));
    setAddDraft(EMPTY_MED());
    setAddOpen(false);
  }

  function confirmDisc(id: string) {
    setMeds(prev => prev.map(m =>
      m.id === id ? { ...m, status: "discontinued", endDate: new Date().toISOString().slice(0, 10), discontinuedReason: discReason.trim() || "Discontinued" } : m
    ));
    setDiscId(null); setDiscReason("");
  }

  function deleteMed(id: string) {
    setMeds(prev => prev.filter(m => m.id !== id));
  }

  function saveEdit() {
    if (!editDraft) return;
    setMeds(prev => prev.map(m => m.id === editDraft.id ? editDraft : m));
    setEditId(null); setEditDraft(null);
  }

  function addAllergy() {
    const trimmed = allergyInput.trim();
    if (!trimmed || allergies.map(a => a.toLowerCase()).includes(trimmed.toLowerCase())) return;
    setAllergies(prev => [...prev, trimmed]);
    setAllergyInput("");
  }

  function saveManage() {
    onSave({ medications: meds, allergies });
  }

  const activeMeds = meds.filter(m => m.status === "active");
  const discMeds   = meds.filter(m => m.status === "discontinued");
  const modalInteractions = checkInteractions(activeMeds.map(m => m.name));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal med-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="2"/>
              <path d="M9 12h6M12 9v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <h3 className="modal-title">
              {mode === "review" ? "Medications Found in Report" : `Medication History · ${patientName}`}
            </h3>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* ── REVIEW MODE ───────────────────────────────── */}
        {mode === "review" && (
          <div className="med-modal-body">
            <p className="med-modal-subtitle">
              These medications were extracted from the session. Review and confirm before adding to the patient record.
            </p>
            <div className="med-review-table">
              <div className="med-review-head">
                <span style={{ width: 24 }} />
                <span>Medication</span>
                <span>Dose</span>
                <span>Frequency</span>
                <span style={{ width: 24 }} />
              </div>
              {reviewRows.map((row, idx) => (
                <div key={idx} className="med-review-row">
                  <input
                    type="checkbox"
                    className="med-review-check"
                    checked={row.include}
                    onChange={e => setReviewRows(prev => prev.map((r, i) => i === idx ? { ...r, include: e.target.checked } : r))}
                  />
                  <input
                    className="med-input"
                    placeholder="Drug name"
                    value={row.name}
                    onChange={e => setReviewRows(prev => prev.map((r, i) => i === idx ? { ...r, name: e.target.value } : r))}
                  />
                  <input
                    className="med-input"
                    placeholder="e.g. 20mg"
                    value={row.dose}
                    onChange={e => setReviewRows(prev => prev.map((r, i) => i === idx ? { ...r, dose: e.target.value } : r))}
                  />
                  <input
                    className="med-input"
                    placeholder="e.g. Once daily"
                    value={row.frequency}
                    onChange={e => setReviewRows(prev => prev.map((r, i) => i === idx ? { ...r, frequency: e.target.value } : r))}
                  />
                  <button
                    className="med-row-del-btn"
                    onClick={() => setReviewRows(prev => prev.filter((_, i) => i !== idx))}
                    title="Remove row"
                  >✕</button>
                </div>
              ))}
              <button
                className="med-add-row-btn"
                onClick={() => setReviewRows(prev => [...prev, { name: "", dose: "", frequency: "", include: true }])}
              >
                + Add row
              </button>
            </div>

            <div className="med-allergy-section">
              <label className="med-section-label">Patient Allergies</label>
              <div className="med-allergy-chips">
                {allergies.map((a, i) => (
                  <span key={i} className="med-allergy-chip editable">
                    {a}
                    <button onClick={() => setAllergies(prev => prev.filter((_, j) => j !== i))}>×</button>
                  </span>
                ))}
                <div className="med-allergy-add">
                  <input
                    className="med-input"
                    placeholder="Add allergy…"
                    value={allergyInput}
                    onChange={e => setAllergyInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addAllergy()}
                  />
                  <button className="med-add-allergy-btn" onClick={addAllergy}>Add</button>
                </div>
              </div>
            </div>

            <div className="med-modal-footer">
              <button className="med-footer-skip" onClick={onClose}>Skip</button>
              <button className="med-footer-save" onClick={saveReview}>
                Save to Patient Record
              </button>
            </div>
          </div>
        )}

        {/* ── MANAGE MODE ───────────────────────────────── */}
        {mode === "manage" && (
          <div className="med-modal-body">
            <div className="med-tabs">
              {(["active", "discontinued", "allergies"] as ManageTab[]).map(t => (
                <button
                  key={t}
                  className={`med-tab ${tab === t ? "active" : ""}`}
                  onClick={() => setTab(t)}
                >
                  {t === "active" && `Active (${activeMeds.length})`}
                  {t === "discontinued" && `Discontinued (${discMeds.length})`}
                  {t === "allergies" && `Allergies (${allergies.length})`}
                </button>
              ))}
            </div>

            {/* Active medications */}
            {tab === "active" && (
              <div className="med-manage-panel">
                {modalInteractions.map((ix, i) => (
                  <div key={i} className="med-interaction danger">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
                    <span>
                      <strong>INTERACTION WARNING:</strong>{" "}
                      {ix.drugs[0]} + {ix.drugs[1]} — {ix.detail} Verify before prescribing.
                    </span>
                  </div>
                ))}
                {activeMeds.length === 0 && (
                  <div className="med-manage-empty">No active medications on record.</div>
                )}
                {activeMeds.map(med => (
                  <div key={med.id}>
                    {editId === med.id && editDraft ? (
                      <div className="med-edit-form">
                        <div className="med-edit-row">
                          <input className="med-input" placeholder="Drug name" value={editDraft.name} onChange={e => setEditDraft(d => d && ({ ...d, name: e.target.value }))} />
                          <input className="med-input" placeholder="Dose" value={editDraft.dose} onChange={e => setEditDraft(d => d && ({ ...d, dose: e.target.value }))} />
                          <input className="med-input" placeholder="Frequency" value={editDraft.frequency} onChange={e => setEditDraft(d => d && ({ ...d, frequency: e.target.value }))} />
                          <input className="med-input" type="date" value={editDraft.startDate} onChange={e => setEditDraft(d => d && ({ ...d, startDate: e.target.value }))} />
                        </div>
                        <div className="med-edit-row">
                          <input className="med-input" placeholder="Notes (optional)" value={editDraft.notes ?? ""} onChange={e => setEditDraft(d => d && ({ ...d, notes: e.target.value }))} style={{ flex: 3 }} />
                          <button className="med-save-edit-btn" onClick={saveEdit}>Save</button>
                          <button className="med-cancel-edit-btn" onClick={() => { setEditId(null); setEditDraft(null); }}>Cancel</button>
                        </div>
                      </div>
                    ) : discId === med.id ? (
                      <div className="med-disc-form">
                        <span className="med-disc-label">Discontinuing <strong>{med.name}</strong></span>
                        <input className="med-input" placeholder="Reason (optional)" value={discReason} onChange={e => setDiscReason(e.target.value)} />
                        <button className="med-disc-confirm-btn" onClick={() => confirmDisc(med.id)}>Confirm</button>
                        <button className="med-cancel-edit-btn" onClick={() => setDiscId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div>
                      <div className="med-manage-row">
                        <div className="med-manage-info">
                          <span
                            className="med-manage-name"
                            style={{ color: "#4ade80", cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textDecorationColor: "rgba(74,222,128,0.5)" }}
                            onClick={() => void fetchMoa(med.name)}
                            title="Click for medication info"
                          >{med.name}</span>
                          <div className="med-manage-meta">
                            {med.dose && <span className="med-pill dose">{med.dose}</span>}
                            {med.frequency && <span className="med-pill freq">{med.frequency}</span>}
                            {med.startDate && <span className="med-pill since">from {new Date(med.startDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>}
                            {med.notes && <span className="med-manage-notes">{med.notes}</span>}
                          </div>
                        </div>
                        <div className="med-manage-actions">
                          <button className="med-action-btn" onClick={() => { setEditId(med.id); setEditDraft({ ...med }); }} title="Edit">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                          </button>
                          <button className="med-action-btn warn" onClick={() => { setDiscId(med.id); setDiscReason(""); }} title="Discontinue">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M4.93 4.93l14.14 14.14" stroke="currentColor" strokeWidth="2"/></svg>
                          </button>
                          <button className="med-action-btn danger" onClick={() => deleteMed(med.id)} title="Delete">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                          </button>
                        </div>
                      </div>
                      <MedInfoPanel drugName={med.name} />
                      </div>
                    )}
                  </div>
                ))}

                {addOpen ? (
                  <div className="med-edit-form med-add-form">
                    <div className="med-edit-row">
                      <input className="med-input" placeholder="Drug name *" value={addDraft.name} onChange={e => setAddDraft(d => ({ ...d, name: e.target.value }))} />
                      <input className="med-input" placeholder="Dose" value={addDraft.dose} onChange={e => setAddDraft(d => ({ ...d, dose: e.target.value }))} />
                      <input className="med-input" placeholder="Frequency" value={addDraft.frequency} onChange={e => setAddDraft(d => ({ ...d, frequency: e.target.value }))} />
                      <input className="med-input" type="date" value={addDraft.startDate} onChange={e => setAddDraft(d => ({ ...d, startDate: e.target.value }))} />
                    </div>
                    <div className="med-edit-row">
                      <input className="med-input" placeholder="Prescribed by" value={addDraft.prescribedBy} onChange={e => setAddDraft(d => ({ ...d, prescribedBy: e.target.value }))} style={{ flex: 2 }} />
                      <input className="med-input" placeholder="Notes (optional)" value={addDraft.notes ?? ""} onChange={e => setAddDraft(d => ({ ...d, notes: e.target.value }))} style={{ flex: 2 }} />
                      <button className="med-save-edit-btn" onClick={addMed}>Add</button>
                      <button className="med-cancel-edit-btn" onClick={() => setAddOpen(false)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button className="med-add-new-btn" onClick={() => { setAddOpen(true); setAddDraft({ ...EMPTY_MED(), prescribedBy }); }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                    Add Medication
                  </button>
                )}
              </div>
            )}

            {/* Discontinued medications */}
            {tab === "discontinued" && (
              <div className="med-manage-panel">
                {discMeds.length === 0 && (
                  <div className="med-manage-empty">No discontinued medications recorded.</div>
                )}
                {discMeds.map(med => (
                  <div key={med.id}>
                  <div className="med-manage-row disc">
                    <div className="med-manage-info">
                      <span
                        className="med-manage-name disc"
                        style={{ color: "#fbbf24", textDecoration: "line-through", cursor: "pointer" }}
                        onClick={() => void fetchMoa(med.name)}
                        title="Click for medication info"
                      >{med.name}</span>
                      <div className="med-manage-meta">
                        {med.dose && <span className="med-pill dose">{med.dose}</span>}
                        {med.endDate && (
                          <span className="med-pill ended">stopped {new Date(med.endDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                        )}
                        {med.discontinuedReason && (
                          <span className="med-manage-notes">Reason: {med.discontinuedReason}</span>
                        )}
                      </div>
                    </div>
                    <button className="med-action-btn danger" onClick={() => deleteMed(med.id)} title="Remove record">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    </button>
                  </div>
                  <MedInfoPanel drugName={med.name} />
                  </div>
                ))}
              </div>
            )}

            {/* Allergies */}
            {tab === "allergies" && (
              <div className="med-manage-panel">
                <p className="med-manage-allergy-hint">
                  Document all known drug and substance allergies. These are checked against active medications automatically.
                </p>
                <div className="med-allergy-chips" style={{ marginBottom: 14 }}>
                  {allergies.length === 0 && <span className="med-manage-empty" style={{ display: "inline" }}>No allergies recorded.</span>}
                  {allergies.map((a, i) => (
                    <span key={i} className="med-allergy-chip editable" style={{ color: "#f87171" }}>
                      ⚠ {a}
                      <button onClick={() => setAllergies(prev => prev.filter((_, j) => j !== i))}>×</button>
                    </span>
                  ))}
                </div>
                <div className="med-allergy-add">
                  <input
                    className="med-input"
                    placeholder="e.g. Penicillin, Lithium, Sulfonamides…"
                    value={allergyInput}
                    onChange={e => setAllergyInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addAllergy()}
                  />
                  <button className="med-add-allergy-btn" onClick={addAllergy}>Add</button>
                </div>
              </div>
            )}

            <div className="med-modal-footer">
              <button className="med-footer-skip" onClick={onClose}>Cancel</button>
              <button className="med-footer-save" onClick={saveManage}>
                Save Changes
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
