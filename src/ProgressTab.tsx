import { useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";
import type { ReportEntry } from "./types";

interface Props {
  sessions: ReportEntry[];
}

interface ChartPoint {
  date: string;
  phq9?: number;
  gad7?: number;
  cssrs?: number;
}

function fmt(date: string) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// Severity band helpers
function phq9Severity(score: number) {
  if (score <= 4) return { label: "Minimal", color: "#22c55e" };
  if (score <= 9) return { label: "Mild", color: "#84cc16" };
  if (score <= 14) return { label: "Moderate", color: "#f59e0b" };
  if (score <= 19) return { label: "Mod-Severe", color: "#f97316" };
  return { label: "Severe", color: "#ef4444" };
}

function gad7Severity(score: number) {
  if (score <= 4) return { label: "Minimal", color: "#22c55e" };
  if (score <= 9) return { label: "Mild", color: "#84cc16" };
  if (score <= 14) return { label: "Moderate", color: "#f59e0b" };
  return { label: "Severe", color: "#ef4444" };
}

function TrendCard({
  label, color, current, previous, severity, max,
}: {
  label: string;
  color: string;
  current: number;
  previous?: number;
  severity?: { label: string; color: string };
  max?: number;
}) {
  const trend =
    previous === undefined ? null
    : current > previous ? "up"
    : current < previous ? "down"
    : "same";

  const change = previous !== undefined ? Math.abs(current - previous) : null;

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8,
      padding: "14px 18px",
      background: "var(--surface)",
      border: `1px solid ${severity ? severity.color + "40" : "var(--border)"}`,
      borderRadius: 14,
      minWidth: 160,
      flex: 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.03em", fontWeight: 600 }}>
          {label}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        <span style={{ fontSize: 32, fontWeight: 800, color: "var(--text)", lineHeight: 1 }}>
          {current}
        </span>
        {max !== undefined && <span style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>/{max}</span>}
        {trend && (
          <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 4 }}>
            {trend === "up" && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: "#ef4444" }}>
                <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {trend === "down" && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: "#22c55e" }}>
                <path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {trend === "same" && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: "var(--text-muted)" }}>
                <path d="M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
              </svg>
            )}
            {change !== null && change > 0 && (
              <span style={{ fontSize: 11, color: trend === "up" ? "#ef4444" : "#22c55e", fontWeight: 600 }}>
                {trend === "up" ? "+" : "-"}{change}
              </span>
            )}
          </div>
        )}
      </div>
      {severity && (
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          background: severity.color + "20",
          borderRadius: 6, padding: "3px 8px", alignSelf: "flex-start",
        }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: severity.color }} />
          <span style={{ fontSize: 11, color: severity.color, fontWeight: 600 }}>{severity.label}</span>
        </div>
      )}
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: 10,
      padding: "10px 14px",
      fontSize: 12,
      boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
    }}>
      <div style={{ color: "var(--text-muted)", marginBottom: 8, fontWeight: 600 }}>{fmt(label)}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.color }} />
          <span style={{ color: "var(--text-muted)" }}>{p.name}:</span>
          <strong style={{ color: "var(--text)" }}>{p.value}</strong>
        </div>
      ))}
    </div>
  );
};

