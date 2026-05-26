import { getLatestScan } from "../lib/scanStore.js";
import * as analyzeStore from "../lib/analyze/analyzeStore.js";
import * as familyEngine from "../lib/analyze/familyEngine.js";
import * as familyMicroAnalyzer from "../lib/familyMicroAnalyzer.js";

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_INCLUDE_LATEST = false;
const MAX_DEBUG_EVENTS = 50;

// Microfamily defaults.
// Parent blijft gelijk aan analyzer minClosed.
// Sub/micro mogen iets lager staan zodat je sneller ziet waar edge ontstaat,
// maar live allowlist kan straks alsnog strenger.
const DEFAULT_MIN_PARENT_CLOSED = DEFAULT_MIN_CLOSED;
const DEFAULT_MIN_SUB_CLOSED = 8;
const DEFAULT_MIN_MICRO_CLOSED = 6;

// ================= GENERIC HELPERS =================

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
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

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["long", "bull", "buy"].includes(s)) return "LONG";
  if (["short", "bear", "sell"].includes(s)) return "SHORT";

  return "";
}

function normalizeTs(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function serializeError(error, debug = false) {
  const payload = {
    message: error?.message || String(error || "unknown_error"),
    name: error?.name || "Error"
  };

  if (debug && error?.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

// ================= TRADE RECORD HELPERS =================

function getTradeId(event) {
  const id =
    event?.tradeId ||
    event?.positionId ||
    event?.orderId ||
    event?.analyzeEventKey ||
    event?.analyzeEventId ||
    event?.eventId ||
    event?.id;

  return id ? String(id) : "";
}

function getEventTs(event, fallback = Date.now()) {
  return normalizeTs(
    event?.analyzeUpdatedAt ??
      event?.closedAt ??
      event?.exitAt ??
      event?.exitTs ??
      event?.updatedAt ??
      event?.openedAt ??
      event?.createdAt ??
      event?.entryTs ??
      event?.analyzeTs ??
      event?.ts,
    fallback
  );
}

function isIgnoredAction(event) {
  const action = normalizeText(event?.action || event?.status || event?.reason);
  const kind = normalizeText(event?.analyzeKind || event?.type);

  if (kind === "TRADE_RECORD") return false;
  if (kind === "UNMATCHED_EXIT") return false;

  return (
    action === "WAIT" ||
    action === "HOLD" ||
    action === "RUNNING" ||
    action === "NO_TRADE" ||
    action === "SKIP"
  );
}

function isTradeLikeRecord(event) {
  if (!event || typeof event !== "object") return false;
  if (isIgnoredAction(event)) return false;

  const kind = normalizeText(event.analyzeKind || event.type);

  if (kind === "TRADE_RECORD") return true;
  if (kind === "UNMATCHED_EXIT") return true;

  const action = normalizeText(event.action || event.status || event.reason);

  if (action.includes("ENTRY")) return true;
  if (action.includes("EXIT")) return true;
  if (action.includes("TP")) return true;
  if (action.includes("SL")) return true;
  if (event.closed === true) return true;

  return Boolean(
    event.tradeId ||
      event.positionId ||
      event.entry !== undefined ||
      event.entryPrice !== undefined ||
      event.exitPrice !== undefined
  );
}

function compactLatestEvent(event) {
  const side = normalizeSide(event.side || event.direction || event.tradeSide);
  const tradeId = getTradeId(event);

  return {
    ...event,
    tradeId: tradeId || undefined,
    side: side || event.side,
    analyzeSource: event.analyzeSource || "latest_scan_debug",
    analyzeTs: getEventTs(event)
  };
}

function eventKey(event, fallbackIndex = 0) {
  const tradeId = getTradeId(event);

  if (tradeId) return tradeId;

  const kind = normalizeText(event?.analyzeKind || event?.type);
  const symbol = String(event?.symbol || "").toUpperCase().trim();
  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);
  const ts = getEventTs(event, fallbackIndex);

  return [kind || "EVENT", symbol, side, ts, fallbackIndex].join("|");
}

function dedupeEvents(events) {
  const map = new Map();

  safeArray(events).forEach((event, index) => {
    if (!isTradeLikeRecord(event)) return;

    const key = eventKey(event, index);
    const previous = map.get(key);

    if (!previous) {
      map.set(key, {
        ...event,
        analyzeEventKey: event.analyzeEventKey || key
      });
      return;
    }

    const prevTs = getEventTs(previous, 0);
    const nextTs = getEventTs(event, 0);

    if (nextTs >= prevTs) {
      map.set(key, {
        ...previous,
        ...event,
        analyzeEventKey: previous.analyzeEventKey || event.analyzeEventKey || key
      });
    }
  });

  return Array.from(map.values()).sort((a, b) => getEventTs(a, 0) - getEventTs(b, 0));
}

function collectLatestEvents(latest) {
  if (!latest?.ok) return [];

  const raw = [
    ...safeArray(latest.trades),
    ...safeArray(latest.tradeSystemResult?.actions),
    ...safeArray(latest.actions)
  ];

  return dedupeEvents(raw.map(compactLatestEvent));
}

// ================= STORE LOADERS =================

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
    const events = safeArray(store?.events);

    return {
      store: {
        ok: Boolean(store?.ok),
        path: store?.path || null,
        count: safeNumber(store?.count, events.length),
        trades: safeNumber(store?.trades, events.length),
        unmatchedExits: safeNumber(store?.unmatchedExits, 0),
        maxStoredEvents: store?.maxStoredEvents || null,
        primary: store?.primary || store?.source || null,
        redisEnabled: Boolean(store?.redisEnabled),
        fileEnabled: store?.fileEnabled !== false,
        error: store?.error || null
      },
      events
    };
  }

  if (typeof loadEvents === "function") {
    const events = await loadEvents();

    return {
      store: {
        ok: true,
        path: null,
        count: safeArray(events).length,
        trades: safeArray(events).length,
        unmatchedExits: 0,
        maxStoredEvents: null,
        primary: "events_loader",
        redisEnabled: false,
        fileEnabled: false,
        error: null
      },
      events: safeArray(events)
    };
  }

  return {
    store: {
      ok: false,
      path: null,
      count: 0,
      trades: 0,
      unmatchedExits: 0,
      maxStoredEvents: null,
      primary: null,
      redisEnabled: false,
      fileEnabled: false,
      error: "NO_ANALYZE_STORE_LOADER_FOUND"
    },
    events: []
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
      error: "NO_CLEAR_ANALYZE_EVENTS_EXPORT_FOUND"
    };
  }

  return clearFn();
}

