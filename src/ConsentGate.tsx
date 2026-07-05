import { useEffect, useState, useRef } from "react";
import { supabase } from "./supabase";

const CONSENT_CACHE_KEY = "sphota_consent_given";

export default function ConsentGate({ children }: { children: React.ReactNode }) {
  // "loading"        → checking with server
  // "unauthenticated"→ no session yet; pass through to login, re-check on sign-in
  // "needed"         → user is logged in but has NOT consented → show popup
  // "given"          → user has consented → show app
  const [status, setStatus] = useState<"loading" | "unauthenticated" | "needed" | "given">(() => {
    try {
      return localStorage.getItem(CONSENT_CACHE_KEY) === "1" ? "given" : "loading";
    } catch {
      return "loading";
    }
  });

  // Once "given", never go back — prevents token-refresh events from re-triggering
  const givenRef = useRef(status === "given");
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);

  function markGiven() {
    givenRef.current = true;
    try { localStorage.setItem(CONSENT_CACHE_KEY, "1"); } catch { /* no-op */ }
    setStatus("given");
    subscriptionRef.current?.unsubscribe();
    subscriptionRef.current = null;
  }

  async function checkConsent(token: string) {
    if (givenRef.current) return;

    // No token → user isn't logged in; show login screen, re-check on sign-in
    if (!token) {
      setStatus("unauthenticated");
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let r: Response;
      try {
        r = await fetch("/api/consent", {
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
      } catch {
        // Network error — fail open so infra issues never block clinical use
        markGiven();
        return;
      } finally {
        clearTimeout(timeout);
      }

      if (!r.ok) { markGiven(); return; }

      let d: any;
      try { d = await r.json(); } catch { markGiven(); return; }

      // Server says not authenticated — show login, re-check on sign-in
      if (d.unauthenticated) { setStatus("unauthenticated"); return; }

      // Server gave an explicit answer — trust it even if a _warn tag is
      // attached (e.g. "table_unavailable" still reports hasConsented:false
      // correctly). Only fail open when the server could NOT determine
      // consent status at all (no hasConsented field present).
      if (typeof d.hasConsented !== "boolean") {
        if (d._warn) { markGiven(); return; }
        setStatus("needed");
        return;
      }

      if (d.hasConsented) {
        markGiven();
      } else {
        setStatus("needed");
      }
    } catch {
      markGiven();
    }
  }

  useEffect(() => {
    if (givenRef.current) return;

    supabase.auth.getSession().then(({ data: { session } }) => {
      checkConsent(session?.access_token ?? "");
    }).catch(() => markGiven());

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Always ignore token refresh — never triggers a re-check
      if (event === "TOKEN_REFRESHED") return;
      // If already given, tear down listener and exit
      if (givenRef.current) { subscription.unsubscribe(); return; }
      // On sign-in (including first sign-up), re-check consent with the new token
      checkConsent(session?.access_token ?? "");
    });
    subscriptionRef.current = subscription;

    return () => { subscription.unsubscribe(); subscriptionRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      await fetch("/api/consent", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ consentType: "terms_and_privacy", version: "1.0" }),
      });
    } catch {
      /* best-effort — don't block the user */
    }
    markGiven();
  };

  // Spinner while we check with the server
  if (status === "loading") {
    return (
      <div style={{
        minHeight: "100vh", background: "#080c18", display: "flex",
        alignItems: "center", justifyContent: "center",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <div style={{
            width: 36, height: 36,
            border: "3px solid rgba(20,184,166,0.2)",
            borderTopColor: "#14b8a6", borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <p style={{ color: "#8898aa", fontSize: 13, margin: 0 }}>Loading…</p>
        </div>
      </div>
    );
  }

  // Pass through to login screen — consent check will re-run on sign-in
  if (status === "unauthenticated") return <>{children}</>;

  // Pass through — user has already accepted
  if (status === "given") return <>{children}</>;

  // ── T&C popup — only shown to logged-in users who haven't consented ─────────
  return (
    <div style={{
      minHeight: "100vh", background: "#080c18",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "24px 16px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <div style={{
        width: "100%", maxWidth: 560,
        background: "#0f1624",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 16,
        display: "flex", flexDirection: "column",
        maxHeight: "calc(100vh - 48px)",
        overflow: "hidden",
      }}>

        {/* ── Header (fixed, never scrolls) ── */}
        <div style={{ padding: "28px 28px 0", flexShrink: 0 }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            background: "rgba(20,184,166,0.1)", border: "1px solid rgba(20,184,166,0.25)",
            borderRadius: 20, padding: "4px 12px", marginBottom: 16,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#14b8a6", display: "inline-block" }} />
            <span style={{ color: "#14b8a6", fontSize: 11, fontWeight: 600, letterSpacing: "0.04em" }}>FOR LICENSED PSYCHIATRISTS ONLY</span>
          </div>
          <h1 style={{ color: "#f0f4f8", fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>
            Sphota — Terms of Use &amp; Data Notice
          </h1>
          <p style={{ color: "#8898aa", fontSize: 13, margin: "0 0 20px", lineHeight: 1.6 }}>
            Please read the following carefully before using Sphota. You must accept these terms
            to access the platform. Your acceptance is recorded with a timestamp as required
            under the Digital Personal Data Protection Act, 2023 (India).
          </p>
          <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />
        </div>

        {/* ── Scrollable body ── */}
        <div style={{
          overflowY: "auto", flex: 1,
          padding: "20px 28px",
          fontSize: 13, color: "#94a3b8", lineHeight: 1.75,
        }}>
          <Section title="1. What is Sphota?">
            Sphota is a clinical documentation platform designed exclusively for use by
            licensed psychiatrists, psychologists, and qualified mental health professionals
            registered under the Medical Council of India or an equivalent statutory body.
            It assists with session transcription, clinical note generation, report drafting,
            and medical record management.
            <br /><br />
            Sphota is a <strong style={{ color: "#e2e8f0" }}>documentation support tool only</strong>.
            It does not diagnose, prescribe, or replace clinical judgment. Every report, note,
            or document generated must be reviewed, verified, and signed off by the treating
            clinician before use in patient care, referrals, or legal proceedings.
          </Section>

          <Section title="2. Who May Use This Platform">
            Access is restricted to:
            <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              <li>Psychiatrists and mental health professionals with valid registration</li>
              <li>Clinical staff authorised by a registered practitioner within the same clinic</li>
            </ul>
            <br />
            By accepting these terms, you confirm that you are a licensed mental health
            professional and that you will use Sphota only within the scope of your clinical
            practice. Misuse by unlicensed individuals is prohibited.
          </Section>

          <Section title="3. Clinical Responsibility">
            All output produced by Sphota — including transcripts, clinical notes, psychiatric
            reports, and medication summaries — is a <strong style={{ color: "#e2e8f0" }}>draft for review</strong>.
            <br /><br />
            You, as the treating clinician, bear full and sole clinical and legal responsibility for:
            <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              <li>Verifying the accuracy of every transcript and report before use</li>
              <li>Correcting any errors in automatically generated content</li>
              <li>Ensuring that final documents comply with clinical standards and ethics</li>
              <li>Obtaining patient consent before recording any session audio</li>
            </ul>
            <br />
            Sphota's operator accepts no clinical or legal liability for any action taken on
            the basis of unreviewed output.
          </Section>

          <Section title="4. Data We Collect and Why">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Data</th>
                  <th style={thStyle}>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Name, email, clinic details", "Account creation and identification"],
                  ["Patient records you enter", "Clinical documentation features"],
                  ["Session audio (real-time only)", "Transcription — not stored after processing"],
                  ["Consent and review logs", "Legal audit trail under DPDP Act 2023"],
                  ["Access logs and IP address", "Security monitoring and abuse prevention"],
                ].map(([d, p]) => (
                  <tr key={d}>
                    <td style={tdStyle}>{d}</td>
                    <td style={tdStyle}>{p}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <br />
            We do not sell, rent, or share your data with third parties for commercial purposes.
          </Section>

          <Section title="5. Data Storage and Security">
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>Account and patient data is stored in Supabase (Mumbai — ap-south-1 region), encrypted at rest using AES-256-GCM.</li>
              <li>Session audio is processed in real time and is never written to disk or retained after the session ends.</li>
              <li>All data in transit is protected by TLS 1.2 or higher.</li>
              <li>Access is restricted by row-level security policies tied to your authenticated account.</li>
            </ul>
          </Section>

          <Section title="6. Cross-Border Data Transfer">
            Certain platform features — including transcription and report generation — require
            transmitting de-identified session data to service providers whose servers are
            located in the <strong style={{ color: "#e2e8f0" }}>United States</strong>.
            Patient names and direct identifiers are removed before transmission.
            <br /><br />
            By accepting these terms, you consent to this transfer, which is necessary to
            provide the service (DPDP Act 2023, Section 16). If you object to cross-border
            transfer, do not use transcription or report generation features.
          </Section>

          <Section title="7. Your Rights Under DPDP Act 2023">
            As a data principal under the Digital Personal Data Protection Act, 2023, you have the right to:
            <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              <li>Access a summary of the personal data we hold about you</li>
              <li>Correct inaccurate or incomplete personal data</li>
              <li>Withdraw consent and request erasure of your data (Settings → Account → Withdraw Consent)</li>
              <li>Nominate a person to exercise these rights on your behalf in the event of death or incapacity</li>
              <li>File a complaint with the Data Protection Board of India</li>
            </ul>
            <br />
            Withdrawal of consent will result in suspension of your account. Data erasure
            requests will be processed within 30 days.
          </Section>

          <Section title="8. Patient Data and Confidentiality">
            You are responsible for maintaining patient confidentiality in accordance with
            the Indian Medical Council (Professional Conduct, Etiquette and Ethics) Regulations, 2002
            and any applicable state laws.
            <br /><br />
            Before recording any clinical session, you must obtain explicit informed consent
            from the patient or their guardian. Sphota provides a printable patient consent
            form for this purpose (accessible from the patient profile screen).
          </Section>

          <Section title="9. Prohibited Uses">
            You must not use Sphota to:
            <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              <li>Record sessions without patient consent</li>
              <li>Generate reports for patients you have not personally assessed</li>
              <li>Share login credentials with individuals who are not authorised clinic staff</li>
              <li>Attempt to reverse-engineer, copy, or redistribute any part of the platform</li>
              <li>Input data about individuals for purposes unrelated to their clinical care</li>
            </ul>
          </Section>

          <Section title="10. Limitation of Liability">
            Sphota and its operators are not liable for:
            <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              <li>Clinical decisions made on the basis of unreviewed or uncorrected output</li>
              <li>Any loss, harm, or regulatory action arising from misuse of the platform</li>
              <li>Temporary unavailability due to maintenance or infrastructure issues</li>
            </ul>
            <br />
            Total liability in any event is limited to the subscription fees paid in the
            preceding three months.
          </Section>

          <Section title="11. Changes to These Terms">
            We may update these terms to reflect changes in law, regulation, or platform
            features. When we do, you will be asked to review and re-accept the updated version
            before continuing. Material changes will be communicated by email at least 14 days
            in advance.
          </Section>

          <Section title="12. Governing Law and Disputes">
            These terms are governed by the laws of India. Any dispute arising under these
            terms shall be subject to the exclusive jurisdiction of courts in New Delhi, India.
          </Section>

          <Section title="13. Contact and Grievance Officer">
            For data privacy concerns, consent withdrawal, or grievances:
            <br /><br />
            <strong style={{ color: "#e2e8f0" }}>Grievance Officer — Sphota</strong><br />
            Email:{" "}
            <a href="mailto:privacy@sphota.app" style={{ color: "#14b8a6", textDecoration: "none" }}>
              privacy@sphota.app
            </a>
            <br />
            Response time: within 48 hours. Resolution: within 30 days.
          </Section>

          <div style={{
            marginTop: 20, padding: "12px 14px",
            background: "rgba(20,184,166,0.06)",
            border: "1px solid rgba(20,184,166,0.15)",
            borderRadius: 8, fontSize: 12, color: "#64748b",
          }}>
            <a href="/privacy" target="_blank" style={{ color: "#14b8a6", textDecoration: "none", marginRight: 16 }}>
              Privacy Policy ↗
            </a>
            <a href="/terms" target="_blank" style={{ color: "#14b8a6", textDecoration: "none" }}>
              Full Terms of Service ↗
            </a>
          </div>
        </div>

        {/* ── Accept button — fixed at bottom, always visible ── */}
        <div style={{
          padding: "16px 28px 24px", flexShrink: 0,
          borderTop: "1px solid rgba(255,255,255,0.06)",
          background: "#0f1624",
        }}>
          <button
            onClick={accept}
            style={{
              width: "100%", padding: "14px", background: "#14b8a6",
              border: "none", borderRadius: 10, color: "#080c18",
              fontSize: 15, fontWeight: 700, cursor: "pointer",
              letterSpacing: "0.01em",
            }}
          >
            I have read and accept these terms
          </button>
          <p style={{ color: "#4b5563", fontSize: 11, margin: "10px 0 0", textAlign: "center", lineHeight: 1.5 }}>
            Your acceptance is recorded with a timestamp. You can withdraw consent at any time
            from Settings → Account → Withdraw Consent.
          </p>
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "6px 10px", fontSize: 11.5, fontWeight: 600,
  color: "#64748b", borderBottom: "1px solid rgba(255,255,255,0.06)",
};
const tdStyle: React.CSSProperties = {
  padding: "6px 10px", verticalAlign: "top", fontSize: 12.5,
  borderBottom: "1px solid rgba(255,255,255,0.04)",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <h2 style={{
        color: "#cbd5e1", fontSize: 13, fontWeight: 700,
        margin: "0 0 8px", letterSpacing: "0.01em",
      }}>
        {title}
      </h2>
      <div style={{ color: "#94a3b8", lineHeight: 1.75, fontSize: 13 }}>
        {children}
      </div>
    </div>
  );
}