// Session progress dots — visual timeline without dates
function SessionProgressDots({ sessions }: { sessions: ReportEntry[] }) {
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => a.date.localeCompare(b.date)),
    [sessions],
  );

  if (sorted.length === 0) return null;

  return (
    <section style={{ marginTop: 32 }}>
      <h3 style={{
        fontSize: 13, fontWeight: 600, color: "var(--text)",
        marginBottom: 16, letterSpacing: "0.02em",
      }}>
        Session History
      </h3>
      <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap", rowGap: 12 }}>
        {sorted.map((entry, idx) => {
          const scaleLabels: string[] = [];
          for (const s of entry.scaleScores ?? []) {
            if (s.score === null || s.score === undefined) continue;
            if (s.scale === "PHQ-9") scaleLabels.push(`PHQ-9: ${s.score}`);
            if (s.scale === "GAD-7") scaleLabels.push(`GAD-7: ${s.score}`);
          }
          const isLast = idx === sorted.length - 1;

          return (
            <div key={entry.id} style={{ display: "flex", alignItems: "center" }}>
              {/* Session dot */}
              <div
                title={`Session ${idx + 1}${scaleLabels.length ? " · " + scaleLabels.join(" · ") : ""}${entry.notes?.trim() ? "\n" + entry.notes.trim().slice(0, 80) : ""}`}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                  cursor: "default",
                }}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: "50%",
                  background: entry.flagged
                    ? "rgba(239,68,68,0.15)"
                    : "rgba(34,197,94,0.12)",
                  border: `2px solid ${entry.flagged ? "#ef4444" : "#22c55e"}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 700,
                  color: entry.flagged ? "#ef4444" : "#22c55e",
                  boxShadow: isLast ? `0 0 0 3px ${entry.flagged ? "rgba(239,68,68,0.2)" : "rgba(34,197,94,0.2)"}` : "none",
                }}>
                  {idx + 1}
                </div>
                {scaleLabels.length > 0 && (
                  <span style={{ fontSize: 10, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {scaleLabels[0]}
                  </span>
                )}
              </div>
              {/* Connector line */}
              {!isLast && (
                <div style={{
                  width: 24, height: 2,
                  background: "var(--border)",
                  flexShrink: 0,
                }} />
              )}
            </div>
          );
        })}
        {/* Current label */}
        <div style={{
          marginLeft: 12, fontSize: 11, color: "var(--text-muted)",
          fontStyle: "italic",
        }}>
          ← latest
        </div>
      </div>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 10 }}>
        🟢 Stable &nbsp;·&nbsp; 🔴 Flagged &nbsp;·&nbsp; Hover a dot for session details
      </p>
    </section>
  );
}

export function ProgressTab({ sessions }: Props) {
  const {
    chartData, latestPhq9, prevPhq9, latestGad7, prevGad7, latestCssrs, prevCssrs,
  } = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));

    const phq9Pts: { date: string; score: number }[] = [];
    const gad7Pts: { date: string; score: number }[] = [];
    const cssrsPts: { date: string; score: number }[] = [];

    for (const entry of sorted) {
      const dayKey = entry.date.slice(0, 10);
      for (const s of entry.scaleScores ?? []) {
        if (s.score === null || s.score === undefined) continue;
        if (s.scale === "PHQ-9") phq9Pts.push({ date: dayKey, score: s.score as number });
        if (s.scale === "GAD-7") gad7Pts.push({ date: dayKey, score: s.score as number });
        if (s.scale === "C-SSRS") cssrsPts.push({ date: dayKey, score: s.score as number });
      }
    }

    const allDates = Array.from(
      new Set([
        ...phq9Pts.map(p => p.date),
        ...gad7Pts.map(p => p.date),
        ...cssrsPts.map(p => p.date),
      ]),
    ).sort();

    const chartData: ChartPoint[] = allDates.map(date => ({
      date,
      phq9: phq9Pts.find(p => p.date === date)?.score,
      gad7: gad7Pts.find(p => p.date === date)?.score,
      cssrs: cssrsPts.find(p => p.date === date)?.score,
    }));

    return {
      chartData,
      latestPhq9: phq9Pts.at(-1),
      prevPhq9:   phq9Pts.at(-2),
      latestGad7: gad7Pts.at(-1),
      prevGad7:   gad7Pts.at(-2),
      latestCssrs: cssrsPts.at(-1),
      prevCssrs:   cssrsPts.at(-2),
    };
  }, [sessions]);

  const phq9Count  = chartData.filter(d => d.phq9  !== undefined).length;
  const gad7Count  = chartData.filter(d => d.gad7  !== undefined).length;
  const cssrsCount = chartData.filter(d => d.cssrs !== undefined).length;
  const hasEnough  = phq9Count >= 1 || gad7Count >= 1 || cssrsCount >= 1;
  const hasAnyScores = hasEnough;

  return (
    <div style={{ padding: "24px", height: "100%", overflowY: "auto" }}>

      {/* Trend cards */}
      {(latestPhq9 || latestGad7 || latestCssrs) && (
        <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
          {latestPhq9 && (
            <TrendCard
              label="PHQ-9 (Latest)"
              color="#3b82f6"
              current={latestPhq9.score}
              previous={prevPhq9?.score}
              severity={phq9Severity(latestPhq9.score)}
              max={27}
            />
          )}
          {latestGad7 && (
            <TrendCard
              label="GAD-7 (Latest)"
              color="#22c55e"
              current={latestGad7.score}
              previous={prevGad7?.score}
              severity={gad7Severity(latestGad7.score)}
              max={21}
            />
          )}
          {latestCssrs && latestCssrs.score !== null && (
            <TrendCard
              label="C-SSRS (Latest)"
              color="#f59e0b"
              current={latestCssrs.score}
              previous={prevCssrs?.score}
              max={6}
            />
          )}
        </div>
      )}

      {/* Need 2+ sessions for trend line note */}
      {hasAnyScores && (phq9Count < 2 && gad7Count < 2 && cssrsCount < 2) && (
        <div style={{
          padding: "12px 16px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          fontSize: 12,
          color: "var(--text-muted)",
          marginBottom: 20,
        }}>
          📈 Score trend lines will connect once scores are recorded across 2+ sessions.
        </div>
      )}

      {/* Line chart */}
      {hasEnough && (
        <div style={{ marginBottom: 8 }}>
          <h3 style={{
            fontSize: 13, fontWeight: 600, color: "var(--text)",
            marginBottom: 16, letterSpacing: "0.02em",
          }}>
            Score Trends
          </h3>
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                {/* Severity reference lines */}
                <ReferenceLine y={5}  stroke="rgba(132,204,22,0.25)"  strokeDasharray="4 4" />
                <ReferenceLine y={10} stroke="rgba(245,158,11,0.25)"  strokeDasharray="4 4" />
                <ReferenceLine y={15} stroke="rgba(249,115,22,0.25)"  strokeDasharray="4 4" />
                <ReferenceLine y={20} stroke="rgba(239,68,68,0.25)"   strokeDasharray="4 4" />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmt}
                  tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                  axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 30]}
                  ticks={[0, 5, 10, 15, 20, 25, 30]}
                  tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                  axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
                  tickLine={false}
                  width={28}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: "rgba(255,255,255,0.1)" }} />
                <Legend wrapperStyle={{ fontSize: 12, color: "var(--text-muted)", paddingTop: 16 }} />
                {phq9Count >= 1 && (
                  <Line
                    type="monotone" dataKey="phq9" name="PHQ-9"
                    stroke="#3b82f6" strokeWidth={2.5}
                    dot={{ r: 5, fill: "#3b82f6", strokeWidth: 0 }}
                    activeDot={{ r: 7, fill: "#3b82f6" }}
                    connectNulls={true}
                  />
                )}
                {gad7Count >= 1 && (
                  <Line
                    type="monotone" dataKey="gad7" name="GAD-7"
                    stroke="#22c55e" strokeWidth={2.5}
                    dot={{ r: 5, fill: "#22c55e", strokeWidth: 0 }}
                    activeDot={{ r: 7, fill: "#22c55e" }}
                    connectNulls={true}
                  />
                )}
                {cssrsCount >= 1 && (
                  <Line
                    type="monotone" dataKey="cssrs" name="C-SSRS"
                    stroke="#f59e0b" strokeWidth={2.5}
                    dot={{ r: 5, fill: "#f59e0b", strokeWidth: 0 }}
                    activeDot={{ r: 7, fill: "#f59e0b" }}
                    connectNulls={true}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, textAlign: "right" }}>
            Dashed lines: severity thresholds (5 · 10 · 15 · 20)
          </p>
        </div>
      )}

      {/* No scale scores yet — explain clearly */}
      {sessions.length > 0 && !hasAnyScores && (
        <div style={{
          padding: "20px 24px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          marginBottom: 24,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
            📈 Score Trend Chart
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
            The chart appears automatically when PHQ-9, GAD-7, or C-SSRS scores are mentioned in a session transcript.<br />
            <span style={{ marginTop: 6, display: "block" }}>
              Example: <em>"PHQ-9 score was 14"</em> or <em>"GAD-7 came out to 11"</em> — Sphota will detect and plot these across sessions.
            </span>
          </div>
        </div>
      )}

      {sessions.length === 0 && (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: 200,
          color: "var(--text-muted)", fontSize: 13, gap: 8,
        }}>
          <span style={{ fontSize: 32 }}>📋</span>
          <span>No sessions recorded yet for this patient.</span>
        </div>
      )}

      {/* Session progress dots — no dates shown */}
      {sessions.length > 0 && <SessionProgressDots sessions={sessions} />}

    </div>
  );
}
