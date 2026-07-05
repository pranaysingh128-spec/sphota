import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import DOMPurify from "dompurify";
import { marked } from "marked";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import type { DoctorProfile, DocLang, Medication } from "./types";

const LANG_OPTIONS: { value: DocLang; label: string; nativeLabel: string }[] = [
  { value: "en", label: "English",  nativeLabel: "EN" },
  { value: "hi", label: "Hindi",    nativeLabel: "हिं" },
  { value: "mr", label: "Marathi",  nativeLabel: "मरा" },
  { value: "bn", label: "Bengali",  nativeLabel: "বাং" },
  { value: "ta", label: "Tamil",    nativeLabel: "தமி" },
  { value: "te", label: "Telugu",   nativeLabel: "తెలు" },
];

const LETTER_BADGE: Partial<Record<DocLang, string>> = {
  hi: "रोगी पत्र",
  mr: "रुग्ण पत्र",
  bn: "রোগী পত্র",
  ta: "நோயாளி கடிதம்",
  te: "రోగి లేఖ",
};

const LANG_LABELS: Record<DocLang, { medicines: string; doctor: string; date: string; signature: string; duration: string }> = {
  en: { medicines: "Your Medicines",        doctor: "Doctor",         date: "Date",    signature: "Doctor's Signature", duration: "Duration" },
  hi: { medicines: "आपकी दवाइयाँ",          doctor: "डॉक्टर",         date: "तारीख",   signature: "डॉक्टर का हस्ताक्षर", duration: "अवधि" },
  mr: { medicines: "तुमच्या औषधी",          doctor: "डॉक्टर",         date: "तारीख",   signature: "डॉक्टरांची सही",      duration: "कालावधी" },
  bn: { medicines: "আপনার ওষুধ",            doctor: "ডাক্তার",        date: "তারিখ",   signature: "ডাক্তারের স্বাক্ষর",   duration: "সময়কাল" },
  ta: { medicines: "உங்கள் மருந்துகள்",     doctor: "மருத்துவர்",    date: "தேதி",    signature: "மருத்துவரின் கையொப்பம்", duration: "காலம்" },
  te: { medicines: "మీ మందులు",            doctor: "డాక్టర్",        date: "తేదీ",    signature: "డాక్టర్ సంతకం",        duration: "వ్యవధి" },
};

interface PatientDocumentProps {
  patientName: string;
  date: string;
  doctor: DoctorProfile;
  lang: DocLang;
  onSetLang: (lang: DocLang) => void;
  loading?: boolean;
  translationLoading?: boolean;
  mdByLang: Partial<Record<DocLang, string>>;
  editedHtmlByLang: Partial<Record<DocLang, string>>;
  sessionMeds?: Medication[];
  onPrintRx?: () => void;
  onPrintIndividualRx?: (med: Medication) => void;
  onSaveEdits: (html: string, lang: DocLang) => void;
  onRegenerate?: () => void;
}

function formatDateSimple(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

function htmlToPlainText(html: string) {
  const tmp = document.createElement("div");
  tmp.innerHTML = DOMPurify.sanitize(html);
  return (tmp.textContent || tmp.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
}

function mdToPlainText(md: string) {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^[-•]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function LangSelector({ lang, onSetLang, translationLoading }: {
  lang: DocLang;
  onSetLang: (lang: DocLang) => void;
  translationLoading?: boolean;
}) {
  return (
    <div className="lang-select-wrap">
      <select
        className="lang-select"
        value={lang}
        onChange={e => onSetLang(e.target.value as DocLang)}
        disabled={translationLoading}
        title="Select language"
      >
        {LANG_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.nativeLabel} {opt.label}</option>
        ))}
      </select>
      {translationLoading && <span className="lang-spinner lang-spinner-inline" />}
    </div>
  );
}

function formatMedDuration(med: Medication): string {
  const fmt = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  if (med.startDate && med.endDate) return `${fmt(med.startDate)} – ${fmt(med.endDate)}`;
  if (med.startDate) return `From ${fmt(med.startDate)}`;
  return "";
}

