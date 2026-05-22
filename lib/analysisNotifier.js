// ================= lib/analysisNotifier.js =================

const ANALYSIS_BATCH_SIZE = Number(process.env.ANALYSIS_BATCH_SIZE || 200);
const ANALYSIS_TIMEOUT_MS = Number(process.env.ANALYSIS_TIMEOUT_MS || 8000);

function chunkArray(rows, size) {
  const chunks = [];

  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }

  return chunks;
}

function getBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`.replace(/\/$/, "");
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`.replace(/\/$/, "");
  }

  return "";
}

function getEndpoint() {
  if (process.env.ANALYZE_ENDPOINT) return process.env.ANALYZE_ENDPOINT;
  if (process.env.ANALYSIS_WEBHOOK_URL) return process.env.ANALYSIS_WEBHOOK_URL;

  const baseUrl = getBaseUrl();
  if (!baseUrl) return "";

  return `${baseUrl}/api/analyse`;
}

async function postJson(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await res.text();

    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok || json?.ok === false) {
      return {
        ok: false,
        status: res.status,
        error: json?.error || text?.slice(0, 500) || `HTTP_${res.status}`
      };
    }

    return {
      ok: true,
      status: res.status,
      json
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendAnalysisActions(actions, meta = {}) {
  const rows = Array.isArray(actions) ? actions.filter(Boolean) : [];

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

  const endpoint = getEndpoint();

  if (!endpoint) {
    return {
      ok: false,
      skipped: true,
      reason: "ANALYZE_ENDPOINT_MISSING",
      total: rows.length,
      sent: 0,
      failed: rows.length
    };
  }

  const chunks = chunkArray(rows, ANALYSIS_BATCH_SIZE);

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const chunk of chunks) {
    const result = await postJson(endpoint, {
      source: "tradeSystem",
      actions: chunk,
      meta: {
        ...meta,
        endpointSource: "analysisNotifier",
        sentAt: Date.now()
      },

      runId: meta.runId || null,
      btcState: meta.btcState || null,
      strategyVersion: meta.strategyVersion || null,
      discoveryMode: meta.discoveryMode ?? null,

      filterValues:
        meta.filterValues ||
        meta.currentFilterValues ||
        meta.tradeSystemFilters ||
        null
    });

    if (result.ok) {
      sent += chunk.length;
    } else {
      failed += chunk.length;
      errors.push(result.error || "UNKNOWN_ERROR");
    }
  }

  return {
    ok: failed === 0,
    endpoint,
    total: rows.length,
    sent,
    failed,
    errors: errors.slice(0, 5)
  };
}