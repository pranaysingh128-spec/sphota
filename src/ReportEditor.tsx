import { useRef, useState, useEffect } from "react";
import DOMPurify from "dompurify";

interface ReportEditorProps {
  initialHtml: string;
  onChange: (html: string) => void;
  onSave: (html: string) => void;
  onDiscard: () => void;
}

export default function ReportEditor({ initialHtml, onSave, onDiscard }: ReportEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [dirty, setDirty] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);

  // Set initial content once on mount
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = DOMPurify.sanitize(initialHtml);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleInput() {
    setDirty(true);
  }

  function getHtml() {
    return editorRef.current?.innerHTML ?? initialHtml;
  }

  function execCmd(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    editorRef.current?.focus();
    setDirty(true);
  }

  function isActive(tag: string) {
    try {
      return document.queryCommandState(tag);
    } catch {
      return false;
    }
  }

  const btn = (
    active: boolean,
    onClick: () => void,
    title: string,
    children: React.ReactNode
  ) => (
    <button
      className={`editor-toolbar-btn ${active ? "active" : ""}`}
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
    >
      {children}
    </button>
  );

  return (
    <div className="report-editor">
      <div className="editor-toolbar">
        <div className="editor-toolbar-left">
          {btn(isActive("bold"), () => execCmd("bold"), "Bold",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          )}
          {btn(isActive("italic"), () => execCmd("italic"), "Italic",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><line x1="19" y1="4" x2="10" y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="14" y1="20" x2="5" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="15" y1="4" x2="9" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          )}
          {btn(isActive("underline"), () => execCmd("underline"), "Underline",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 3v7a6 6 0 0 0 12 0V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="4" y1="21" x2="20" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          )}
          <div className="editor-toolbar-sep" />
          {btn(false, () => execCmd("formatBlock", "h2"), "Heading",
            <span style={{ fontSize: 11, fontWeight: 700 }}>H2</span>
          )}
          {btn(false, () => execCmd("formatBlock", "h3"), "Sub-heading",
            <span style={{ fontSize: 11, fontWeight: 700 }}>H3</span>
          )}
          {btn(false, () => execCmd("formatBlock", "p"), "Paragraph",
            <span style={{ fontSize: 11, fontWeight: 700 }}>¶</span>
          )}
          <div className="editor-toolbar-sep" />
          {btn(isActive("insertUnorderedList"), () => execCmd("insertUnorderedList"), "Bullet list",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><line x1="9" y1="6" x2="20" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="9" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="9" y1="18" x2="20" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/></svg>
          )}
          {btn(isActive("insertOrderedList"), () => execCmd("insertOrderedList"), "Numbered list",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><line x1="10" y1="6" x2="21" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="10" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="10" y1="18" x2="21" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M4 6h1v4M4 10h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M4 15h1.5a.5.5 0 0 1 0 1H4.5a.5.5 0 0 0 0 1H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          )}
          <div className="editor-toolbar-sep" />
          {btn(false, () => execCmd("undo"), "Undo",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 7v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M3 13C5.5 8.5 10 6 15 6a9 9 0 0 1 6 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          )}
          {btn(false, () => execCmd("redo"), "Redo",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 7v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M21 13C18.5 8.5 14 6 9 6a9 9 0 0 0-6 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          )}
        </div>
        <div className="editor-toolbar-right">
          <button className="editor-discard-btn" onClick={onDiscard} title="Discard changes">
            Discard
          </button>
          <button
            className={`editor-save-btn ${dirty && reviewed ? "ready" : ""}`}
            onClick={() => {
              if (reviewed) {
                onSave(getHtml());
              } else {
                setSaveAttempted(true);
                // Scroll checkbox into view
                const checkbox = editorRef.current?.closest(".report-wrap")?.querySelector("label");
                checkbox?.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            }}
            title={reviewed ? "Save edits" : "Tick the review checkbox below first"}
            style={!reviewed ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="17 21 17 13 7 13 7 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="7 3 7 8 15 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Save Edits
          </button>
        </div>
      </div>
      {saveAttempted && !reviewed && (
        <div style={{
          background: "rgba(239,68,68,0.12)",
          border: "1px solid rgba(239,68,68,0.35)",
          borderRadius: 7,
          padding: "7px 14px",
          marginTop: 6,
          fontSize: 12,
          color: "#fca5a5",
          textAlign: "center",
        }}>
          ⚠️ Please tick the clinical review checkbox below before saving.
        </div>
      )}

      <div className="report-wrap editor-content-wrap">
        {/* ICMR AI Ethics Guideline — mandatory disclosure for AI-assisted clinical tools */}
        <div style={{
          background: "rgba(234, 179, 8, 0.08)",
          border: "1px solid rgba(234, 179, 8, 0.25)",
          borderRadius: 8,
          padding: "9px 14px",
          marginBottom: 12,
          fontSize: 12,
          color: "#b45309",
          lineHeight: 1.5,
        }}>
          <strong>Smart draft</strong> — This report was generated with smart assistance and must be
          reviewed and verified by the treating clinician before use in patient care or records.
        </div>
        <div
          ref={editorRef}
          className="editor-content"
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          style={{ outline: "none", minHeight: 200 }}
        />
        <label style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          marginTop: 14,
          padding: "10px 14px",
          background: saveAttempted && !reviewed ? "rgba(239,68,68,0.08)" : "rgba(20,184,166,0.06)",
          border: saveAttempted && !reviewed ? "1px solid rgba(239,68,68,0.35)" : "1px solid rgba(20,184,166,0.2)",
          borderRadius: 8,
          fontSize: 12.5,
          color: "#cbd5e1",
          cursor: "pointer",
          lineHeight: 1.5,
        }}>
          <input
            type="checkbox"
            checked={reviewed}
            onChange={e => { setReviewed(e.target.checked); if (e.target.checked) setSaveAttempted(false); }}
            style={{ marginTop: 2, width: 15, height: 15, accentColor: "#14b8a6", cursor: "pointer", flexShrink: 0 }}
          />
          <span>
            I have reviewed this system-generated report, verified its accuracy, and take full clinical responsibility for its contents.
          </span>
        </label>
      </div>
    </div>
  );
}
