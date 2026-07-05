import { useEffect } from "react";

export default function TermsPage() {
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

        .tp-page {
          min-height: 100vh;
          background: #ffffff;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          color: #1c1c1c;
          padding: 0;
        }

        /* Ruled left margin */
        .tp-page::before {
          content: '';
          position: fixed;
          top: 0; left: 0; bottom: 0;
          width: 4px;
          background: #1a3a5c;
          z-index: 10;
        }

        .tp-inner {
          max-width: 860px;
          margin: 0 auto;
          padding: 56px 64px 100px;
        }

        /* Back button */
        .tp-back {
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
        .tp-back:hover { color: #0f2a40; text-decoration-color: #1a3a5c; }

        /* Letterhead header */
        .tp-header {
          border-top: 3px solid #1a3a5c;
          border-bottom: 1px solid #c8d4dc;
          padding: 32px 0 28px;
          margin-bottom: 48px;
        }
        .tp-eyebrow {
          font-family: 'Inter', sans-serif;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #1a3a5c;
          margin: 0 0 12px;
        }
        .tp-title {
          font-family: 'EB Garamond', Georgia, serif;
          font-size: clamp(28px, 5vw, 44px);
          font-weight: 700;
          color: #0d1f2d;
          margin: 0 0 16px;
          line-height: 1.1;
          letter-spacing: -0.3px;
        }
        .tp-meta {
          font-size: 12px;
          color: #6b7f8c;
          margin: 0;
          font-family: 'Inter', sans-serif;
          letter-spacing: 0.01em;
        }
        .tp-meta span {
          margin: 0 8px;
          color: #b0bec5;
        }
        .tp-intro {
          font-size: 14px;
          color: #3a4e5c;
          line-height: 1.85;
          margin: 20px 0 0;
          padding: 16px 20px;
          background: #f4f7fa;
          border-left: 3px solid #1a3a5c;
          font-family: 'Inter', sans-serif;
        }

        /* Section — flat, ruled */
        .tp-section {
          background: #ffffff;
          border-top: 1px solid #dde5ec;
          padding: 32px 0;
        }
        .tp-section:last-of-type {
          border-bottom: 1px solid #dde5ec;
        }

        .tp-section-num {
          font-family: 'Inter', sans-serif;
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: #1a3a5c;
          margin: 0 0 8px;
        }
        .tp-section-title {
          font-family: 'EB Garamond', Georgia, serif;
          font-size: clamp(16px, 2.5vw, 20px);
          font-weight: 600;
          color: #0d1f2d;
          margin: 0 0 16px;
          line-height: 1.3;
        }
        .tp-section p {
          font-size: 14px;
          color: #3a4e5c;
          line-height: 1.9;
          margin: 0 0 12px;
          font-family: 'Inter', sans-serif;
        }
        .tp-section p:last-child { margin-bottom: 0; }
        .tp-section ul {
          margin: 4px 0 0;
          padding-left: 22px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          list-style: disc;
        }
        .tp-section li {
          font-size: 14px;
          color: #3a4e5c;
          line-height: 1.85;
          font-family: 'Inter', sans-serif;
        }

        /* Footer colophon */
        .tp-footer {
          margin-top: 56px;
          padding: 20px 0;
          border-top: 3px solid #1a3a5c;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 10px;
        }
        .tp-footer-brand {
          font-family: 'EB Garamond', Georgia, serif;
          font-size: 16px;
          font-weight: 700;
          color: #0d1f2d;
          letter-spacing: 0.02em;
        }
        .tp-footer-brand span { color: #1a3a5c; }
        .tp-footer-note {
          font-size: 11px;
          color: #6b7f8c;
          font-family: 'Inter', sans-serif;
          letter-spacing: 0.01em;
        }

        /* Responsive — tablet */
        @media (max-width: 768px) {
          .tp-inner { padding: 40px 36px 80px; }
          .tp-page::before { display: none; }
        }

        /* Responsive — mobile */
        @media (max-width: 480px) {
          .tp-inner { padding: 28px 20px 80px; }
          .tp-header { padding: 24px 0 20px; margin-bottom: 32px; }
          .tp-section { padding: 24px 0; }
          .tp-back { margin-bottom: 32px; }
        }
      `}</style>

      <div className="tp-page">
        <div className="tp-inner">

          <button className="tp-back" onClick={() => window.location.href = "/"}>
            ← Back to App
          </button>

          <div className="tp-header">
            <p className="tp-eyebrow">Legal</p>
            <h1 className="tp-title">Terms of Service</h1>
            <p className="tp-meta">
              Sphota
              <span>·</span>
              Last updated: 31 May 2026
              <span>·</span>
              Version 1.1
            </p>
            <p className="tp-intro">
              By creating an account and using Sphota, you agree to these terms in full.
              Please read them carefully before using the platform.
            </p>
          </div>

          <div className="tp-section">
            <p className="tp-section-num">Section 01</p>
            <h2 className="tp-section-title">Who may use Sphota</h2>
            <p>
              Sphota is designed exclusively for licensed psychiatric and medical professionals.
              By using the app, you confirm that you hold the appropriate qualifications and
              registrations required to practise in your jurisdiction, including valid registration
              with the Medical Council of India or applicable state medical council.
            </p>
          </div>

          <div className="tp-section">
            <p className="tp-section-num">Section 02</p>
            <h2 className="tp-section-title">Intended use</h2>
            <p>
              Sphota is a clinical support tool. It does not replace the professional judgement
              of a qualified doctor. All smart-generated notes, summaries, and clinical documentation
              must be reviewed and corrected by the treating clinician before being used in patient
              care or entered into any official medical record.
            </p>
          </div>

          <div className="tp-section">
            <p className="tp-section-num">Section 03</p>
            <h2 className="tp-section-title">Patient data and consent</h2>
            <p>
              You are the data controller for your patients' records within Sphota. You are solely
              responsible for obtaining informed consent from each patient before recording a session
              or processing their personal or clinical information through the app.
            </p>
            <p>
              Patient data must only be used for the clinical purposes for which it was collected.
              You must not use patient records within Sphota for any research, commercial, or
              secondary purpose without explicit consent from each patient.
            </p>
          </div>

          <div className="tp-section">
            <p className="tp-section-num">Section 04</p>
            <h2 className="tp-section-title">Acceptable use</h2>
            <p>
              You must not use Sphota to process data for any person who has not consented, to store
              data outside the purposes described in the Privacy Policy, or to attempt to reverse-engineer,
              scrape, or abuse the platform in any way.
            </p>
            <p>
              Any attempt to circumvent security controls, extract data in bulk, or access another
              clinician's records without authorisation will result in immediate account suspension
              and may be reported to the appropriate authorities.
            </p>
          </div>

          <div className="tp-section">
            <p className="tp-section-num">Section 05</p>
            <h2 className="tp-section-title">Availability</h2>
            <p>
              Sphota is provided on an "as is" basis. While we aim for high availability, we
              do not guarantee uninterrupted service. We will provide advance notice of
              scheduled maintenance wherever possible. For urgent issues, contact support@sphota.app.
            </p>
          </div>

          <div className="tp-section">
            <p className="tp-section-num">Section 06</p>
            <h2 className="tp-section-title">Limitation of liability</h2>
            <p>
              To the maximum extent permitted by applicable law, Sphota and its developers are
              not liable for any clinical decisions made on the basis of auto-generated content,
              or for any loss of data arising from technical failures or misuse of the platform.
            </p>
            <p>
              The platform is a documentation aid. Clinical responsibility remains entirely with
              the treating clinician at all times.
            </p>
          </div>

          <div className="tp-section">
            <p className="tp-section-num">Section 07</p>
            <h2 className="tp-section-title">Termination</h2>
            <p>
              We reserve the right to suspend or terminate accounts that violate these terms,
              with or without notice depending on the severity of the violation.
            </p>
          </div>

          <div className="tp-section">
            <p className="tp-section-num">Section 08</p>
            <h2 className="tp-section-title">Governing law</h2>
            <p>
              These terms are governed by the laws of India. Any disputes will be subject to
              the exclusive jurisdiction of the competent courts of India.
            </p>
          </div>

          <div className="tp-section">
            <p className="tp-section-num">Section 09</p>
            <h2 className="tp-section-title">Contact</h2>
            <p>
              For questions regarding these terms, please contact us at{" "}
              <a href="mailto:legal@sphota.app" style={{ color: "#0f766e", textDecoration: "none", fontWeight: 500 }}>legal@sphota.app</a>.
            </p>
          </div>

          <div className="tp-footer">
            <div className="tp-footer-brand">Sphota<span>.</span></div>
            <div className="tp-footer-note">© 2026 Sphota · Built for Indian psychiatry</div>
          </div>

        </div>
      </div>
    </>
  );
}