// ================= REPORT BUILDER =================

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

// ================= MICRO FAMILY BUILDER =================

function getMicroBuildFn() {
  return (
    familyMicroAnalyzer.buildMainFamilyMicroAnalysis ||
    familyMicroAnalyzer.buildFamilyMicroAnalysis ||
    familyMicroAnalyzer.buildMicroFamilyAnalysis ||
    familyMicroAnalyzer.buildFamilyMicroReport ||
    familyMicroAnalyzer.buildMicroReport ||
    familyMicroAnalyzer.default?.buildMainFamilyMicroAnalysis ||
    familyMicroAnalyzer.default?.buildFamilyMicroAnalysis ||
    familyMicroAnalyzer.default?.buildMicroFamilyAnalysis ||
    familyMicroAnalyzer.default?.buildFamilyMicroReport ||
    familyMicroAnalyzer.default?.buildMicroReport
  );
}

function getBestMainLongShortFn() {
  return (
    familyMicroAnalyzer.getBestMainLongShort ||
    familyMicroAnalyzer.getBestLongShort ||
    familyMicroAnalyzer.getBestMicroLongShort ||
    familyMicroAnalyzer.default?.getBestMainLongShort ||
    familyMicroAnalyzer.default?.getBestLongShort ||
    familyMicroAnalyzer.default?.getBestMicroLongShort
  );
}

function getAllowlistFn() {
  return (
    familyMicroAnalyzer.buildMainDiscordAllowlist ||
    familyMicroAnalyzer.buildDiscordAllowlist ||
    familyMicroAnalyzer.buildMicroAllowlist ||
    familyMicroAnalyzer.default?.buildMainDiscordAllowlist ||
    familyMicroAnalyzer.default?.buildDiscordAllowlist ||
    familyMicroAnalyzer.default?.buildMicroAllowlist
  );
}

function getStatusRank(status) {
  const s = normalizeText(status);

  if (s === "ELITE") return 6;
  if (s === "HOT") return 5;
  if (s === "GOOD") return 4;
  if (s === "STABLE") return 3;
  if (s === "CANDIDATE") return 2;
  if (s === "COLLECTING") return 1;
  if (s === "EMPTY") return 0;
  if (s === "BAD") return -1;

  return 0;
}

function sortMainMicroFallback(a, b) {
  const statusDiff = getStatusRank(b.status) - getStatusRank(a.status);
  if (statusDiff !== 0) return statusDiff;

  const winrateDiff = safeNumber(b.winrateNum, 0) - safeNumber(a.winrateNum, 0);
  if (winrateDiff !== 0) return winrateDiff;

  const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgRDiff !== 0) return avgRDiff;

  const pfDiff = safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0);
  if (pfDiff !== 0) return pfDiff;

  return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
}

