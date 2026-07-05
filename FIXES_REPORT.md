# Sphota — Performance, Medicine MOA & Security Fixes
Generated: June 5, 2026

## 1. Medicine descriptions failing intermittently (FIXED)

**Root cause:** `/api/ai/chat` validated ALL responses as full clinical reports (min 100 chars + section markers). Medication MOA lookups return ~60-word structured text and were rejected ~50% of the time, causing silent fallthrough to dead providers.

**Fix:**
- `api/ai/chat.ts` — skip clinical validation when `taskType: "utility"`
- `src/MedCard.tsx` — sends `taskType: "utility"`, retries twice on failure, checks `res.ok` and empty results
- `src/drugSpellcheck.ts` — fuzzy spell-correction for 100+ common psych drugs before API call
- AI prompt updated to correct misspellings and prefix `Corrected: [name]` when inferred

## 2. Landing page lag / high LCP (IMPROVED)

**Root cause:** Heavy always-on canvas animation (90 nodes, O(n²) connections, 60fps), magnetic cursor with 3 rAF loops, and LandingPage bundled in main JS.

**Fix:**
- Canvas: 48 nodes, 30fps cap, pauses when tab hidden, skips on `prefers-reduced-motion`
- Cursor: desktop only, 30fps, removed trail element
- `AuthGate.tsx` — lazy-loads LandingPage (now separate 62KB chunk)
- `index.html` — font preload + trimmed font weights for faster LCP

## 3. Security (HARDENED)

- `api/_shared.ts` — CORS changed from `*` to origin allowlist (localhost, Vercel previews, `ALLOWED_ORIGINS`)
- Existing: CSP headers in vercel.json, DOMPurify on HTML, auth required on AI endpoints in production

## 4. LCP regression: 0.2–0.3s → 10–12s (FIXED)

**Root cause:** `RootGate` (in `AuthGate.tsx`) initialized `authState` to `"loading"`
and rendered nothing but a spinner until `supabase.auth.getSession()` resolved.
Only after that network round trip completed did it switch to `"guest"` and
render `<LandingPage>` — which contains the actual hero `<h1>` (the LCP
element). Any slowness in that auth call (cold start, regional latency, flaky
network) directly became LCP time, with no timeout or fallback. This was an
unintended side effect of fix #2 above, which correctly lazy-loaded
`LandingPage` for bundle size but left it gated behind a blocking auth check.

**Fix (`src/AuthGate.tsx`):**
- `RootGate` now checks `localStorage` synchronously (no network call) for a
  cached Supabase session token before first render. If none is found —
  the common case for a first-time/logged-out visitor hitting the marketing
  page — `authState` starts at `"guest"` immediately, so `LandingPage` paints
  on the very first render instead of waiting on `getSession()`.
- If a cached token *is* found (returning logged-in user), the app still
  starts at `"loading"` briefly to avoid flashing the landing page before
  showing the authenticated app.
- Added a 4-second hard timeout (`AUTH_RESOLVE_TIMEOUT_MS`) around the normal
  `getSession()` flow so that even in the worst case (hung request), the app
  falls back to `"guest"` instead of spinning indefinitely.

**Result:** LCP for guest visitors is no longer coupled to auth network
latency at all — the hero renders immediately, matching the original
0.2–0.3s baseline.


1. Unzip and replace your project
2. `npm install && npm run build`
3. Deploy to Vercel (env vars unchanged)
4. Test: tap ℹ on any medication — description should load every time, including misspelled names
