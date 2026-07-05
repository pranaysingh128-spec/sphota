import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5000,
    host: "0.0.0.0",
    allowedHosts: true,
    headers: securityHeaders,
    watch: {
      ignored: ["**/.local/**", "**/node_modules/**"],
    },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: false,
        xfwd: true,
      },
    },
  },
  build: {
    // App.tsx is intentionally large — raise the limit to silence the warning
    chunkSizeWarningLimit: 1000,
    modulePreload: { polyfill: true },
    rollupOptions: {
      output: {
        manualChunks: {
          // Split heavy vendor libraries into separate cached chunks
          "vendor-react":     ["react", "react-dom"],
          "vendor-supabase":  ["@supabase/supabase-js"],
          "vendor-pdf":       ["jspdf", "html2canvas"],
          "vendor-tiptap":    ["@tiptap/react", "@tiptap/starter-kit"],
          "vendor-markdown":  ["react-markdown", "marked", "remark-gfm"],
          "vendor-charts":    ["recharts"],
        },
      },
    },
  },
});
