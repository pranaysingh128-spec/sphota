import { useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ScanModalProps {
  onClose: () => void;
  onCopyToNotes: (summary: string) => void;
  onGenerateReport?: (summary: string) => void;
  patientName?: string;
  patientAge?: string;
  patientGender?: string;
  authToken?: string;
}

export default function ScanModal({
  onClose,
  onCopyToNotes,
  onGenerateReport,
  patientName,
  patientAge,
  patientGender,
  authToken,
}: ScanModalProps) {
  const [scanning, setScanning]     = useState(false);
  const [summary,  setSummary]      = useState<string | null>(null);
  const [error,    setError]        = useState<string | null>(null);
  const [copied,   setCopied]       = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function triggerFilePicker() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setSummary(null);
    setCopied(false);
    setScanning(true);

    try {
      const formData = new FormData();
      formData.append("image", file);
      if (patientName)   formData.append("patientName",   patientName);
      if (patientAge)    formData.append("patientAge",    patientAge);
      if (patientGender) formData.append("patientGender", patientGender);

      const headers: Record<string, string> = {};
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

      const res = await fetch("/api/ai/scan", {
        method: "POST",
        headers,
        body: formData,
      });

      const data = await res.json() as { summary?: string; message?: string };

      if (!res.ok || !data.summary) {
        throw new Error(data.message ?? "Document scanning failed. Please try again.");
      }

      setSummary(data.summary);
    } catch (err: any) {
      setError(err?.message ?? "Document scanning unavailable. Please try again later.");
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleCopyToNotes() {
    if (!summary) return;
    onCopyToNotes(summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleGenerateReport() {
    if (!summary || !onGenerateReport) return;
    onGenerateReport(summary);
  }

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ zIndex: 1100 }}
    >
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 620, width: "min(620px, 95vw)", maxHeight: "min(85vh, calc(100dvh - 80px))", display: "flex", flexDirection: "column" }}
      >
        {/* Header */}
        <div className="modal-header" style={{ flexShrink: 0 }}>
          <h3 className="modal-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ color: "var(--accent, #10b981)", flexShrink: 0 }}
            >
              <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
              <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
              <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
              <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
              <line x1="7" y1="12" x2="17" y2="12"/>
            </svg>
            Scanned Document Summary
          </h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />

          {/* Scanning state */}
          {scanning && (
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 14, padding: "40px 20px",
              flex: 1,
            }}>
              <div className="spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>Scanning document…</p>
            </div>
          )}

          {/* Error state */}
          {!scanning && error && (
            <div style={{
              background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 10, padding: "14px 16px", color: "#f87171", fontSize: 13,
              lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}

          {/* Idle state — no summary yet */}
          {!scanning && !summary && !error && (
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 16, padding: "36px 20px", flex: 1,
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: "50%",
                background: "color-mix(in srgb, var(--accent, #10b981) 12%, transparent)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
                  stroke="var(--accent, #10b981)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                  <path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                  <line x1="7" y1="12" x2="17" y2="12"/>
                </svg>
              </div>
              <div style={{ textAlign: "center" }}>
                <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>
                  Photograph a paper patient file
                </p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, maxWidth: 320 }}>
                  Take a photo or upload an image of a handwritten note, prescription,
                  discharge summary, or any clinical document.
                </p>
              </div>
              <button
                onClick={triggerFilePicker}
                className="modal-save"
                style={{ padding: "10px 24px", fontSize: 14 }}
              >
                Open Camera / File Picker
              </button>
            </div>
          )}

          {/* Result */}
          {!scanning && summary && (
            <>
              <div style={{
                background: "var(--bg-card, #1a1a1d)", border: "1px solid var(--border)",
                borderRadius: 10, padding: "16px 18px", flex: 1, overflowY: "auto",
                fontSize: 13, lineHeight: 1.7,
              }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {summary}
                </ReactMarkdown>
              </div>

              {/* Action row */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
                {/* Primary: Generate Report */}
                {onGenerateReport && (
                  <button
                    onClick={handleGenerateReport}
                    className="modal-save"
                    style={{ width: "100%", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path d="M9 12h6M9 16h6M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    Generate Clinical Report from Scan
                  </button>
                )}
                {/* Secondary row */}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={triggerFilePicker}
                    className="modal-cancel"
                    style={{ flex: 1, fontSize: 13 }}
                    title="Scan another document"
                  >
                    Scan Another
                  </button>
                  <button
                    onClick={handleCopyToNotes}
                    className="modal-cancel"
                    style={{ flex: 2, fontSize: 13 }}
                    title="Add this scan summary to the session transcript area"
                  >
                    {copied ? "✓ Added to Transcript" : "Add to Transcript"}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* After error — retry button */}
          {!scanning && error && (
            <button
              onClick={triggerFilePicker}
              className="modal-save"
              style={{ alignSelf: "center", padding: "10px 24px", fontSize: 14 }}
            >
              Try Again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
