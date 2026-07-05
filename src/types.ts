export type Theme = "dark" | "light";
export type DocLang = "en" | "hi" | "mr" | "bn" | "ta" | "te";
export type NoteFormat = "SOAP" | "DAP" | "BIRP" | "PIRP" | "NIMHANS";

export interface DoctorProfile {
  name: string;
  specialty: string;
  clinic: string;
  contact?: string;
  aiApiKey?: string;
  privacyAcceptedAt?: string | null;
  dataRegion?: string;
  noteFormat?: NoteFormat;
  dataRetentionYears?: "1" | "3" | "5" | "never";
}

export interface Patient {
  id: number;
  name: string;
  age: number;
  gender: string;
  time: string;
  status: "active" | "waiting" | "done";
}

export interface ReportSection {
  label: string;
  value: string;
}

export interface ClinicalReport {
  sections: ReportSection[];
  diagnosis: string;
  plan: string[];
}

export interface ScaleScore {
  scale: "PHQ-9" | "GAD-7" | "C-SSRS";
  score: number | null;
  severity: string;
}

export interface ReportEntry {
  id: string;
  date: string;
  report: ClinicalReport;
  transcript: string;
  rawText?: string;
  editedHtml?: string;
  editedAt?: string;
  reviewConfirmedAt?: string;
  notes?: string;
  flagged?: boolean;
  patientDocMd?: string;
  patientDocEditedHtmlEn?: string;
  patientDocHindiMd?: string;
  patientDocEditedHtmlHi?: string;
  patientDocMarathiMd?: string;
  patientDocBengaliMd?: string;
  patientDocTamilMd?: string;
  patientDocTeluguMd?: string;
  scaleScores?: ScaleScore[];
  collateralTranscript?: string;
}

export interface Medication {
  id: string;
  name: string;
  dose: string;
  frequency: string;
  startDate: string;
  endDate?: string;
  prescribedBy: string;
  sessionId?: string;
  notes?: string;
  status: "active" | "discontinued";
  discontinuedReason?: string;
}

export interface PatientMedRecord {
  medications: Medication[];
  allergies: string[];
}

export interface MedDraft {
  name: string;
  dose: string;
  frequency: string;
  include: boolean;
}

export interface Appointment {
  id: string;
  patientId: number;
  date: string;
  time: string;
  notes: string;
}
