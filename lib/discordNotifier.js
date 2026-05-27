// ================= TRADE SYSTEM DISCORD NOTIFIER =================

const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_TRADE_A || process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_TRADE_B || process.env.DISCORD_WEBHOOK_B || WEBHOOK_A || "").trim();
const WEBHOOK_C = String(process.env.DISCORD_WEBHOOK_TRADE_C || process.env.DISCORD_WEBHOOK_C || WEBHOOK_B || WEBHOOK_A || "").trim();

const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System";
const MAX_RETRIES = 3;
const COOLDOWN_MINUTES = Number(process.env.TRADE_SIGNAL_COOLDOWN_MINUTES || 25);

const FIELD_VALUE_LIMIT = 1024;
const JSON_CHUNK_LIMIT = 900;
const MAX_JSON_FIELDS = 2;

const recentSignals = new Map();

// ================= BASIC HELPERS =================

function toUpperText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toUpperCase();
}

function toText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function compactNumber(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

function compactPrice(value) {
  const text = compactNumber(value, 6);
  return text === "N/A" ? "N/A" : `$\`${text}\``;
}

function compactPct(value, decimals = 2) {
  const text = compactNumber(value, decimals);
  return text === "N/A" ? "N/A" : `${text}%`;
}

function compactR(value, decimals = 2) {
  const text = compactNumber(value, decimals);
  return text === "N/A" ? "N/A" : `${text}R`;
}

function compactBpsFromSpread(spreadPct) {
  const spread = normalizeSpread(spreadPct);
  return compactNumber(spread * 10000, 2);
}

function boolText(value) {
  if (value === undefined || value === null) return "N/A";
  return Boolean(value) ? "YES" : "NO";
}

function normalizeSide(side) {
  const s = String(side || "").trim().toLowerCase();
  if (["bear", "short", "sell", "bearish"].includes(s)) return "SHORT";
  return "LONG";
}

function normalizeGrade(value) {
  const raw = String(value || "").toUpperCase();

  if (["GOD", "A", "A_SHORT_EXCEPTION"].includes(raw)) return "A";
  if (["B", "B_TREND_PROBE", "BULLISH_MID_TREND_PROBE"].includes(raw)) return "B";
  if (raw === "C") return "C";

  if (raw.includes("GOD")) return "A";
  if (raw.startsWith("A")) return "A";
  if (raw.startsWith("B")) return "B";

  return "C";
}

function getTradeGrade(t) {
  return normalizeGrade(t?.liveGrade || t?.setupClass || t?.grade);
}

function getSetupClass(t) {
  return toUpperText(t?.setupClass || t?.discordMetrics?.setup?.setupClass || t?.discordEntryMetrics?.setup?.setupClass, "UNKNOWN");
}

function getWebhook(grade) {
  if (grade === "A") return WEBHOOK_A;
  if (grade === "B") return WEBHOOK_B;
  return WEBHOOK_C;
}

function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);

  if (!Number.isFinite(s) || s < 0) return 0;
  if (s > 0.05) s = s / 100;

  return s;
}

// Keep original structure for stability
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function truncateText(value, max = FIELD_VALUE_LIMIT) {
  const text = String(value ?? "");

  if (text.length <= max) return text;
  if (max <= 10) return text.slice(0, max);

  return `${text.slice(0, max - 3)}...`;
}

function truncateMiddle(value, max = FIELD_VALUE_LIMIT) {
  const text = String(value ?? "");

  if (text.length <= max) return text;
  if (max <= 20) return truncateText(text, max);

  const half = Math.floor((max - 3) / 2);
  return `${text.slice(0, half)}...${text.slice(-half)}`;
}

function makeField(name, value, inline = false) {
  if (value === undefined || value === null || value === "") return null;
  if (value === "N/A" || value === "$`N/A`") return null;

  return {
    name: truncateText(name, 256),
    value: truncateText(String(value), FIELD_VALUE_LIMIT),
    inline
  };
}

function makeKv(rows) {
  return rows
    .filter(row => Array.isArray(row) && row.length >= 2)
    .filter(([, value]) => value !== undefined && value !== null && value !== "" && value !== "N/A" && value !== "$`N/A`")
    .map(([key, value]) => `**${key}:** ${value}`)
    .join("\n");
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ================= BUCKET HELPERS =================

function cleanBucketText(value) {
  return String(value)
    .replace(/\./g, "p")
    .replace(/-/g, "m")
    .replace(/\s+/g, "_")
    .toUpperCase();
}

function bucketByStep(value, step, label, decimals = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) return `${label}_NA`;

  const lower = Math.floor(n / step) * step;
  const upper = lower + step;

  return cleanBucketText(`${label}_${lower.toFixed(decimals)}_${upper.toFixed(decimals)}`);
}

