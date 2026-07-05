import React, { useState, useEffect } from "react";
import type { Patient, DoctorProfile } from "./types";

const ANNOTATION_STYLES: Record<string, { label: string; bg: string; color: string; border: string }> = {
  "pause":       { label: "pause",       bg: "rgba(99,102,241,0.12)",  color: "#a5b4fc", border: "rgba(99,102,241,0.30)"  },
  "long pause":  { label: "long pause",  bg: "rgba(139,92,246,0.12)",  color: "#c4b5fd", border: "rgba(139,92,246,0.30)"  },
  "laughs":      { label: "laughs",      bg: "rgba(245,158,11,0.12)",  color: "#fcd34d", border: "rgba(245,158,11,0.30)"  },
  "sighs":       { label: "sighs",       bg: "rgba(20,184,166,0.12)",  color: "#5eead4", border: "rgba(20,184,166,0.30)"  },
  "voice break": { label: "voice break", bg: "rgba(239,68,68,0.12)",   color: "#fca5a5", border: "rgba(239,68,68,0.30)"   },
  "quietly":     { label: "quietly",     bg: "rgba(148,163,184,0.12)", color: "#cbd5e1", border: "rgba(148,163,184,0.30)" },
  "crying":      { label: "crying",      bg: "rgba(59,130,246,0.12)",  color: "#93c5fd", border: "rgba(59,130,246,0.30)"  },
};