export default function PatientDocument({
  patientName, date, doctor, lang, onSetLang, loading, translationLoading,
  mdByLang, editedHtmlByLang, sessionMeds = [], onPrintRx, onPrintIndividualRx, onSaveEdits, onRegenerate,
}: PatientDocumentProps) {
  const [editMode, setEditMode] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const currentMd = mdByLang[lang];
  const currentEditedHtml = editedHtmlByLang[lang];

  function getDisplayHtml(): string {
    if (currentEditedHtml) return currentEditedHtml;
    if (currentMd) return marked.parse(currentMd) as string;
    return "";
  }

  function shareWhatsApp() {
    const body = currentEditedHtml
      ? htmlToPlainText(currentEditedHtml)
      : currentMd ? mdToPlainText(currentMd) : "";
    const contactLine = doctor.contact ? `\nContact: ${doctor.contact}` : "";
    const badge = LETTER_BADGE[lang] ?? "Patient Letter";
    const header = lang === "en"
      ? `Patient Summary — ${patientName}\nDate: ${formatDateSimple(date)}\n${doctor.name}${doctor.clinic ? ` | ${doctor.clinic}` : ""}${contactLine}\n\n`
      : `${badge} — ${patientName}\n${formatDateSimple(date)}\n${doctor.name}${doctor.clinic ? ` | ${doctor.clinic}` : ""}${contactLine}\n\n`;
    window.open(`https://wa.me/?text=${encodeURIComponent(header + body)}`, "_blank");
  }

  function fileBase() {
    const suffix = lang === "en" ? "" : `-${lang}`;
    return `patient-letter-${patientName.replace(/\s+/g, "-")}-${date.slice(0, 10)}${suffix}`;
  }

  const PRINT_STYLE = `
    @page{margin:18mm;}
    body{font-family:Calibri,sans-serif;font-size:11pt;color:#111;line-height:1.65;margin:0;}
    h2{color:#0d5c3a;font-size:12pt;margin-top:18pt;border-bottom:1px solid #e0e0e0;padding-bottom:4pt;}
    strong{color:#0d5c3a;}
    ul{margin-left:16px;padding-left:0;}
    li{margin-bottom:4pt;}
    .pd-header{border-bottom:1px solid #ccc;padding-bottom:10pt;margin-bottom:14pt;}
    .pd-header-doc-row{font-size:10pt;color:#555;display:flex;gap:8px;align-items:center;margin-bottom:4pt;}
    .pd-header-doc-name{font-weight:600;color:#111;}
    .pd-header-doc-meta{color:#666;}
    .pd-patient-name{font-size:14pt;font-weight:700;color:#111;}
    .pd-patient-date{font-size:9.5pt;color:#666;margin-top:2pt;}
    .pd-letter-badge{display:none;}
    .pd-content p,.pd-content li{color:#111;}
    .pd-footer{border-top:1px solid #ddd;padding-top:8pt;margin-top:20pt;font-size:9pt;color:#666;}
    .pd-medicines-section{margin-top:20pt;border-top:2px solid #111;padding-top:12pt;}
    .pd-medicines-header{font-size:12pt;font-weight:700;color:#111;margin-bottom:8pt;}
    .pd-medicines-header-local{font-size:10pt;font-weight:400;color:#555;}
    .pd-medicines-table{width:100%;border-collapse:collapse;margin-bottom:10pt;}
    .pd-med-row{border-bottom:1px solid #eee;}
    .pd-med-row td{padding:5pt 6pt;font-size:10.5pt;vertical-align:top;}
    .pd-med-name{font-weight:600;color:#111;}
    .pd-med-dose,.pd-med-freq{color:#444;}
    .pd-med-dur{color:#666;font-size:9.5pt;}
    .pd-med-rx-btn-cell,.pd-med-rx-btn{display:none;}
    .pd-medicines-meta{display:flex;gap:24pt;font-size:10pt;color:#333;margin-bottom:10pt;}
    .pd-sig-stamp-row{display:flex;gap:36pt;margin-top:44pt;align-items:flex-end;}
    .pd-sig-col{flex:1;}
    .pd-sig-space{height:46pt;}
    .pd-sig-rule{border-top:1.5px solid #111;width:100%;}
    .pd-sig-label{font-size:9.5pt;color:#555;margin-top:4pt;}
    .pd-stamp-col{flex:0 0 110pt;text-align:center;}
    .pd-stamp-box{border:1px dashed #aaa;height:70pt;width:100%;border-radius:4pt;margin-bottom:4pt;}
    .pd-stamp-label{font-size:9.5pt;color:#555;}
  `;

  function exportPatientPdf() {
    const el = document.querySelector<HTMLElement>(".patient-doc-pdf-wrap");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Patient Letter — ${patientName}</title><style>${PRINT_STYLE}</style></head><body>${el.innerHTML}<script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  async function exportPatientImage() {
    const el = document.querySelector<HTMLElement>(".patient-doc-pdf-wrap");
    if (!el) return;
    const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${fileBase()}.png`;
    a.click();
  }

  function exportPatientWord() {
    const el = document.querySelector<HTMLElement>(".patient-doc-pdf-wrap");
    if (!el) return;
    const header = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><style>${PRINT_STYLE}</style></head><body>`;
    const blob = new Blob([header + el.innerHTML + `</body></html>`], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileBase()}.doc`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function printPatientDoc() {
    const el = document.querySelector<HTMLElement>(".patient-doc-pdf-wrap");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Patient Letter — ${patientName}</title><style>${PRINT_STYLE}</style></head><body>${el.innerHTML}<script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  if (loading) {
    return (
      <div className="empty-state">
        <div className="spinner" />
        <p className="empty-title">Generating patient letter…</p>
        <p className="empty-sub">Creating a plain-language summary for the patient</p>
      </div>
    );
  }

  if (lang !== "en" && translationLoading) {
    const langOpt = LANG_OPTIONS.find(o => o.value === lang);
    return (
      <div className="pd-lang-loading-wrap">
        <div className="pd-toolbar">
          <div className="pd-toolbar-left">
            <LangSelector lang={lang} onSetLang={onSetLang} translationLoading={translationLoading} />
          </div>
        </div>
        <div className="empty-state">
          <div className="spinner" />
          <p className="empty-title">Generating {langOpt?.label ?? lang} translation…</p>
          <p className="empty-sub">Converting patient letter to {langOpt?.label ?? lang}</p>
        </div>
      </div>
    );
  }

  if (!currentMd && !currentEditedHtml) {
    if (loading) {
      return (
        <div className="empty-state">
          <div className="spinner" />
          <p className="empty-title">Generating patient letter…</p>
          <p className="empty-sub">Creating a plain-language summary for the patient</p>
        </div>
      );
    }
    return null;
  }

  if (editMode) {
    return (
      <PatientDocEditor
        initialHtml={getDisplayHtml()}
        lang={lang}
        onSetLang={onSetLang}
        translationLoading={translationLoading}
        onSave={(html) => { onSaveEdits(html, lang); setEditMode(false); }}
        onDiscard={() => setEditMode(false)}
      />
    );
  }

  return (
    <div className="patient-doc-outer">
      <div className="pd-toolbar">
        <div className="pd-toolbar-left">
          <LangSelector lang={lang} onSetLang={onSetLang} translationLoading={translationLoading} />
          {currentEditedHtml && (
            <span className="pd-edited-badge">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
              </svg>
              Edited
            </span>
          )}
        </div>
        <div className="pd-toolbar-right">
          {(lang === "en" || lang === "hi") && (
            <button className="pd-action-btn" onClick={() => setEditMode(true)} title="Edit patient letter">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              Edit
            </button>
          )}
          {onRegenerate && (
            <button className="pd-action-btn" onClick={onRegenerate} title="Regenerate patient letter using AI">
              ↻ Regenerate
            </button>
          )}
          {onPrintRx && sessionMeds.length > 0 && (
            <button className="pd-action-btn" onClick={onPrintRx} title="Print prescription slip">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <rect x="6" y="14" width="12" height="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Print Rx
            </button>
          )}
          <button className="pd-action-btn pd-whatsapp-btn" onClick={shareWhatsApp} title="Share via WhatsApp">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>
            </svg>
            WhatsApp
          </button>
          <div className="export-dropdown-wrap">
            <button
              className="export-icon-btn"
              title="Export / Print"
              onClick={() => setExportMenuOpen(v => !v)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            {exportMenuOpen && (
              <>
                <div className="export-overlay" onClick={() => setExportMenuOpen(false)} />
                <div className="export-menu">
                  <button className="export-menu-item" onClick={() => { printPatientDoc(); setExportMenuOpen(false); }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><polyline points="6 9 6 2 18 2 18 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><rect x="6" y="14" width="12" height="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Print
                  </button>
                  <button className="export-menu-item" onClick={() => { exportPatientPdf(); setExportMenuOpen(false); }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    PDF
                  </button>
                  <button className="export-menu-item" onClick={() => { exportPatientWord(); setExportMenuOpen(false); }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Word
                  </button>
                  <button className="export-menu-item" onClick={() => { exportPatientImage(); setExportMenuOpen(false); }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="2"/><polyline points="21 15 16 10 5 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Image
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="patient-doc-pdf-wrap">
        <div className="pd-header">
          <div className="pd-header-doc-row">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 2a5 5 0 1 0 0 10A5 5 0 0 0 12 2zM4 20a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span className="pd-header-doc-name">{doctor.name}</span>
            {doctor.specialty && <span className="pd-header-doc-meta">· {doctor.specialty}</span>}
            {doctor.clinic && <span className="pd-header-doc-meta">| {doctor.clinic}</span>}
          </div>
          <div className="pd-header-patient-row">
            <div>
              <div className="pd-patient-name">{patientName}</div>
              <div className="pd-patient-date">{formatDateSimple(date)}</div>
            </div>
            <div className="pd-letter-badge">
              {LETTER_BADGE[lang] ?? "Patient Letter"}
            </div>
          </div>
        </div>

        <div className="pd-body">
          {currentEditedHtml
            ? <div className="pd-content" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(currentEditedHtml) }} />
            : <div className="pd-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{currentMd ?? ""}</ReactMarkdown></div>
          }
        </div>

        {/* ── Medicines section (only if meds saved in tracker) ── */}
        {sessionMeds.length > 0 && (() => {
          const L = LANG_LABELS[lang];
          const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
          return (
            <div className="pd-medicines-section">
              <div className="pd-medicines-header">
                Your Medicines{lang !== "en" && <span className="pd-medicines-header-local"> / {L.medicines}</span>}
              </div>
              <table className="pd-medicines-table">
                <tbody>
                  {sessionMeds.map(med => {
                    const dur = formatMedDuration(med);
                    return (
                      <tr key={med.id} className="pd-med-row">
                        <td className="pd-med-name">{med.name}</td>
                        <td className="pd-med-dose">{med.dose}</td>
                        <td className="pd-med-freq">{med.frequency}</td>
                        {dur && <td className="pd-med-dur">{L.duration}: {dur}</td>}
                        {onPrintIndividualRx && (
                          <td className="pd-med-rx-btn-cell">
                            <button
                              className="pd-med-rx-btn"
                              title={`Print Rx for ${med.name}`}
                              onClick={() => onPrintIndividualRx(med)}
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                                <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                <rect x="6" y="14" width="12" height="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                              Rx
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="pd-medicines-meta">
                <span><strong>{L.doctor}:</strong> {doctor.name}</span>
                <span><strong>{L.date}:</strong> {today}</span>
              </div>
            </div>
          );
        })()}

        {/* ── Signature & stamp — always shown ── */}
        <div className="pd-sig-stamp-row">
          <div className="pd-sig-col">
            <div className="pd-sig-space" />
            <div className="pd-sig-rule" />
            <div className="pd-sig-label">
              {doctor.name ? `${doctor.name}${doctor.specialty ? ` · ${doctor.specialty}` : ""}` : LANG_LABELS[lang].signature}
            </div>
          </div>
          <div className="pd-stamp-col">
            <div className="pd-sig-space" style={{ height: "38pt" }} />
            <div className="pd-sig-rule" />
            <div className="pd-sig-label">Doctor's Signature</div>
          </div>
          <div className="pd-stamp-col">
            <div className="pd-stamp-box" />
            <div className="pd-stamp-label">Doctor's Stamp</div>
          </div>
        </div>

        <div className="pd-footer">
          <div className="pd-footer-line" />
          <div className="pd-footer-text">
            {doctor.name}{doctor.specialty ? ` · ${doctor.specialty}` : ""}{doctor.clinic ? ` | ${doctor.clinic}` : ""}
            {doctor.contact && <span className="pd-footer-contact"> · 📞 {doctor.contact}</span>}
            {lang === "en" && <span className="pd-footer-disclaimer"> · This summary is for informational purposes only.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function PatientDocEditor({
  initialHtml, lang, onSetLang, translationLoading, onSave, onDiscard,
}: {
  initialHtml: string;
  lang: DocLang;
  onSetLang: (lang: DocLang) => void;
  translationLoading?: boolean;
  onSave: (html: string) => void;
  onDiscard: () => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [currentHtml, setCurrentHtml] = useState(initialHtml);

  const editor = useEditor({
    extensions: [StarterKit],
    content: initialHtml,
    onUpdate: ({ editor }) => {
      setCurrentHtml(editor.getHTML());
      setDirty(true);
    },
  });

  if (!editor) return null;

  const tb = (active: boolean, onClick: () => void, title: string, icon: React.ReactNode) => (
    <button
      className={`editor-toolbar-btn ${active ? "active" : ""}`}
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
    >{icon}</button>
  );

  return (
    <div className="report-editor">
      <div className="editor-toolbar">
        <div className="editor-toolbar-left">
          {tb(editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "Bold",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          )}
          {tb(editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "Italic",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><line x1="19" y1="4" x2="10" y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="14" y1="20" x2="5" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="15" y1="4" x2="9" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          )}
          <div className="editor-toolbar-sep" />
          {tb(editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), "Bullet list",
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><line x1="9" y1="6" x2="20" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="9" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="9" y1="18" x2="20" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/></svg>
          )}
          <div className="editor-toolbar-sep" />
          <LangSelector lang={lang} onSetLang={onSetLang} translationLoading={translationLoading} />
        </div>
        <div className="editor-toolbar-right">
          <button className="editor-discard-btn" onClick={onDiscard}>Discard</button>
          <button className={`editor-save-btn ${dirty ? "ready" : ""}`} onClick={() => onSave(currentHtml)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="17 21 17 13 7 13 7 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="7 3 7 8 15 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Save
          </button>
        </div>
      </div>
      <div className="report-wrap editor-content-wrap">
        <EditorContent editor={editor} className="editor-content" />
      </div>
    </div>
  );
}
