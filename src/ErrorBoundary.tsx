import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  name?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// Send error report to backend (fires Twilio WhatsApp alert + logs to Supabase)
function reportErrorToBackend(error: Error, info: ErrorInfo, name: string): void {
  try {
    const payload = {
      type: "client_error",
      message: `[${name}] ${error.message}`,
      stack: (error.stack ?? "") + "\n\nComponent stack:" + (info.componentStack ?? ""),
      context: {
        path: window.location.pathname,
        boundary: name,
        timestamp: new Date().toISOString(),
      },
    };
    // Best-effort: don't await, don't let failure cascade
    fetch("/api/report-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => { /* silent */ });
  } catch { /* never throw from error reporter */ }
}

// Send non-boundary errors (promise rejections, global errors) to backend
export function reportClientError(message: string, extra?: Record<string, unknown>): void {
  try {
    fetch("/api/report-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "client_error",
        message,
        stack: extra?.stack ?? "",
        context: {
          path: window.location.pathname,
          timestamp: new Date().toISOString(),
          ...extra,
        },
      }),
      keepalive: true,
    }).catch(() => { /* silent */ });
  } catch { /* never throw */ }
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const name = this.props.name ?? "unknown";
    console.error(`[ErrorBoundary: ${name}]`, error, info.componentStack);
    reportErrorToBackend(error, info, name);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          padding: "24px",
          background: "rgba(239,68,68,0.08)",
          border: "1px solid rgba(239,68,68,0.25)",
          borderRadius: "10px",
          margin: "12px",
        }}>
          <p style={{ color: "#ef4444", fontWeight: 600, fontSize: 14, margin: "0 0 6px" }}>
            Something went wrong in this section
          </p>
          <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 12px", fontFamily: "monospace" }}>
            {this.state.error?.message ?? "Unknown error"}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: "6px 16px", borderRadius: 6, background: "#ef4444",
              color: "#fff", border: "none", fontSize: 13, cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