function renderAnnotatedText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\[(pause|long pause|laughs|sighs|voice break|quietly|crying)\]/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(<span key={idx++}>{text.slice(last, match.index)}</span>);
    const key = match[1].toLowerCase();
    const style = ANNOTATION_STYLES[key];
    if (style) {
      parts.push(
        <span key={idx++} className={`tl-ann tl-ann--${key.replace(" ", "-")}`}
          style={{ background: style.bg, color: style.color, border: `1px solid ${style.border}`,
            borderRadius: 4, padding: "0px 5px", fontSize: "0.82em", fontWeight: 600,
            margin: "0 2px", display: "inline-block", verticalAlign: "middle", lineHeight: "1.5" }}>
          {style.label}
        </span>
      );
    } else {
      parts.push(<span key={idx++}>{match[0]}</span>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(<span key={idx++}>{text.slice(last)}</span>);
  return parts;
}

interface TranscriptPanelProps {
  transcriptOpen: boolean;
  setTranscriptOpen: (fn: (prev: boolean) => boolean) => void;
  remoteRecording: boolean;
  selectedPatient: Patient | null;
  recording: boolean;
  transcribing: boolean;
  elapsed: number;
  audioLevel: number;
  silentFrames: number;
  fmtTime: (s: number) => string;
  toggleRecording: () => void;
  cancelRecording: () => void;
  cancelTranscription: () => void;
  activeEntryId: string | null;
  liveConnected: boolean;
  setScanModalOpen: (v?: boolean) => void;
  transcript: string;
  setTranscript: (t: string) => void;
  transcriptView: "view" | "edit";
  setTranscriptView: (v: "view" | "edit") => void;
  doctor: DoctorProfile;
  draftBanner: boolean;
  setDraftBanner: (v: boolean) => void;
  collateralTranscript: string;
  setCollateralTranscript: (t: string) => void;
  collateralRecording: boolean;
  collateralTranscribing: boolean;
  collateralElapsed: number;
  collateralAudioLevel: number;
  collateralSilentFrames: number;
  toggleCollateralRecording: () => void;
  cancelCollateralRecording: () => void;
  cancelCollateralTranscription: () => void;
}

export default function TranscriptPanel({
  transcriptOpen, setTranscriptOpen, remoteRecording, selectedPatient,
  recording, transcribing, elapsed, audioLevel, silentFrames, fmtTime, toggleRecording,
  cancelRecording, cancelTranscription,
  activeEntryId, liveConnected, setScanModalOpen, transcript, setTranscript,
  transcriptView, setTranscriptView, doctor, draftBanner, setDraftBanner,
  collateralTranscript, setCollateralTranscript, collateralRecording, collateralTranscribing,
  collateralElapsed, collateralAudioLevel, collateralSilentFrames,
  toggleCollateralRecording, cancelCollateralRecording, cancelCollateralTranscription,
}: TranscriptPanelProps) {
  const [transcriptTab, setTranscriptTab] = useState<"patient" | "collateral">("patient");
  const [collateralView, setCollateralView] = useState<"view" | "edit">("edit");

  useEffect(() => {
    if (!collateralTranscribing && collateralTranscript.trim()) {
      setCollateralView("view");
    }
  }, [collateralTranscribing]);

  return (
    <aside className={`transcript-panel ${transcriptOpen ? "open" : "closed"}`}>
      <button className="transcript-header-bar" onClick={() => setTranscriptOpen(o => !o)} title={transcriptOpen ? "Collapse transcript" : "Expand transcript"}>
        <svg className="transcript-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
          style={{ transform: transcriptOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
          <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {transcriptOpen && (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <span>Session Transcript</span>
          </>
        )}
      </button>

      {transcriptOpen && (
        <div className="transcript-body">
          {remoteRecording && (
            <div className="remote-recording-banner">
              🎙 Recording in progress on another device…
            </div>
          )}
          {/* ── Mobile-only recording hero ── */}
          <div className="mobile-rec-section">
            {!selectedPatient ? (
              <div className="mobile-rec-no-patient">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" opacity=".3"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" stroke="currentColor" strokeWidth="1.5"/></svg>
                <p>Select a patient first to start recording</p>
              </div>
            ) : recording ? (
              <div className="mobile-rec-active">
                <div className="mobile-rec-top">
                  <span className="rec-dot" />
                  <span className="rec-label">REC</span>
                  <span className="mobile-rec-timer">{fmtTime(elapsed)}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, height: 32, margin: "4px 0 2px" }}>
                  {[0.5, 0.8, 0.6, 1, 0.7, 0.9, 0.55, 0.75, 0.85, 0.65, 0.9, 0.7].map((scale, i) => {
                    const active = audioLevel > 0.03;
                    const h = active ? Math.max(4, audioLevel * 28 * scale) : 4;
                    return (
                      <div key={i} style={{
                        width: 3, height: `${h}px`, borderRadius: 2,
                        background: active ? "#10b981" : "#334155",
                        transition: "height 0.07s ease, background 0.25s ease",
                        flexShrink: 0,
                      }} />
                    );
                  })}
                </div>
                {silentFrames > 60 && elapsed >= 4 && (
                  <p style={{ fontSize: 11, color: "#f87171", textAlign: "center", margin: "0 0 4px", letterSpacing: "0.02em" }}>
                    ⚠ No audio detected — check microphone
                  </p>
                )}
                <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center" }}>
                  <button className="mic-stop-btn" onClick={toggleRecording} title="Stop & transcribe">
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
                  </button>
                  <button className="rec-cancel-btn" onClick={cancelRecording} title="Cancel recording">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                    Cancel
                  </button>
                </div>
                <p className="rec-hint">Stop to transcribe · Cancel to discard</p>
              </div>
            ) : transcribing && !recording ? (
              <div className="mobile-rec-idle">
                <div className="mobile-mic-btn mobile-mic-btn--transcribing">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" className="mic-spinner"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                </div>
                <div className="mobile-rec-label-group">
                  <span className="mobile-rec-label">Transcribing…</span>
                  <span className="mobile-rec-sub">Please wait</span>
                </div>
                <button className="rec-cancel-btn" onClick={cancelTranscription} style={{ marginTop: 8 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="mobile-rec-idle" onClick={toggleRecording} style={{ cursor: "pointer" }}>
                <div className="mobile-mic-btn">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="9" y="2" width="6" height="13" rx="3" stroke="currentColor" strokeWidth="2"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3M9 22h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                </div>
                <div className="mobile-rec-label-group">
                  <span className="mobile-rec-label">Tap to start recording</span>
                  <span className="mobile-rec-sub">{fmtTime(elapsed)} · Ready</span>
                </div>
              </div>
            )}
          </div>

          {/* ── Tabs bar: Scan Doc + Patient Transcription + Collateral ── */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "8px 10px 6px 14px", flexShrink: 0,
            borderBottom: "1px solid rgba(255,255,255,0.07)",
          }}>
            <button
              className="scan-doc-btn"
              onClick={() => setScanModalOpen()}
              title="Scan paper document"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
                <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
                <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                <line x1="7" y1="12" x2="17" y2="12"/>
              </svg>
              Scan Doc
            </button>

            <div style={{
              display: "flex", flex: 1, gap: 3,
              background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: 3,
            }}>
              <button
                style={{
                  flex: 1, padding: "5px 6px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
                  background: transcriptTab === "patient" ? "rgba(59,130,246,0.25)" : "transparent",
                  color: transcriptTab === "patient" ? "#93c5fd" : "var(--text-muted)",
                  transition: "background 0.15s, color 0.15s",
                }}
                onClick={() => { setTranscriptTab("patient"); setTranscriptView("edit"); }}
                title="Patient session transcript"
              >
                Patient
              </button>
              <button
                style={{
                  flex: 1, padding: "5px 6px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
                  background: transcriptTab === "collateral" ? "rgba(99,102,241,0.25)" : "transparent",
                  color: transcriptTab === "collateral" ? "#a5b4fc" : "var(--text-muted)",
                  transition: "background 0.15s, color 0.15s",
                }}
                onClick={() => setTranscriptTab("collateral")}
                title="Family / collateral interview"
              >
                Collateral
              </button>
            </div>
          </div>

          {/* ── Patient Transcription Tab ── */}
          {transcriptTab === "patient" && (
            <>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "6px 10px 4px 14px", flexShrink: 0,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <p className="transcript-hint">Paste transcript or use mic</p>
                  {activeEntryId && liveConnected && (
                    <div className="live-indicator">
                      <span className="live-dot" />
                      Live
                    </div>
                  )}
                </div>
                <div className="transcript-view-toggle">
                  <button className={`tvt-btn ${transcriptView === "view" ? "active" : ""}`} onClick={() => setTranscriptView("view")} title="Formatted view">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/></svg>
                    View
                  </button>
                  <button className={`tvt-btn ${transcriptView === "edit" ? "active" : ""}`} onClick={() => setTranscriptView("edit")} title="Edit raw text">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    Edit
                  </button>
                </div>
              </div>

              {transcriptView === "view" && transcript.trim() ? (
                <div className="transcript-rendered">
                  <div className="tl-legend">
                    {Object.entries(ANNOTATION_STYLES).map(([key, s]) => (
                      <span key={key} className="tl-legend-item"
                        style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}`,
                          borderRadius: 4, padding: "1px 6px", fontSize: "0.78em", fontWeight: 600 }}>
                        {s.label}
                      </span>
                    ))}
                  </div>
                  {transcript.split("\n").map((line, i) => {
                    const trimmed = line.trim();
                    if (!trimmed) return <div key={i} className="tl-gap" />;
                    const uncertain = trimmed.endsWith("[?]");
                    const clean = uncertain ? trimmed.slice(0, -3).trim() : trimmed;
                    // Extract optional [MM:SS] timestamp prefix
                    let timestamp: string | null = null;
                    let lineBody = clean;
                    const tsMatch = clean.match(/^\[(\d{1,2}:\d{2})\]\s*/);
                    if (tsMatch) { timestamp = tsMatch[1]; lineBody = clean.slice(tsMatch[0].length); }
                    const colonIdx = lineBody.indexOf(":");
                    if (colonIdx > 0 && colonIdx < 40) {
                      const speaker = lineBody.slice(0, colonIdx).trim();
                      const text = lineBody.slice(colonIdx + 1).trim();
                      const doctorLabel = doctor.name || "Doctor";
                      const speakerLower = speaker.toLowerCase();
                      const isDoctor =
                        speakerLower.includes(doctorLabel.toLowerCase().split(" ").pop() ?? "doctor") ||
                        speakerLower.includes("dr.") ||
                        speakerLower === "doctor";
                      return (
                        <div key={i} className={`tl-line ${isDoctor ? "tl-line--doctor" : "tl-line--patient"} ${uncertain ? "tl-line--uncertain" : ""}`}>
                          <div className="tl-line-header">
                            <span className={`tl-speaker ${isDoctor ? "tl-speaker--doctor" : "tl-speaker--patient"}`}>{speaker}</span>
                            {timestamp && <span className="tl-timestamp">{timestamp}</span>}
                          </div>
                          <span className="tl-text">{renderAnnotatedText(text)}</span>
                          {uncertain && (
                            <span className="tl-uncertain-badge" title="Speaker uncertain — click Edit to correct">
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              Uncertain
                            </span>
                          )}
                        </div>
                      );
                    }
                    return (
                      <div key={i} className={`tl-line tl-line--plain ${uncertain ? "tl-line--uncertain" : ""}`}>
                        <span className="tl-text">{renderAnnotatedText(lineBody)}</span>
                        {uncertain && (
                          <span className="tl-uncertain-badge" title="Speaker uncertain">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            Uncertain
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <>
                  {draftBanner && (
                    <div style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#f59e0b", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, margin: "0 14px 6px" }}>
                      <span>Draft restored from your last session.</span>
                      <button onClick={() => setDraftBanner(false)} style={{ background: "none", border: "none", color: "#f59e0b", cursor: "pointer", fontSize: 14, padding: "0 0 0 8px", minWidth: 44, minHeight: 44 }}>×</button>
                    </div>
                  )}
                  <textarea
                    className="transcript-textarea"
                    placeholder={"Paste session transcript here...\n\nFormat example:\nDoctor: How have you been feeling?\nPatient: Not well, I've been having trouble sleeping..."}
                    value={transcript}
                    onChange={e => setTranscript(e.target.value)}
                  />
                  <div style={{
                    background: "rgba(30,200,160,0.06)",
                    border: "1px solid rgba(30,200,160,0.15)",
                    borderRadius: 8,
                    padding: "8px 12px",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    margin: "6px 14px 0",
                    lineHeight: 1.5,
                  }}>
                    💡 <strong style={{ color: "var(--accent)" }}>Tip:</strong> After the session, briefly describe patient appearance, affect, and behaviour out loud — e.g. <em>"Patient appeared well kempt, affect was blunted, eye contact poor."</em> This will be included in the Objective section of the report.
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Collateral / Family Interview Tab ── */}
          {transcriptTab === "collateral" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>

              {/* Header + recording controls */}
              <div style={{ flexShrink: 0, padding: "10px 14px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Family / Collateral Interview
                  </span>
                </div>

                {selectedPatient && (
                  <div>
                    {collateralRecording ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="rec-dot" />
                        <span style={{ fontSize: 12, color: "#f87171" }}>REC {fmtTime(collateralElapsed)}</span>
                        <div style={{ display: "flex", gap: 3, height: 24, alignItems: "center" }}>
                          {[0.5, 0.8, 0.6, 1, 0.7, 0.9, 0.55].map((scale, i) => {
                            const active = collateralAudioLevel > 0.03;
                            const h = active ? Math.max(3, collateralAudioLevel * 20 * scale) : 3;
                            return <div key={i} style={{ width: 2.5, height: `${h}px`, borderRadius: 2, background: active ? "#10b981" : "#334155", transition: "height 0.07s ease" }} />;
                          })}
                        </div>
                        <button className="mic-stop-btn" onClick={toggleCollateralRecording} title="Stop & transcribe" style={{ transform: "scale(0.85)" }}>
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
                        </button>
                        <button className="rec-cancel-btn" onClick={cancelCollateralRecording}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                          Cancel
                        </button>
                        {collateralSilentFrames > 60 && collateralElapsed >= 4 && (
                          <span style={{ fontSize: 11, color: "#f87171" }}>⚠ No audio</span>
                        )}
                      </div>
                    ) : collateralTranscribing ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="mic-spinner"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Transcribing family interview…</span>
                        <button className="rec-cancel-btn" onClick={cancelCollateralTranscription} style={{ marginLeft: 4 }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={toggleCollateralRecording}
                        style={{
                          display: "flex", alignItems: "center", gap: 6,
                          background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.25)",
                          borderRadius: 7, padding: "6px 12px", fontSize: 12, color: "#a5b4fc",
                          cursor: "pointer", fontWeight: 500,
                        }}
                        title="Record family/informant interview separately"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                          <rect x="9" y="2" width="6" height="13" rx="3" stroke="currentColor" strokeWidth="2"/>
                          <path d="M5 10a7 7 0 0 0 14 0M12 19v3M9 22h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                        </svg>
                        {collateralTranscript.trim() ? "Re-record" : "Record family interview"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* View / Edit toggle — mirrors patient tab */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "2px 14px 4px", flexShrink: 0 }}>
                <div className="transcript-view-toggle">
                  <button
                    className={`tvt-btn ${collateralView === "view" ? "active" : ""}`}
                    onClick={() => setCollateralView("view")}
                    title="Formatted view"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/></svg>
                    View
                  </button>
                  <button
                    className={`tvt-btn ${collateralView === "edit" ? "active" : ""}`}
                    onClick={() => setCollateralView("edit")}
                    title="Edit raw text"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    Edit
                  </button>
                </div>
              </div>

              {/* Rendered speaker view */}
              {collateralView === "view" && collateralTranscript.trim() ? (
                <div className="transcript-rendered">
                  {collateralTranscript.split("\n").map((line, i) => {
                    const trimmed = line.trim();
                    if (!trimmed) return <div key={i} className="tl-gap" />;
                    // Extract optional [MM:SS] timestamp prefix
                    let tsC: string | null = null;
                    let bodyC = trimmed;
                    const tsMC = trimmed.match(/^\[(\d{1,2}:\d{2})\]\s*/);
                    if (tsMC) { tsC = tsMC[1]; bodyC = trimmed.slice(tsMC[0].length); }
                    const colonIdx = bodyC.indexOf(":");
                    if (colonIdx > 0 && colonIdx < 40) {
                      const speaker = bodyC.slice(0, colonIdx).trim();
                      const text = bodyC.slice(colonIdx + 1).trim();
                      const doctorLabel = doctor.name || "Doctor";
                      const speakerLc = speaker.toLowerCase();
                      const isDoctor =
                        speakerLc.includes(doctorLabel.toLowerCase().split(" ").pop() ?? "doctor") ||
                        speakerLc.includes("dr.") ||
                        speakerLc === "doctor";
                      return (
                        <div key={i} className={`tl-line ${isDoctor ? "tl-line--doctor" : "tl-line--patient"}`}>
                          <div className="tl-line-header">
                            <span className={`tl-speaker ${isDoctor ? "tl-speaker--doctor" : "tl-speaker--patient"}`}>{speaker}</span>
                            {tsC && <span className="tl-timestamp">{tsC}</span>}
                          </div>
                          <span className="tl-text">{renderAnnotatedText(text)}</span>
                        </div>
                      );
                    }
                    return (
                      <div key={i} className="tl-line tl-line--plain">
                        <span className="tl-text">{renderAnnotatedText(bodyC)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <textarea
                  className="transcript-textarea"
                  placeholder={"Family/informant interview transcript…\n\nFormat:\nDoctor: What have you noticed at home?\nFamily: He has been spending recklessly and sleeping only 2 hours…"}
                  value={collateralTranscript}
                  onChange={e => { setCollateralTranscript(e.target.value); }}
                />
              )}

              {/* Tip strip pinned at the bottom */}
              <div style={{
                flexShrink: 0,
                background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.15)",
                borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "var(--text-muted)",
                lineHeight: 1.5, margin: "0 14px 12px",
              }}>
                💡 <strong style={{ color: "#a5b4fc" }}>Collateral history</strong> — recorded separately after the patient leaves. Appears as a distinct section in the report, clearly attributed to the family/informant. Contradictions between accounts are flagged automatically.
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