function bucketDepthUsd(depth) {
  const d = Number(depth || 0);

  if (d < 10000) return "DEPTH_LT_10K";
  if (d < 50000) return "DEPTH_10K_50K";
  if (d < 100000) return "DEPTH_50K_100K";
  if (d < 200000) return "DEPTH_100K_200K";
  if (d < 500000) return "DEPTH_200K_500K";

  return "DEPTH_GT_500K";
}

function bucketSpreadPct(spreadPct) {
  const bps = normalizeSpread(spreadPct) * 10000;

  if (bps < 8) return "SPREAD_LT_8BPS";
  if (bps < 12) return "SPREAD_8_12BPS";
  if (bps < 16) return "SPREAD_12_16BPS";
  if (bps < 22) return "SPREAD_16_22BPS";
  if (bps < 30) return "SPREAD_22_30BPS";

  return "SPREAD_GT_30BPS";
}

function bucketFunding(rate) {
  const r = Number(rate || 0);

  if (r <= -0.015) return "FUNDING_NEG_EXTREME";
  if (r <= -0.008) return "FUNDING_NEG_HIGH";
  if (r < -0.002) return "FUNDING_NEG";
  if (r <= 0.002) return "FUNDING_NEUTRAL";
  if (r < 0.008) return "FUNDING_POS";
  if (r < 0.015) return "FUNDING_POS_HIGH";

  return "FUNDING_POS_EXTREME";
}

function getObSideRelation(side, obBias) {
  const s = String(side || "").toLowerCase();
  const ob = String(obBias || "NEUTRAL").toUpperCase();

  if (ob === "NEUTRAL" || ob === "UNKNOWN") return "NEUTRAL";

  if (
    (s === "bull" && ob === "BULLISH") ||
    (s === "bear" && ob === "BEARISH") ||
    (s === "long" && ob === "BULLISH") ||
    (s === "short" && ob === "BEARISH")
  ) {
    return "WITH";
  }

  if (
    (s === "bull" && ob === "BEARISH") ||
    (s === "bear" && ob === "BULLISH") ||
    (s === "long" && ob === "BEARISH") ||
    (s === "short" && ob === "BULLISH")
  ) {
    return "AGAINST";
  }

  return "NEUTRAL";
}

// ================= JSON / ANALYTICS HELPERS =================

function safeJsonStringify(value) {
  const seen = new WeakSet();

  try {
    return JSON.stringify(value, (key, item) => {
      if (typeof item === "function") return undefined;

      if (typeof item === "number") {
        if (!Number.isFinite(item)) return null;
        return Number(Number(item).toFixed(6));
      }

      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }

      return item;
    });
  } catch {
    return "{}";
  }
}

