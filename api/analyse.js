import { getLatestScan } from "../lib/scanStore.js";
import * as analyzeStore from "../lib/analyze/analyzeStore.js";
import * as familyEngine from "../lib/analyze/familyEngine.js";

const DEFAULT_MIN_CLOSED = 10;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;

  return fallback;
}

function normalizeTs(value, fallback = Date.now()) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["long", "bull", "buy"].includes(s)) return "LONG";
  if (["short", "bear", "sell"].includes(s)) return "SHORT";

  return "";
}

function stableNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100000) / 100000;
}

function eventKey(event, fallbackIndex = 0) {
  const explicit =
    event.analyzeEventKey ||
    event.analyzeEventId ||
    event.eventId ||
    event.tradeId ||
    event.positionId ||
    event.orderId ||
    event.id;

  if (explicit) return String(explicit);

  const symbol = String(event.symbol || "").toUpperCase().trim();
  const side = normalizeSide(event.side || event.direction);
  const action = String(event.action || event.status || event.reason || "").toUpperCase().trim();
  const entry = stableNumber(event.entry ?? event.entryPrice);
  const sl = stableNumber(event.sl ?? event.stopLoss);
  const tp = stableNumber(event.tp ?? event.takeProfit);
  const ts = normalizeTs(
    event.ts ??
      event.createdAt ??
      event.openedAt ??
      event.updatedAt ??
      event.closedAt,
    fallbackIndex
  );

  return [symbol, side, action, entry, sl, tp, ts].join("|");
}

function dedupeEvents(events) {
  const map = new Map();

  safeArray(events).forEach((event, index) => {
    if (!event || typeof event !== "object") return;

    const key = eventKey(event, index);
    map.set(key, {
      ...event,
      analyzeEventKey: key,
    });
  });

  return Array.from(map.values());
}

function collectLatestEvents(latest) {
  const events = [
    ...safeArray(latest?.trades),
    ...safeArray(latest?.tradeSystemResult?.actions),
    ...safeArray(latest?.actions),
  ];

  return dedupeEvents(events)
    .filter(event => event && typeof event === "object")
    .map(event => ({
      ...event,
      analyzeSource: event.analyzeSource || "latest_scan",
    }));
}

async function loadStoredEvents() {
  const loadStore =
    analyzeStore.loadAnalyzeStore ||
    analyzeStore.default?.loadAnalyzeStore;

  const loadEvents =
    analyzeStore.loadAnalyzeEvents ||
    analyzeStore.readAnalyzeEvents ||
    analyzeStore.getAnalyzeEvents ||
    analyzeStore.default?.loadAnalyzeEvents ||
    analyzeStore.default?.readAnalyzeEvents ||
    analyzeStore.default?.getAnalyzeEvents;

  if (typeof loadStore === "function") {
    const store = await loadStore();
    return {
      store: {
        ok: Boolean(store?.ok),
        path: store?.path || null,
        count: safeNumber(store?.count, safeArray(store?.events).length),
        maxStoredEvents: store?.maxStoredEvents || null,
      },
      events: safeArray(store?.events),
    };
  }

  if (typeof loadEvents === "function") {
    const events = await loadEvents();
    return {
      store: {
        ok: true,
        path: null,
        count: safeArray(events).length,
        maxStoredEvents: null,
      },
      events: safeArray(events),
    };
  }

  return {
    store: {
      ok: false,
      path: null,
      count: 0,
      maxStoredEvents: null,
      error: "NO_ANALYZE_STORE_LOADER_FOUND",
    },
    events: [],
  };
}

async function clearStoredEvents() {
  const clearFn =
    analyzeStore.clearAnalyzeEvents ||
    analyzeStore.resetAnalyzeEvents ||
    analyzeStore.default?.clearAnalyzeEvents ||
    analyzeStore.default?.resetAnalyzeEvents;

  if (typeof clearFn !== "function") {
    return {
      ok: false,
      error: "NO_CLEAR_ANALYZE_EVENTS_EXPORT_FOUND",
    };
  }

  return clearFn();
}

function buildReport(events, options) {
  const buildFn =
    familyEngine.buildAnalyzeReport ||
    familyEngine.buildFamilyReport ||
    familyEngine.buildReport ||
    familyEngine.analyzeEvents ||
    familyEngine.createAnalyzeReport ||
    familyEngine.default?.buildAnalyzeReport ||
    familyEngine.default?.buildFamilyReport ||
    familyEngine.default?.buildReport ||
    familyEngine.default?.analyzeEvents ||
    familyEngine.default?.createAnalyzeReport;

  if (typeof buildFn !== "function") {
    throw new Error("NO_ANALYZE_REPORT_BUILDER_FOUND");
  }

  return buildFn(events, options);
}

function serializeError(error, debug = false) {
  const payload = {
    message: error?.message || String(error || "unknown_error"),
    name: error?.name || "Error",
  };

  if (debug && error?.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  const debug = normalizeBoolean(req?.query?.debug, false);
  const reset = normalizeBoolean(req?.query?.reset, false);
  const includeLatest = normalizeBoolean(req?.query?.includeLatest, true);
  const minClosed = safeNumber(req?.query?.minClosed, DEFAULT_MIN_CLOSED);

  try {
    if (reset) {
      const clearResult = await clearStoredEvents();

      return res.status(clearResult?.ok ? 200 : 500).json({
        ok: Boolean(clearResult?.ok),
        reset: true,
        clearResult,
        generatedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      });
    }

    const latest = await getLatestScan().catch(error => ({
      ok: false,
      error: error?.message || String(error),
    }));

    const { store, events: storedEventsRaw } = await loadStoredEvents();
    const latestEventsRaw = includeLatest && latest?.ok ? collectLatestEvents(latest) : [];

    const storedEvents = dedupeEvents(storedEventsRaw);
    const latestEvents = dedupeEvents(latestEventsRaw);
    const mergedEvents = dedupeEvents([...storedEvents, ...latestEvents]);

    const report = buildReport(mergedEvents, {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
    });

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      sources: {
        storedEvents: storedEvents.length,
        latestEvents: latestEvents.length,
        mergedEvents: mergedEvents.length,
        store,
        latest: {
          ok: Boolean(latest?.ok),
          updatedAt: latest?.updatedAt || null,
          tradeFunnelUpdatedAt: latest?.tradeFunnelUpdatedAt || null,
          error: latest?.error || null,
        },
      },
      tradesLoaded: mergedEvents.length,
      report,
    });
  } catch (error) {
    console.error("ANALYSE API ERROR:", error);

    return res.status(500).json({
      ok: false,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: serializeError(error, debug),
    });
  }
}