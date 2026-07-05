import { useEffect } from "react";

export default function PrivacyPage() {
  // Override the app-shell's body overflow:hidden so this page can scroll
  useEffect(() => {
    const prevBodyOverflow = document.body.style.overflow;
    const prevBodyHeight   = document.body.style.height;
    const root = document.getElementById("root");
    const prevRootOverflow = root?.style.overflow ?? "";
    const prevRootHeight   = root?.style.height   ?? "";

    document.body.style.overflow = "auto";
    document.body.style.height   = "auto";
    if (root) { root.style.overflow = "auto"; root.style.height = "auto"; }

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.height   = prevBodyHeight;
      if (root) { root.style.overflow = prevRootOverflow; root.style.height = prevRootHeight; }
    };
  }, []);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=Inter:wght@400;500;600&display=swap');

        .pp-page {
          min-height: 100vh;
          background: #ffffff;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          color: #1c1c1c;
          padding: 0;
        }

        /* Outer shell: left ruled margin like a legal pad */
        .pp-page::before {
          content: '';
          position: fixed;
          top: 0; left: 0; bottom: 0;
          width: 4px;
          background: #1a3a5c;
          z-index: 10;
        }

        .pp-inner {
          max-width: 860px;
          margin: 0 auto;
          padding: 56px 64px 100px;
        }

        /* Back button — understated, text-link style */
        .pp-back {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: transparent;
          border: none;
          padding: 0;
          color: #1a3a5c;
          font-size: 13px;
          font-family: 'Inter', sans-serif;
          font-weight: 500;
          cursor: pointer;
          margin-bottom: 48px;
          letter-spacing: 0.01em;
          text-decoration: underline;
          text-underline-offset: 3px;
          text-decoration-color: #a0b4c8;
          transition: color 0.15s, text-decoration-color 0.15s;
        }
        .pp-back:hover { color: #0f2a40; text-decoration-color: #1a3a5c; }

        /* Letterhead-style header */
        .pp-header {
          border-top: 3px solid #1a3a5c;
          border-bottom: 1px solid #c8d4dc;
          padding: 32px 0 28px;
          margin-bottom: 48px;
          position: relative;
        }
        .pp-eyebrow {
          font-family: 'Inter', sans-serif;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #1a3a5c;
          margin: 0 0 12px;
        }
        .pp-title {
          font-family: 'EB Garamond', Georgia, serif;
          font-size: clamp(28px, 5vw, 44px);
          font-weight: 700;
          color: #0d1f2d;
          margin: 0 0 16px;
          line-height: 1.1;
          letter-spacing: -0.3px;
        }
        .pp-meta {
          font-size: 12px;
          color: #6b7f8c;
          margin: 0;
          font-family: 'Inter', sans-serif;
          letter-spacing: 0.01em;
        }
        .pp-meta span { margin: 0 8px; color: #b0bec5; }
        .pp-intro {
          font-size: 14px;
          color: #3a4e5c;
          line-height: 1.85;
          margin: 20px 0 0;
          padding: 16px 20px;
          background: #f4f7fa;
          border-left: 3px solid #1a3a5c;
          font-family: 'Inter', sans-serif;
        }

        /* Section — flat, ruled, document-style */
        .pp-section {
          background: #ffffff;
          border-top: 1px solid #dde5ec;
          padding: 32px 0;
          margin-bottom: 0;
        }
        .pp-section:last-of-type {
          border-bottom: 1px solid #dde5ec;
        }

        .pp-section-num {
          font-family: 'Inter', sans-serif;
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: #1a3a5c;
          margin: 0 0 8px;
        }
        .pp-section-title {
          font-family: 'EB Garamond', Georgia, serif;
          font-size: clamp(16px, 2.5vw, 20px);
          font-weight: 600;
          color: #0d1f2d;
          margin: 0 0 16px;
          line-height: 1.3;
        }
        .pp-section p {
          font-size: 14px;
          color: #3a4e5c;
          line-height: 1.9;
          margin: 0 0 12px;
          font-family: 'Inter', sans-serif;
        }
        .pp-section p:last-child { margin-bottom: 0; }
        .pp-section ul {
          margin: 4px 0 0;
          padding-left: 22px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          list-style: disc;
        }
        .pp-section li {
          font-size: 14px;
          color: #3a4e5c;
          line-height: 1.85;
          font-family: 'Inter', sans-serif;
        }

        /* Compliance badge — styled as a formal notice strip */
        .pp-badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: #eef4f8;
          border: 1px solid #c0d0dc;
          border-left: 3px solid #1a3a5c;
          padding: 6px 14px;
          font-size: 12px;
          font-weight: 600;
          color: #1a3a5c;
          font-family: 'Inter', sans-serif;
          letter-spacing: 0.01em;
          margin-bottom: 16px;
        }

        /* Footer — formal document colophon */
        .pp-footer {
          margin-top: 56px;
          padding: 20px 0;
          border-top: 3px solid #1a3a5c;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 10px;
        }
        .pp-footer-brand {
          font-family: 'EB Garamond', Georgia, serif;
          font-size: 16px;
          font-weight: 700;
          color: #0d1f2d;
          letter-spacing: 0.02em;
        }
        .pp-footer-brand span { color: #1a3a5c; }
        .pp-footer-note { font-size: 11px; color: #6b7f8c; font-family: 'Inter', sans-serif; letter-spacing: 0.01em; }

        /* Responsive — tablet */
        @media (max-width: 768px) {
          .pp-inner { padding: 40px 36px 80px; }
          .pp-page::before { display: none; }
        }

        /* Responsive — mobile */
        @media (max-width: 480px) {
          .pp-inner { padding: 28px 20px 80px; }
          .pp-header { padding: 24px 0 20px; margin-bottom: 32px; }
          .pp-section { padding: 24px 0; }
          .pp-back { margin-bottom: 32px; }
        }
      `}</style>

      <div className="pp-page">
        <div className="pp-inner">

          <button className="pp-back" onClick={() => window.location.href = "/"}>
            ← Back to App
          </button>

          <div className="pp-header">
            <p className="pp-eyebrow">Legal</p>
            <h1 className="pp-title">Privacy Policy</h1>
            <p className="pp-meta">
              Sphota
              <span>·</span>
              Last updated: 31 May 2026
              <span>·</span>
              Version 1.1
            </p>
            <p className="pp-intro">
              Sphota is a clinical documentation assistant for licensed psychiatrists practising in India.
              We are committed to protecting the privacy of both the healthcare provider
              and the patients whose records are managed through the app.
            </p>
          </div>

          <div className="pp-section">
            <p className="pp-section-num">Section 01</p>
            <h2 className="pp-section-title">What data we collect</h2>
            <ul>
              <li><strong style={{ color: "#0f172a" }}>Doctor accounts:</strong> name, clinic name, specialty, email address, contact number, and a hashed PIN. Collected at signup and stored in Supabase (region: India/Mumbai by default).</li>
              <li><strong style={{ color: "#0f172a" }}>Patient records:</strong> name, age, gender, session transcripts, clinical notes, medication lists, and assessment scale scores. Created by the doctor and stored under their account.</li>
              <li><strong style={{ color: "#0f172a" }}>Session audio:</strong> audio is captured in the browser and sent to our transcription service over an encrypted connection. Audio is not stored on our servers — only the text transcript is saved.</li>
              <li><strong style={{ color: "#0f172a" }}>Scanned documents:</strong> images uploaded for document scanning are processed in memory by our vision service and are not stored on disk or in the database.</li>
              <li><strong style={{ color: "#0f172a" }}>Beta feedback:</strong> if you voluntarily complete the feedback form, your name, email, WhatsApp number, and answers are stored in our database.</li>
              <li><strong style={{ color: "#0f172a" }}>Usage data:</strong> we do not currently use any third-party analytics service.</li>
            </ul>
          </div>

          <div className="pp-section">
            <p className="pp-section-num">Section 02</p>
            <h2 className="pp-section-title">How we use the data</h2>
            <p>
              We use your data solely to provide the features of Sphota: generating clinical notes,
              storing patient records, producing patient-facing documents, and improving the product.
            </p>
            <p>
              We do not sell, rent, or share your data with any third party for marketing purposes.
              We do not use patient data to train models.
            </p>
          </div>

          <div className="pp-section">
            <p className="pp-section-num">Section 03</p>
            <h2 className="pp-section-title">Smart processing &amp; cross-border data transfer</h2>
            <div className="pp-badge">🔒 Patient names never sent to external providers</div>

            <p>
              Sphota uses third-party services for transcription, report generation, and
              document scanning. When these features are used, data is transmitted to servers
              located outside India (United States). The following describes exactly what is sent:
            </p>

            <ul>
              <li>
                <strong>Session audio</strong> — sent to our transcription service (primary)
                or a fallback service for speech-to-text transcription.
                Audio is processed in real time and not retained beyond the API request window.
              </li>
              <li>
                <strong>Session transcript text</strong> — sent to our language service
                (primary or fallback) for clinical report generation.
                Patient names and phone numbers are algorithmically removed from transcript text
                before transmission using automated PII stripping.
              </li>
              <li>
                <strong>Document scan images</strong> — sent to our vision service
                (primary or fallback) for OCR and summarisation.
                Patient names are not included in the request. Only anonymised clinical
                parameters (age, gender) may be provided as context where available.
              </li>
            </ul>

            <p>
              <strong>Cross-border transfer basis:</strong> These transfers are necessary to
              provide the contracted service and are made under the consent you provide on
              first login (DPDP Act 2023, Section 16). You may withdraw consent and stop
              using smart features at any time from Settings → Account.
            </p>

            <p>
              <strong>Sub-processor policies:</strong>{" "}
              <a href="https://ai.google.dev/terms" target="_blank" rel="noopener noreferrer">Google Gemini Terms</a>
              {" · "}
              <a href="https://openai.com/policies/api-data-usage-policies" target="_blank" rel="noopener noreferrer">OpenAI API Policy</a>
              {" · "}
              Under their enterprise API terms, none of these providers may use
              API-submitted data for model training.
            </p>

            <p>
              All transmissions are encrypted in transit using TLS 1.2 or higher.
              API keys are server-side only and never exposed to the browser.
            </p>
          </div>

          <div className="pp-section">
            <p className="pp-section-num">Section 04</p>
            <h2 className="pp-section-title">Data retention</h2>
            <p>
              You can set a data-retention period in your account settings. When configured, session
              records older than that period will be automatically deleted. You can also delete individual
              patient records and your entire account at any time by contacting us.
            </p>
          </div>

          <div className="pp-section">
            <p className="pp-section-num">Section 05</p>
            <h2 className="pp-section-title">Patient consent</h2>
            <p>
              It is the responsibility of the treating doctor to obtain patient consent for assisted
              session recording before using Sphota in a clinical session. The app provides a consent
              confirmation step at the start of each recording to support this obligation.
            </p>
          </div>

          <div className="pp-section">
            <p className="pp-section-num">Section 06</p>
            <h2 className="pp-section-title">Security</h2>
            <ul>
              <li>All data is transmitted over HTTPS/TLS.</li>
              <li>Sensitive database fields are encrypted at rest using AES-256-GCM.</li>
              <li>Your account is protected by Supabase Auth (email/password) and an optional device PIN.</li>
              <li>Sessions auto-lock after a configurable period of inactivity.</li>
              <li>Full audit logging of every access event, exportable on request.</li>
            </ul>
          </div>

          <div className="pp-section">
            <p className="pp-section-num">Section 07</p>
            <h2 className="pp-section-title">Your rights under the DPDP Act 2023</h2>
            <p>As a Data Principal under the Digital Personal Data Protection Act, 2023, you have the right to:</p>
            <ul>
              <li><strong style={{ color: "#0f172a" }}>Access:</strong> request a summary of the personal data we hold about you.</li>
              <li><strong style={{ color: "#0f172a" }}>Correction:</strong> request correction of inaccurate personal data.</li>
              <li><strong style={{ color: "#0f172a" }}>Erasure:</strong> request deletion of your data via Settings → Account → Delete Account, or by emailing the Grievance Officer.</li>
              <li><strong style={{ color: "#0f172a" }}>Withdraw consent:</strong> you may withdraw consent at any time from Settings → Account → Withdraw Consent. Withdrawal does not affect the lawfulness of prior processing.</li>
              <li><strong style={{ color: "#0f172a" }}>Grievance redressal:</strong> lodge a complaint with our Grievance Officer or with the Data Protection Board of India.</li>
              <li><strong style={{ color: "#0f172a" }}>Right to nominate:</strong> nominate another individual to exercise your data protection rights on your behalf in the event of your death or incapacity (DPDP Act 2023, Section 14).</li>
            </ul>
          </div>

          <div className="pp-section">
            <p className="pp-section-num">Section 08</p>
            <h2 className="pp-section-title">Changes to this policy</h2>
            <p>
              We will update this policy as the product evolves. The "Last updated" date at the top
              of this page will reflect any changes. Continued use of the app after a policy change
              constitutes acceptance of the revised policy.
            </p>
          </div>

          <div className="pp-section">
            <p className="pp-section-num">Section 09</p>
            <h2 className="pp-section-title">Contact</h2>
            <p>
              For privacy-related questions, contact us at{" "}
              <a href="mailto:privacy@sphota.app" style={{ color: "#0f766e", textDecoration: "none", fontWeight: 500 }}>privacy@sphota.app</a>.
            </p>
          </div>

          {/* Grievance Officer — IT SPDI Rules 2011 Rule 5(9) */}
          <div className="pp-section">
            <p className="pp-section-num">Grievance Officer</p>
            <h2 className="pp-section-title">Grievance Officer Details</h2>
            <p>
              In accordance with the Information Technology (Reasonable Security Practices and Procedures
              and Sensitive Personal Data or Information) Rules, 2011, and the Digital Personal Data
              Protection Act, 2023, the name and contact details of the Grievance Officer are provided below.
            </p>
            <p>
              <strong style={{ color: "#0f172a" }}>Name:</strong> Data Protection Officer, Sphota<br />
              <strong style={{ color: "#0f172a" }}>Email:</strong>{" "}
              <a href="mailto:privacy@sphota.app" style={{ color: "#0f766e", textDecoration: "none", fontWeight: 500 }}>privacy@sphota.app</a><br />
              <strong style={{ color: "#0f172a" }}>Response time:</strong> Within 30 days of receipt of grievance.
            </p>
            <p>
              If your grievance is not resolved within 30 days, you may escalate to the Data Protection Board of India once constituted under the DPDP Act 2023.
            </p>
          </div>

          <div className="pp-footer">
            <div className="pp-footer-brand">Sphota<span>.</span></div>
            <div className="pp-footer-note">© 2026 Sphota · Built for Indian psychiatry</div>
          </div>

        </div>
      </div>
    </>
  );
}