function sanitizeCodeBlock(text) {
  return String(text || "").replace(/```/g, "'''");
}

function chunkText(text, size = JSON_CHUNK_LIMIT) {
  const clean = String(text || "");
  const chunks = [];

  for (let i = 0; i < clean.length; i += size) {
    chunks.push(clean.slice(i, i + size));
  }

  return chunks.length ? chunks : [""];
}

function jsonBlockFromText(text) {
  const clean = sanitizeCodeBlock(text);
  return `\`\`\`json\n${truncateText(clean, JSON_CHUNK_LIMIT)}\n\`\`\``;
}

function makeJsonFields(name, value, maxFields = MAX_JSON_FIELDS) {
  if (!value || typeof value !== "object") return [];

  const text = safeJsonStringify(value);
  if (!text || text === "{}") return [];

  return chunkText(text, JSON_CHUNK_LIMIT)
    .slice(0, maxFields)
    .map((chunk, index, arr) => {
      const label = arr.length > 1 ? `${name} ${index + 1}/${arr.length}` : name;
      return makeField(label, jsonBlockFromText(chunk), false);
    })
    .filter(Boolean);
}

// ================= METRICS NORMALIZATION =================

function buildFallbackCohortKey(metrics) {
  return [
    `SETUP=${String(metrics?.setup?.setupClass || "NA").toUpperCase()}`,
    `SIDE=${String(metrics?.side || "NA").toLowerCase()}`,
    `REASON=${String(metrics?.setup?.entryReason || "NA").toUpperCase()}`,
    `RSI=${String(metrics?.rsi?.rsiZone || "NA").toUpperCase()}`,
    `EDGE=${String(metrics?.rsi?.rsiEdge || "NA").toUpperCase()}`,
    `FLOW=${String(metrics?.market?.flow || "NA").toUpperCase()}`,
    `BTC=${String(metrics?.market?.btcState || "NA").toUpperCase()}`,
    `OB=${String(metrics?.ob?.relation || "NA").toUpperCase()}`,
    bucketByStep(metrics?.scores?.confluence, 5, "CONF", 0),
    bucketByStep(metrics?.scores?.sniperScore, 5, "SNIPER", 0),
    bucketByStep(metrics?.rr?.finalRr, 0.25, "RR", 2),
    bucketSpreadPct(metrics?.ob?.spreadPct),
    bucketDepthUsd(metrics?.ob?.depthMinUsd1p)
  ].join("|");
}

function normalizeEntryMetrics(t) {
  const m = t?.discordMetrics && typeof t.discordMetrics === "object"
    ? t.discordMetrics
    : {};

  const fd = t?.filterDiagnostics || {};
  const live = t?.liveFilterMetrics || fd.liveMetrics || {};

  const setupClass = toUpperText(
    m?.setup?.setupClass ||
    t?.setupClass ||
    live?.setupClass,
    "UNKNOWN"
  );

  const entryReason = toUpperText(
    m?.setup?.entryReason ||
    t?.entryReason ||
    t?.entryType ||
    t?.reason ||
    live?.entryReason,
    "UNKNOWN"
  );

  const side = String(t?.side || live?.side || "").toLowerCase();
  const obBias = toUpperText(m?.ob?.bias || t?.obBias || live?.obBias, "NEUTRAL");
  const spreadPct = normalizeSpread(m?.ob?.spreadPct ?? t?.spreadPct ?? live?.spreadPct);
  const depthMinUsd1p = safeNumber(m?.ob?.depthMinUsd1p ?? t?.depthMinUsd1p ?? live?.depthMinUsd1p, 0);
  const obRelation = toUpperText(
    m?.ob?.relation || getObSideRelation(side, obBias),
    "NEUTRAL"
  );

  const metrics = {
    v: m.v || "DS_METRICS_V1",
    tradeId: m.tradeId || t?.tradeId || null,
    cohortKey: m.cohortKey || t?.cohortKey || null,

    side,

    setup: {
      setupClass,
      entryReason,
      grade: m?.setup?.grade || t?.grade || live?.grade || getTradeGrade(t),
      gradePoints: safeNumber(m?.setup?.gradePoints ?? t?.gradePoints ?? live?.gradePoints, 0)
    },

    scores: {
      score: safeNumber(m?.scores?.score ?? t?.score ?? live?.score, 0),
      confluence: safeNumber(m?.scores?.confluence ?? t?.confluence ?? live?.confluence, 0),
      rawConfluence: safeNumber(m?.scores?.rawConfluence ?? t?.rawConfluence ?? live?.rawConfluence, 0),
      sniperScore: safeNumber(m?.scores?.sniperScore ?? t?.sniperScore ?? live?.sniperScore, 0),
      rawSniperScore: safeNumber(m?.scores?.rawSniperScore ?? t?.rawSniperScore ?? live?.rawSniperScore, 0),
      fallbackSniperScore: safeNumber(m?.scores?.fallbackSniperScore ?? t?.fallbackSniperScore ?? live?.fallbackSniperScore, 0)
    },

    rr: {
      baseRR: safeNumber(m?.rr?.baseRR ?? t?.baseRR ?? live?.baseRR, 0),
      finalRr: safeNumber(m?.rr?.finalRr ?? t?.finalRr ?? t?.plannedRR ?? t?.rr ?? live?.finalRr, 0),
      requiredRR: safeNumber(m?.rr?.requiredRR ?? t?.requiredRR ?? t?.requiredRRFinal ?? live?.requiredRR, 0),
      finalRequiredRR: safeNumber(m?.rr?.finalRequiredRR ?? t?.finalRequiredRR ?? live?.finalRequiredRR, 0),
      tpRewardMultiplier: safeNumber(m?.rr?.tpRewardMultiplier ?? t?.tpRewardMultiplier ?? live?.tpRewardMultiplier, 1)
    },

    price: {
      entry: safeNumber(m?.price?.entry ?? t?.entry ?? live?.entry, 0),
      sl: safeNumber(m?.price?.sl ?? t?.sl ?? live?.sl, 0),
      tp: safeNumber(m?.price?.tp ?? t?.tp ?? live?.tp, 0)
    },

    rsi: {
      rsi: safeNumber(m?.rsi?.rsi ?? t?.rsi ?? live?.rsi, 0),
      rsiHTF: safeNumber(m?.rsi?.rsiHTF ?? t?.rsiHTF ?? live?.rsiHTF, 0),
      rsiZone: toUpperText(m?.rsi?.rsiZone || t?.rsiZone || live?.rsiZone, "UNKNOWN"),
      rsiEdge: toUpperText(m?.rsi?.rsiEdge || t?.rsiEdge || live?.rsiEdge, "UNKNOWN"),
      rsiEdgeRank: safeNumber(m?.rsi?.rsiEdgeRank ?? t?.rsiEdgeRank ?? live?.rsiEdgeRank, 0),
      continuationOk: Boolean(m?.rsi?.continuationOk ?? t?.rsiContinuationOk ?? live?.rsiContinuationOk),
      continuationScore: safeNumber(m?.rsi?.continuationScore ?? t?.rsiContinuationScore ?? live?.rsiContinuationScore, 0),
      slope3: safeNumber(m?.rsi?.slope3 ?? t?.slope3 ?? live?.slope3, 0),
      confBonus: safeNumber(m?.rsi?.confBonus ?? t?.rsiConfluenceBonus ?? live?.rsiConfluenceBonus, 0),
      rrDiscount: safeNumber(m?.rsi?.rrDiscount ?? t?.rsiRrDiscount ?? live?.rsiRrDiscount, 0),
      sniperDiscount: safeNumber(m?.rsi?.sniperDiscount ?? t?.rsiSniperDiscount ?? live?.rsiSniperDiscount, 0)
    },

    market: {
      btcState: toUpperText(m?.market?.btcState || t?.btcState || live?.btcState, "UNKNOWN"),
      regime: toUpperText(m?.market?.regime || t?.regime || live?.regime, "UNKNOWN"),
      flow: toUpperText(m?.market?.flow || t?.flow || live?.flow, "UNKNOWN"),
      tfStrength: safeNumber(m?.market?.tfStrength ?? t?.tfStrength ?? live?.tfStrength, 0),
      tfAlignment: toUpperText(m?.market?.tfAlignment || t?.tfAlignment || live?.tfAlignment, "UNKNOWN"),
      change1h: safeNumber(m?.market?.change1h ?? t?.change1h ?? live?.change1h, 0),
      change24: safeNumber(m?.market?.change24 ?? t?.change24 ?? live?.change24, 0),
      funding: safeNumber(m?.market?.funding ?? t?.funding ?? live?.funding, 0),
      fundingBucket: m?.market?.fundingBucket || bucketFunding(m?.market?.funding ?? t?.funding ?? live?.funding)
    },

    ob: {
      bias: obBias,
      relation: obRelation,
      spreadPct,
      spreadBps: safeNumber(m?.ob?.spreadBps ?? spreadPct * 10000, 0),
      spreadBucket: m?.ob?.spreadBucket || bucketSpreadPct(spreadPct),
      maxSpreadAllowed: safeNumber(m?.ob?.maxSpreadAllowed ?? t?.maxSpreadAllowed ?? live?.maxSpreadAllowed, 0),
      depthMinUsd1p,
      depthBucket: m?.ob?.depthBucket || bucketDepthUsd(depthMinUsd1p),
      spoof: Boolean(m?.ob?.spoof ?? t?.spoof ?? live?.spoof)
    },

    structure: {
      pullbackConfirmed: Boolean(m?.structure?.pullbackConfirmed ?? t?.pullbackConfirmed),
      sweepConfirmed: Boolean(m?.structure?.sweepConfirmed ?? t?.sweepConfirmed),
      retestConfirmed: Boolean(m?.structure?.retestConfirmed ?? t?.retestConfirmed),
      distanceFromLocalHighPct: safeNumber(m?.structure?.distanceFromLocalHighPct ?? t?.distanceFromLocalHighPct, 0)
    },

    gates: {
      qualityGateReason: m?.gates?.qualityGateReason || t?.qualityGateReason || fd?.passMap?.qualityGate?.reason || "UNKNOWN",
      finalDepthReason: m?.gates?.finalDepthReason || t?.finalDepthReason || fd?.passMap?.depth?.reason || "OK",
      confirmationRequired: Boolean(m?.gates?.confirmationRequired ?? t?.confirmationRequired),
      confirmationSeen: Boolean(m?.gates?.confirmationSeen ?? t?.confirmationSeen)
    }
  };

  if (!metrics.cohortKey) {
    metrics.cohortKey = buildFallbackCohortKey(metrics);
  }

  return metrics;
}

function normalizeExitMetrics(t) {
  const m = t?.discordOutcomeMetrics && typeof t.discordOutcomeMetrics === "object"
    ? t.discordOutcomeMetrics
    : {};

  return {
    v: m.v || "DS_OUTCOME_V1",
    tradeId: m.tradeId || t?.tradeId || null,
    cohortKey: m.cohortKey || t?.cohortKey || null,

    outcome: {
      exitReason: toUpperText(m?.outcome?.exitReason || t?.reason || t?.exitReason, "EXIT"),
      exitR: safeNumber(m?.outcome?.exitR ?? t?.exitR, 0),
      pnlPct: safeNumber(m?.outcome?.pnlPct ?? t?.pnlPct, 0),
      triggerR: safeNumber(m?.outcome?.triggerR ?? t?.triggerR, 0),
      triggerPnlPct: safeNumber(m?.outcome?.triggerPnlPct ?? t?.triggerPnlPct, 0),
      holdMinutes: safeNumber(m?.outcome?.holdMinutes ?? t?.holdMinutes, 0)
    },

    path: {
      mfeR: safeNumber(m?.path?.mfeR ?? t?.mfeR, 0),
      maeR: safeNumber(m?.path?.maeR ?? t?.maeR, 0),
      currentR: safeNumber(m?.path?.currentR ?? t?.currentR, 0),
      maxTpProgress: safeNumber(m?.path?.maxTpProgress ?? t?.maxTpProgress, 0),
      maxSlProgress: safeNumber(m?.path?.maxSlProgress ?? t?.maxSlProgress, 0),
      reachedHalfR: Boolean(m?.path?.reachedHalfR ?? t?.reachedHalfR),
      reachedOneR: Boolean(m?.path?.reachedOneR ?? t?.reachedOneR),
      nearTpSeen: Boolean(m?.path?.nearTpSeen ?? t?.nearTpSeen),
      directToSL: Boolean(m?.path?.directToSL ?? t?.directToSL),
      slAfterHalfR: Boolean(m?.path?.slAfterHalfR ?? t?.slAfterHalfR),
      slAfterOneR: Boolean(m?.path?.slAfterOneR ?? t?.slAfterOneR),
      slAfterNearTp: Boolean(m?.path?.slAfterNearTp ?? t?.slAfterNearTp)
    },

    be: {
      breakEvenActivated: Boolean(m?.be?.breakEvenActivated ?? t?.breakEvenActivated),
      breakEvenStop: Boolean(m?.be?.breakEvenStop ?? t?.breakEvenStop),
      breakEvenSl: m?.be?.breakEvenSl ?? t?.breakEvenSl ?? null
    }
  };
}

function buildCompactEntrySnapshotForExit(t) {
  const m = t?.discordEntryMetrics || t?.discordMetrics;

  if (!m || typeof m !== "object") return null;

  return {
    v: m.v || "DS_METRICS_V1",
    tradeId: m.tradeId || t?.tradeId || null,
    cohortKey: m.cohortKey || t?.cohortKey || null,
    setup: m.setup || null,
    scores: m.scores || null,
    rr: m.rr || null,
    rsi: m.rsi || null,
    market: m.market || null,
    ob: m.ob || null,
    structure: m.structure || null,
    gates: m.gates || null
  };
}

// ================= COOLDOWN =================

function buildSignalKey(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  const setupClass = getSetupClass(t);
  const reason = toUpperText(t?.entryReason || t?.entryType || t?.reason, "ENTRY");
  const entry = compactNumber(t?.entry || t?.discordMetrics?.price?.entry, 8);

  return (
    t?.tradeId ||
    t?.discordMetrics?.tradeId ||
    `${symbol}_${side}_${setupClass}_${reason}_${entry}`
  );
}

function pruneRecentSignals(now, cooldownMs) {
  const maxAge = Math.max(cooldownMs * 4, 60 * 60 * 1000);

  for (const [key, ts] of recentSignals.entries()) {
    if (now - Number(ts || 0) > maxAge) {
      recentSignals.delete(key);
    }
  }
}

// ================= DISCORD SEND LOGIC =================

async function sendMessage(webhook, message) {
  if (!webhook || !fetchFn) {
    return {
      ok: false,
      discordSent: false,
      reason: !webhook ? "WEBHOOK_MISSING" : "FETCH_MISSING"
    };
  }

  const safeMessage = {
    allowed_mentions: { parse: [] },
    ...message
  };

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(safeMessage)
      });

      if (res.ok) {
        return {
          ok: true,
          discordSent: true,
          status: res.status
        };
      }

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        await sleep(Math.ceil(Number(data?.retry_after || 1.5) * 1000));
        continue;
      }

      const text = await res.text().catch(() => "");

      console.error("TRADE DISCORD NON_OK:", JSON.stringify({
        status: res.status,
        statusText: res.statusText,
        response: text.slice(0, 500)
      }));
    } catch (e) {
      console.error("TRADE DISCORD ERROR:", e.message);
    }

    await sleep(1000 * i);
  }

  return {
    ok: false,
    discordSent: false
  };
}

