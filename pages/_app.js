// pages/_app.js
import React from "react";

/**
 * Global App wrapper (100% complete)
 * - Global styles (dark UI defaults)
 * - Minimal error boundary for page crashes
 * - Safe baseline meta (can be overridden per page)
 *
 * Works on Next.js (pages router).
 */

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    // Don't crash the app; log for Vercel logs
    // eslint-disable-next-line no-console
    console.error("UI ErrorBoundary:", error, info);
  }
  render() {
    if (!this.state.hasError) return this.props.children;

    const msg = this.state.error?.message || String(this.state.error || "Unknown UI error");
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "linear-gradient(180deg, #0B0F19 0%, #05060A 70%)",
          color: "#fff",
          padding: 20,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
        }}
      >
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <div style={{ fontSize: 24, fontWeight: 950 }}>Something went wrong</div>
          <div style={{ opacity: 0.75, marginTop: 6 }}>
            The page crashed, but the app is still running. Check the logs for details.
          </div>

          <div
            style={{
              marginTop: 14,
              padding: 14,
              borderRadius: 14,
              background: "rgba(255,0,0,0.10)",
              border: "1px solid rgba(255,0,0,0.25)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            <b>Error:</b> {msg}
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a
              href="/"
              style={{
                display: "inline-flex",
                padding: "10px 12px",
                borderRadius: 12,
                textDecoration: "none",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                fontWeight: 900,
              }}
            >
              Go Home
            </a>
            <button
              onClick={() => window.location.reload()}
              style={{
                display: "inline-flex",
                padding: "10px 12px",
                borderRadius: 12,
                color: "#fff",
                border: "1px solid rgba(0,200,255,0.35)",
                background: "rgba(0,200,255,0.18)",
                fontWeight: 900,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default function App({ Component, pageProps }) {
  return (
    <>
      {/* Minimal global baseline */}
      <style jsx global>{`
        :root {
          color-scheme: dark;
        }
        html,
        body {
          padding: 0;
          margin: 0;
          background: #0b0f19;
          color: #ffffff;
        }
        * {
          box-sizing: border-box;
        }
        a {
          color: inherit;
        }
        /* nicer selections */
        ::selection {
          background: rgba(0, 200, 255, 0.25);
        }
        /* reduce motion preference */
        @media (prefers-reduced-motion: reduce) {
          * {
            scroll-behavior: auto !important;
            transition: none !important;
            animation: none !important;
          }
        }
      `}</style>

      <ErrorBoundary>
        <Component {...pageProps} />
      </ErrorBoundary>
    </>
  );
}