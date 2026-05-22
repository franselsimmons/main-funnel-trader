// ================= LIB/ANALYSISNOTIFIER.JS =================

const DEFAULT_CHUNK_SIZE = 150;

function getBaseUrl() {
  if (process.env.ANALYSIS_BASE_URL) {
    return process.env.ANALYSIS_BASE_URL.replace(/\/$/, "");
  }

  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`.replace(/\/$/, "");
  }

  if (process.env.NODE_ENV !== "production") {
    return "http://localhost:3000";
  }

  return "";
}

function getAnalyzeUrl() {
  if (process.env.ANALYSIS_API_URL) {
    return process.env.ANALYSIS_API_URL;
  }

  const base = getBaseUrl();
  if (!base) return "";

  return `${base}/api/analyse`;
}

function chunkArray(rows, size) {
  const chunks = [];

  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }

  return chunks;
}

function compactActionForAnalysis(action) {
  if (!action || typeof action !== "object") return action;

  return {
    ...action,

    // Hou payload kleiner. Grote arrays/body's horen niet in analyzer.
    pricePathSample: Array.isArray(action.pricePathSample)
      ? action.pricePathSample.slice(-20)
      : action.pricePathSample,

    filterDiagnostics: action.filterDiagnostics
      ? {
          filterValues: action.filterDiagnostics.filterValues || action.filterValues || null,
          liveMetrics: action.filterDiagnostics.liveMetrics || action.liveFilterMetrics || null,
          passMap: action.filterDiagnostics.passMap || action.filterChecks || null,
          specialChecks: action.filterDiagnostics.specialChecks || action.specialFilterChecks || null
        }
      : action.filterDiagnostics
  };
}

export async function sendAnalysisActions(actions = [], meta = {}) {
  const rows = Array.isArray(actions)
    ? actions.filter(Boolean)
    : [];

  if (!rows.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ACTIONS",
      total: 0,
      sent: 0,
      failed: 0
    };
  }

  const url = getAnalyzeUrl();

  if (!url) {
    return {
      ok: false,
      skipped: true,
      reason: "ANALYSIS_URL_MISSING",
      total: rows.length,
      sent: 0,
      failed: rows.length
    };
  }

  const chunkSize = Number(process.env.ANALYSIS_CHUNK_SIZE || DEFAULT_CHUNK_SIZE);
  const chunks = chunkArray(rows.map(compactActionForAnalysis), chunkSize);

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < chunks.length; i++) {
    const body = {
      ...meta,
      batchIndex: i,
      batchCount: chunks.length,
      actions: chunks[i],
      sentAt: Date.now()
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.ANALYZE_API_SECRET
            ? { "x-analyze-secret": process.env.ANALYZE_API_SECRET }
            : {})
        },
        body: JSON.stringify(body)
      });

      const text = await res.text();

      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }

      if (!res.ok || json?.ok === false) {
        failed += chunks[i].length;
        errors.push({
          chunk: i,
          status: res.status,
          error: json?.error || text.slice(0, 300)
        });

        continue;
      }

      sent += chunks[i].length;
    } catch (e) {
      failed += chunks[i].length;
      errors.push({
        chunk: i,
        error: e.message
      });
    }
  }

  return {
    ok: failed === 0,
    skipped: false,
    url,
    total: rows.length,
    sent,
    failed,
    errors
  };
}