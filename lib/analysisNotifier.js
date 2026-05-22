// ================= lib/analysisNotifier.js =================
// TradeSystem gebruikt sendAnalysisActions(finalActions, meta).
// Deze versie slaat lokaal/durable op via analyzeStore.
// Externe webhook is optioneel.

import { appendAnalyzeEvents } from "./analyze/analyzeStore.js";

function getWebhookUrl() {
  return (
    process.env.ANALYSIS_WEBHOOK_URL ||
    process.env.ANALYZE_WEBHOOK_URL ||
    ""
  );
}

async function postOptionalWebhook(actions, meta) {
  const url = getWebhookUrl();

  if (!url) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_WEBHOOK_URL"
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      actions,
      ...meta
    })
  });

  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text?.slice(0, 500)
    };
  }

  return {
    ok: true,
    status: res.status,
    response: json || text
  };
}

export async function sendAnalysisActions(actions = [], meta = {}) {
  const rows = Array.isArray(actions) ? actions : [];

  if (!rows.length) {
    return {
      ok: true,
      sent: 0,
      stored: 0,
      total: 0,
      skipped: true,
      reason: "NO_ACTIONS"
    };
  }

  const storeResult = await appendAnalyzeEvents(rows, {
    ...meta,
    source: "TRADE_SYSTEM_ACTION"
  });

  const webhookResult = await postOptionalWebhook(rows, meta).catch(e => ({
    ok: false,
    error: e.message
  }));

  const ok = Boolean(storeResult?.ok) && Boolean(webhookResult?.ok);

  return {
    ok,
    total: rows.length,

    sent: webhookResult?.ok && !webhookResult?.skipped ? rows.length : 0,
    failed: webhookResult?.ok ? 0 : rows.length,

    stored: Number(storeResult?.stored || 0),

    store: storeResult,
    webhook: webhookResult,

    skipped: Boolean(webhookResult?.skipped),
    reason: webhookResult?.reason || null,
    error: webhookResult?.error || null
  };
}