// ================= ENTRY EMBED (KORT & DUIDELIJK) =================

function buildEntryEmbed(t) {
  const metrics = normalizeEntryMetrics(t);

  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  const setupClass = metrics.setup.setupClass;
  const color = side === "LONG" ? 0x00ff99 : 0xff4444;

  const entryPrice = compactPrice(t?.entry || metrics.price.entry);
  const tpPrice = compactPrice(t?.tp || metrics.price.tp);
  const slPrice = compactPrice(t?.sl || metrics.price.sl);

  const fields = [
    makeField("Prijzen", makeKv([
      ["Entry", entryPrice],
      ["Take Profit", tpPrice],
      ["Stop Loss", slPrice]
    ]), true),

    makeField("Setup Info", makeKv([
      ["Grade", getTradeGrade(t)],
      ["Type", setupClass]
    ]), true)
  ].filter(Boolean);

  return {
    title: `🟢 ENTRY: ${symbol} ${side}`,
    color,
    fields,
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
}

// ================= EXIT EMBED (KORT & DUIDELIJK) =================

function buildExitEmbed(t) {
  const metrics = normalizeExitMetrics(t);

  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  const reason = metrics.outcome.exitReason;

  let status = "GESLOTEN";
  let color = 0x3498db;

  if (reason.includes("BE") || reason.includes("BREAK_EVEN")) {
    status = "BREAK EVEN";
    color = 0xf1c40f;
  } else if (reason.includes("TP") || reason.includes("TAKE_PROFIT")) {
    status = "TP GERAAKT";
    color = 0x2ecc71;
  } else if (reason.includes("SL") || reason.includes("STOP_LOSS")) {
    status = "SL GERAAKT";
    color = 0xe74c3c;
  }

  const fields = [
    makeField("Resultaat", makeKv([
      ["Winst/Verlies", compactPct(metrics.outcome.pnlPct, 2)],
      ["Exit Reden", reason],
      ["Duur", `${compactNumber(metrics.outcome.holdMinutes, 0)} minuten`]
    ]), true),

    makeField("Prijzen", makeKv([
      ["Entry", compactPrice(t?.entry)],
      ["Exit", compactPrice(t?.exit || t?.executionPrice)]
    ]), true)
  ].filter(Boolean);

  return {
    title: `🔴 EXIT: ${symbol} ${side} | ${status}`,
    color,
    fields,
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
}

// ================= MAIN FUNCTIONS =================

export async function sendEntry(t) {
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);

  const key = buildSignalKey(t);
  const now = Date.now();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

  pruneRecentSignals(now, cooldownMs);

  if (recentSignals.has(key) && (now - recentSignals.get(key)) < cooldownMs) {
    return {
      ok: true,
      discordSent: false,
      skipped: true,
      reason: "COOLDOWN",
      key
    };
  }

  const embed = buildEntryEmbed(t);
  const result = await sendMessage(webhook, { embeds: [embed] });

  if (result.discordSent) {
    recentSignals.set(key, now);
  }

  return {
    ...result,
    symbol: t?.symbol,
    grade,
    key
  };
}

export async function sendExit(t) {
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);

  const embed = buildExitEmbed(t);
  const result = await sendMessage(webhook, { embeds: [embed] });

  return {
    ...result,
    symbol: t?.symbol,
    grade,
    tradeId: t?.tradeId || t?.discordOutcomeMetrics?.tradeId || null,
    cohortKey: t?.cohortKey || t?.discordOutcomeMetrics?.cohortKey || null
  };
}

export function clearDiscordCooldowns() {
  recentSignals.clear();

  return {
    ok: true,
    cleared: true
  };
}
