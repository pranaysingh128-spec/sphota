import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RootGate } from "./AuthGate";
import { ErrorBoundary } from "./ErrorBoundary";
import "./index.css";

// Lazy-load heavy pages so they're excluded from the initial JS bundle.
// Each page only downloads when the user navigates to it.
const FeedbackPage      = lazy(() => import("./FeedbackPage"));
const AdminFeedbackPage = lazy(() => import("./AdminFeedbackPage"));
const CommandLogPage    = lazy(() => import("./CommandLogPage"));
const PrivacyPage       = lazy(() => import("./PrivacyPage"));
const TermsPage         = lazy(() => import("./TermsPage"));
const ConsentGate       = lazy(() => import("./ConsentGate"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,        // 30 seconds
      gcTime: 5 * 60 * 1000,       // 5 minutes
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

const path = window.location.pathname;

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary
    name="root"
    fallback={
      <div style={{
        minHeight: "100vh", background: "#080c18", display: "flex",
        alignItems: "center", justifyContent: "center", padding: 24,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}>
        <div style={{ textAlign: "center", maxWidth: 360 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <h2 style={{ color: "#f0f4f8", fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>
            Something went wrong
          </h2>
          <p style={{ color: "#8898aa", fontSize: 14, margin: "0 0 20px", lineHeight: 1.5 }}>
            The app encountered an unexpected error. Please refresh the page.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "10px 24px", borderRadius: 8, background: "#14b8a6",
              color: "#080c18", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>
      </div>
    }
  >
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={null}>
        {path === "/feedback"        ? <FeedbackPage /> :
         path === "/admin/feedback"  ? <AdminFeedbackPage /> :
         path === "/xlog"            ? <CommandLogPage /> :
         path === "/privacy"         ? <PrivacyPage /> :
         path === "/terms"           ? <TermsPage /> :
         <ConsentGate><RootGate /></ConsentGate>}
      </Suspense>
    </QueryClientProvider>
  </ErrorBoundary>
);