function fallbackBestMainLongShort(microAnalysis, minClosed) {
  const rows = [
    ...safeArray(microAnalysis?.microFamilies),
    ...safeArray(microAnalysis?.subFamilies),
    ...safeArray(microAnalysis?.parentFamilies)
  ]
    .filter(row => safeNumber(row.closed, 0) >= minClosed)
    .filter(row => safeNumber(row.avgR, 0) >= 0)
    .filter(row => safeNumber(row.profitFactor, 0) >= 1.05)
    .sort(sortMainMicroFallback);

  return {
    mode: "MAIN",
    level: "fallback_combined",
    minClosed,
    bestLong: rows.find(row => normalizeSide(row.side) === "LONG") || null,
    bestShort: rows.find(row => normalizeSide(row.side) === "SHORT") || null
  };
}

function fallbackAllowlist(microAnalysis) {
  return [
    ...safeArray(microAnalysis?.allowlists?.micro),
    ...safeArray(microAnalysis?.allowlists?.sub),
    ...safeArray(microAnalysis?.allowlists?.parent)
  ].filter(item => ["ELITE", "HOT", "GOOD", "STABLE"].includes(normalizeText(item.status)));
}

function buildMicroAnalysis(events, options = {}) {
  const buildFn = getMicroBuildFn();

  if (typeof buildFn !== "function") {
    return {
      ok: false,
      enabled: false,
      error: "NO_FAMILY_MICRO_ANALYZER_EXPORT_FOUND",
      expectedFile: "../lib/familyMicroAnalyzer.js"
    };
  }

  return buildFn(events, options);
}

function buildMicroPayload(events, options = {}) {
  const minClosed = safeNumber(options.minClosed, DEFAULT_MIN_CLOSED);
  const minParentClosed = safeNumber(options.minParentClosed, DEFAULT_MIN_PARENT_CLOSED);
  const minSubClosed = safeNumber(options.minSubClosed, DEFAULT_MIN_SUB_CLOSED);
  const minMicroClosed = safeNumber(options.minMicroClosed, DEFAULT_MIN_MICRO_CLOSED);

  const microAnalysis = buildMicroAnalysis(events, {
    minClosed,
    minParentClosed,
    minSubClosed,
    minMicroClosed,

    familyCountLong: 50,
    familyCountShort: 50,

    profile: "MAIN",
    mode: "MAIN"
  });

  if (!microAnalysis?.ok) {
    return {
      microAnalysis,
      bestMicroMain: {
        mode: "MAIN",
        ok: false,
        reason: microAnalysis?.error || "MICRO_ANALYSIS_NOT_AVAILABLE",
        bestLong: null,
        bestShort: null
      },
      mainDiscordAllowlist: []
    };
  }

  const bestFn = getBestMainLongShortFn();
  const allowlistFn = getAllowlistFn();

  const bestMicroMain =
    typeof bestFn === "function"
      ? bestFn(microAnalysis, {
          level: "micro",
          minClosed: minMicroClosed
        })
      : fallbackBestMainLongShort(microAnalysis, minMicroClosed);

  const mainDiscordAllowlist =
    typeof allowlistFn === "function"
      ? allowlistFn(microAnalysis, {
          level: "micro",
          minStatus: "STABLE"
        })
      : fallbackAllowlist(microAnalysis);

  return {
    microAnalysis,
    bestMicroMain,
    mainDiscordAllowlist
  };
}

function compactSourcePreview(events) {
  return safeArray(events)
    .slice(-MAX_DEBUG_EVENTS)
    .map(event => ({
      tradeId: getTradeId(event) || null,
      analyzeKind: event.analyzeKind || event.type || null,
      source: event.analyzeSource || null,
      symbol: event.symbol || null,
      side: normalizeSide(event.side || event.direction || event.tradeSide) || null,
      familyId: event.familyId || event.analyzeFamilyId || event.filterSnapshot?.familyId || null,
      closed: Boolean(event.closed),
      realizedR: event.realizedR ?? event.pnlR ?? event.resultR ?? null,
      pnlPct: event.pnlPct ?? event.realizedPnlPct ?? null,
      exitReason: event.exitReason || null,
      ts: getEventTs(event, null)
    }));
}

function countKinds(events) {
  const counts = {};

  for (const event of safeArray(events)) {
    const kind = normalizeText(event?.analyzeKind || event?.type || "UNKNOWN");
    counts[kind] = safeNumber(counts[kind], 0) + 1;
  }

  return counts;
}

