import { useState } from "react";
import type { PatientMedRecord } from "./types";
import { checkInteractions, checkAllergyConflict } from "./interactions";
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

interface Props {
  record: PatientMedRecord | null;
  onManage: () => void;
  onPrintRx?: () => void;
}

export default function MedCard({ record, onManage, onPrintRx }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [moaOpen, setMoaOpen] = useState<Record<string, boolean>>({});
  const [moaData, setMoaData] = useState<Record<string, { text: string; loading: boolean; error: boolean }>>({});

  const active = record?.medications.filter(m => m.status === "active") ?? [];
  const allergies = record?.allergies ?? [];
  const activeNames = active.map(m => m.name);
  const interactions = checkInteractions(activeNames);
  const allergyConflicts = checkAllergyConflict(activeNames, allergies);
  const dangerCount = interactions.filter(i => i.severity === "danger").length + allergyConflicts.length;
  const warnCount  = interactions.filter(i => i.severity === "warning").length;

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

  return (
    <div className={`med-card ${collapsed ? "collapsed" : ""}`}>
      <div className="med-card-header" onClick={() => setCollapsed(c => !c)}>
        <div className="med-card-header-left">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="2"/>
            <path d="M9 12h6M12 9v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <span className="med-card-title">Medications &amp; Allergies</span>
          <span className="med-card-count">{active.length} active</span>
          {dangerCount > 0 && (
            <span className="med-flag danger-flag">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13" stroke="white" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="white" strokeWidth="2" strokeLinecap="round"/></svg>
              {dangerCount}
            </span>
          )}
          {warnCount > 0 && dangerCount === 0 && (
            <span className="med-flag warn-flag">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13" stroke="white" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="white" strokeWidth="2" strokeLinecap="round"/></svg>
              {warnCount}
            </span>
          )}
        </div>
        <div className="med-card-header-right">
          {onPrintRx && (
            <button
              className="med-manage-btn"
              onClick={e => { e.stopPropagation(); onPrintRx(); }}
              title="Print prescription slip"
              style={{ marginRight: 4 }}
            >
              Print Rx
            </button>
          )}
          <button
            className="med-manage-btn"
            onClick={e => { e.stopPropagation(); onManage(); }}
            title="Manage medications"
          >
            Manage
          </button>
          <svg className="med-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      {!collapsed && (
        <div className="med-card-body">
          {allergies.length > 0 && (
            <div className="med-allergy-row">
              <span className="med-allergy-label">ALLERGIES</span>
              {allergies.map((a, i) => (
                <span key={i} className="med-allergy-chip">{a}</span>
              ))}
            </div>
          )}

          {allergyConflicts.map((msg, i) => (
            <div key={i} className="med-interaction danger">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
              {msg}
            </div>
          ))}
          {interactions.map((ix, i) => (
            <div key={i} className={`med-interaction ${ix.severity}`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
              <span>
                <strong>INTERACTION WARNING:</strong>{" "}
                {ix.drugs[0]} + {ix.drugs[1]} — {ix.detail} Verify before prescribing.
              </span>
            </div>
          ))}

          {active.length === 0 ? (
            <div className="med-empty">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" opacity=".4"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="1.5"/><path d="M9 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              No medications on record
            </div>
          ) : (
            <div className="med-list">
              {active.map(med => {
                const moaKey = med.name.toLowerCase().trim();
                const moa = moaData[moaKey];
                const isOpen = moaOpen[moaKey];
                return (
                  <div key={med.id}>
                    <div className="med-row">
                      <div className="med-row-name" style={{ color: "#4ade80" }}>{med.name}</div>
                      <div className="med-row-meta">
                        {med.dose && <span className="med-pill dose">{med.dose}</span>}
                        {med.frequency && <span className="med-pill freq">{med.frequency}</span>}
                        {med.startDate && (
                          <span className="med-pill since">
                            since {new Date(med.startDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                          </span>
                        )}
                        <button
                          onClick={e => { e.stopPropagation(); void fetchMoa(med.name); }}
                          title="Drug info"
                          style={{
                            minWidth: 44, minHeight: 44, width: 44, height: 44,
                            borderRadius: "50%", border: "1px solid rgba(20,184,166,0.4)",
                            color: "#14b8a6", background: "transparent", cursor: "pointer",
                            fontSize: 10, fontWeight: 700, display: "inline-flex",
                            alignItems: "center", justifyContent: "center", flexShrink: 0,
                            marginLeft: 4, padding: 0,
                          }}
                        >ℹ</button>
                      </div>
                    </div>
                    {isOpen && (
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
                          <span style={{ color: "#f87171" }}>Could not load. Tap ℹ to retry.</span>
                        )}
                        {moa?.text && !moa.loading && (
                          <div style={{ whiteSpace: "pre-wrap" }}>{moa.text}</div>
                        )}
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
  );
}
