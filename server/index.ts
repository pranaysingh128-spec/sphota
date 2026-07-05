/**
 * Local development API server
 * ─────────────────────────────────────────────────────────────────────────
 * This wraps the Vercel serverless function handlers as plain Express routes
 * so you can run `npm run dev` locally.  In production, Vercel handles the
 * /api/* routes automatically — this file is never deployed.
 *
 * Requires a .env file in the project root with the variables listed in
 * .env.example.  See README / .env.example for the full list.
 * ─────────────────────────────────────────────────────────────────────────
 */

import * as dotenv from "dotenv";
dotenv.config(); // must be FIRST — handlers read process.env on import

import express from "express";
import type { Request, Response, NextFunction } from "express";
import compression from "compression";

// ── API handlers ─────────────────────────────────────────────
import chatHandler           from "../api/ai/chat.js";
import transcribeHandler     from "../api/ai/transcribe.js";
import scanHandler           from "../api/ai/scan.js";
import consentHandler        from "../api/consent.js";
import deleteAccountHandler  from "../api/delete-account.js";

// Receptionist routes
import receptionistDashboard    from "../api/receptionist/dashboard.js";
import receptionistManage       from "../api/receptionist/manage.js";
import receptionistPatients     from "../api/receptionist/patients.js";
import receptionistSignup       from "../api/receptionist/signup.js";
import receptionistAppointments from "../api/receptionist/appointments.js";
import receptionistApptById     from "../api/receptionist/appointments/[id].js";
import receptionistPatientStatus from "../api/receptionist/patients/[id]/status.js";

const app  = express();
app.use(compression()); // gzip all responses — shrinks JSON/HTML by ~60-80%
const PORT = parseInt(process.env.SERVER_PORT ?? "3001", 10);

// ── Middleware ────────────────────────────────────────────────
// Note: transcribe uses bodyParser:false and reads the raw stream itself,
// so we only apply json() to routes that need it.
app.use((req: Request, _res: Response, next: NextFunction) => {
  // Skip JSON parsing for multipart routes (they handle their own body)
  const multipartRoutes = ["/api/ai/transcribe", "/api/ai/scan"];
  if (multipartRoutes.some(r => req.path.startsWith(r))) return next();
  express.json({ limit: "2mb" })(req, _res, next);
});
app.use((req: Request, _res: Response, next: NextFunction) => {
  const multipartRoutes = ["/api/ai/transcribe", "/api/ai/scan"];
  if (multipartRoutes.some(r => req.path.startsWith(r))) return next();
  express.urlencoded({ extended: true })(req, _res, next);
});

// ── AI routes ─────────────────────────────────────────────────
app.all("/api/ai/chat",       (req, res) => chatHandler(req, res));
app.all("/api/ai/transcribe", (req, res) => transcribeHandler(req, res));
app.all("/api/ai/scan",       (req, res) => scanHandler(req, res));

// ── Core routes ───────────────────────────────────────────────
app.all("/api/consent",        (req, res) => consentHandler(req, res));
app.all("/api/delete-account", (req, res) => deleteAccountHandler(req, res));

// ── Receptionist routes ───────────────────────────────────────
app.all("/api/receptionist/dashboard",    (req, res) => receptionistDashboard(req, res));
app.all("/api/receptionist/manage",       (req, res) => receptionistManage(req, res));
app.all("/api/receptionist/patients",     (req, res) => receptionistPatients(req, res));
app.all("/api/receptionist/signup",       (req, res) => receptionistSignup(req, res));
app.all("/api/receptionist/appointments", (req, res) => receptionistAppointments(req, res));

// Dynamic-segment routes
app.all("/api/receptionist/appointments/:id", (req: any, res) => {
  req.query = { ...req.query, id: req.params.id };
  receptionistApptById(req, res);
});
app.all("/api/receptionist/patients/:id/status", (req: any, res) => {
  req.query = { ...req.query, id: req.params.id };
  receptionistPatientStatus(req, res);
});

// ── Health check ─────────────────────────────────────────────
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

// ── 404 for unknown API routes ────────────────────────────────
app.use("/api/*path", (_req, res) => res.status(404).json({ message: "API route not found" }));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  API server running on http://localhost:${PORT}`);
  console.log(`   Vite proxy → http://localhost:5000 → /api/* forwards here\n`);

  // Validate critical env vars on startup so issues are obvious immediately
  const required = [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_ANON_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const aiKeys = ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY"];

  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.warn(`⚠️  Missing env vars: ${missing.join(", ")}`);
    console.warn(`   Report generation will fail until these are set in .env\n`);
  }

  const hasAiKey = aiKeys.some(k => process.env[k]);
  if (!hasAiKey) {
    console.warn(`⚠️  No AI key found. Set at least one of: ${aiKeys.join(", ")}`);
    console.warn(`   Report generation will return 503 without an AI key.\n`);
  }

  if (!process.env.FIELD_ENCRYPTION_KEY) {
    console.warn(`⚠️  FIELD_ENCRYPTION_KEY is not set — encryption will fail if used.\n`);
  }
});
