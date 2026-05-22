// ================= lib/analysisNotifier.js =================
// Direct store: geen webhook nodig binnen dezelfde root.
// tradeSystem.js roept sendAnalysisActions(finalActions, context) al aan.

import { ingestAnalysisRows } from "./analyze/analyzeStore.js";

export async function sendAnalysisActions(actions = [], context = {}) {
  try {
    const result = await ingestAnalysisRows(
      {
        actions,
        ...context
      },
      context
    );

    console.log("ANALYSIS_STORE_OK:", JSON.stringify({
      sent: result.sent,
      total: result.total,
      storageMode: result.storageMode
    }));

    return {
      ok: true,
      sent: result.sent || 0,
      failed: 0,
      total: result.total || 0,
      storageMode: result.storageMode,
      skipped: Boolean(result.skipped),
      reason: result.reason || null
    };
  } catch (e) {
    console.warn("ANALYSIS_STORE_ERROR:", e.message);

    return {
      ok: false,
      sent: 0,
      failed: Array.isArray(actions) ? actions.length : 0,
      total: Array.isArray(actions) ? actions.length : 0,
      error: e.message
    };
  }
}