function selectEvents({ storedEvents, latestEvents, sourceMode }) {
  if (sourceMode === "latest") {
    return {
      selectedEvents: latestEvents,
      selectedSource: "latest"
    };
  }

  if (sourceMode === "merged") {
    return {
      selectedEvents: dedupeEvents([...storedEvents, ...latestEvents]),
      selectedSource: "merged"
    };
  }

  return {
    selectedEvents: storedEvents,
    selectedSource: "stored"
  };
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const startedAt = Date.now();

  const debug = normalizeBoolean(req?.query?.debug, false);
  const reset = normalizeBoolean(req?.query?.reset, false);

  const includeLatest = normalizeBoolean(
    req?.query?.includeLatest,
    DEFAULT_INCLUDE_LATEST
  );

  const minClosed = safeNumber(req?.query?.minClosed, DEFAULT_MIN_CLOSED);

  const minParentClosed = safeNumber(
    req?.query?.minParentClosed,
    minClosed
  );

  const minSubClosed = safeNumber(
    req?.query?.minSubClosed,
    DEFAULT_MIN_SUB_CLOSED
  );

  const minMicroClosed = safeNumber(
    req?.query?.minMicroClosed,
    DEFAULT_MIN_MICRO_CLOSED
  );

  const sourceMode = String(req?.query?.source || "stored").toLowerCase().trim();
  const normalizedSourceMode = ["stored", "latest", "merged"].includes(sourceMode)
    ? sourceMode
    : "stored";

  try {
    if (reset) {
      const clearResult = await clearStoredEvents();

      return res.status(clearResult?.ok ? 200 : 500).json({
        ok: Boolean(clearResult?.ok),
        reset: true,
        clearResult,
        generatedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt
      });
    }

    const { store, events: storedEventsRaw } = await loadStoredEvents();

    const latest =
      includeLatest || normalizedSourceMode === "latest" || normalizedSourceMode === "merged"
        ? await getLatestScan().catch(error => ({
            ok: false,
            error: error?.message || String(error)
          }))
        : {
            ok: null,
            skipped: true,
            reason: "includeLatest=false"
          };

    const storedEvents = dedupeEvents(storedEventsRaw);

    const latestEvents =
      latest?.ok &&
      (includeLatest || normalizedSourceMode === "latest" || normalizedSourceMode === "merged")
        ? collectLatestEvents(latest)
        : [];

    const { selectedEvents, selectedSource } = selectEvents({
      storedEvents,
      latestEvents,
      sourceMode: normalizedSourceMode
    });

    const baseReport = buildReport(selectedEvents, {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50
    });

    const {
      microAnalysis,
      bestMicroMain,
      mainDiscordAllowlist
    } = buildMicroPayload(selectedEvents, {
      minClosed,
      minParentClosed,
      minSubClosed,
      minMicroClosed
    });

    const report = {
      ...safeObject(baseReport),

      microAnalysis,
      bestMicroMain,
      mainDiscordAllowlist,

      microConfig: {
        enabled: Boolean(microAnalysis?.ok),
        minParentClosed,
        minSubClosed,
        minMicroClosed,
        note: "Microfamilies gebruiken alleen entry-known velden. Outcome-data wordt alleen gebruikt voor ranking/statistiek."
      }
    };

    const response = {
      ok: true,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,

      mode: {
        source: selectedSource,
        includeLatest,
        minClosed,
        minParentClosed,
        minSubClosed,
        minMicroClosed,
        note:
          selectedSource === "stored"
            ? "Analyse gebruikt alleen opgeslagen analyse-records. Latest scan wordt niet meegeteld tenzij source=latest/merged of includeLatest=true."
            : "Analyse gebruikt debug/latest data. Gebruik source=stored voor echte family-statistiek."
      },

      sources: {
        selectedEvents: selectedEvents.length,
        storedEvents: storedEvents.length,
        latestEvents: latestEvents.length,
        storedKinds: countKinds(storedEvents),
        latestKinds: countKinds(latestEvents),
        selectedKinds: countKinds(selectedEvents),
        store,
        latest: {
          ok: latest?.ok ?? null,
          skipped: Boolean(latest?.skipped),
          reason: latest?.reason || null,
          updatedAt: latest?.updatedAt || null,
          tradeFunnelUpdatedAt: latest?.tradeFunnelUpdatedAt || null,
          error: latest?.error || null
        }
      },

      tradesLoaded: selectedEvents.length,

      // Top-level shortcuts voor frontend.
      microAnalysis,
      bestMicroMain,
      mainDiscordAllowlist,

      // Bestaande analyzer blijft onder report staan.
      report
    };

    if (debug) {
      response.debug = {
        storedPreview: compactSourcePreview(storedEvents),
        latestPreview: compactSourcePreview(latestEvents),
        selectedPreview: compactSourcePreview(selectedEvents)
      };
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("ANALYSE API ERROR:", error);

    return res.status(500).json({
      ok: false,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: serializeError(error, debug)
    });
  }
}