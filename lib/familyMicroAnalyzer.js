// lib/familyMicroAnalyzer.js

const UNKNOWN = "UNKNOWN";

function cleanToken(value, fallback = UNKNOWN) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;

  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;
}

function normalizeSide(value) {
  const raw = String(value ?? "").toLowerCase();

  if (["long", "bull", "buy", "bullish"].includes(raw)) return "LONG";
  if (["short", "bear", "sell", "bearish"].includes(raw)) return "SHORT";

  return UNKNOWN;
}

function normalizeStage(value) {
  const raw = String(value ?? "").toLowerCase();

  if (raw.includes("exit") || raw === "close") return "EXIT";
  if (raw.includes("almost")) return "ALMOST";
  if (raw.includes("entry") || raw === "open") return "ENTRY";

  return "ENTRY";
}

function normalizeSetupClass(value) {
  const token = cleanToken(value, "B");

  if (token.includes("TREND_PROBE")) return "B_TREND_PROBE";
  if (token === "A" || token.includes("_A_")) return "A";
  if (token === "B" || token.includes("_B_")) return "B";
  if (token === "C" || token.includes("_C_")) return "C";

  return token;
}

function normalizeReason(value, setupClass = "B") {
  const token = cleanToken(value, "");

  if (token) return token;
  if (setupClass === "A") return "A_ENTRY";
  if (setupClass === "B") return "B_ENTRY";
  if (setupClass === "C") return "C_ENTRY";
  if (setupClass === "B_TREND_PROBE") return "BULLISH_MID_TREND_PROBE";

  return "ENTRY";
}

function normalizeRsiEdge(value, rsi, side) {
  const direct = cleanToken(value, "");

  if (
    direct === "RSI_CONTINUATION" ||
    direct === "RSI_AGAINST" ||
    direct === "RSI_NEUTRAL"
  ) {
    return direct;
  }

  const n = Number(rsi);
  if (!Number.isFinite(n)) return "RSI_NEUTRAL";

  if (side === "LONG") {
    if (n >= 55) return "RSI_CONTINUATION";
    if (n <= 45) return "RSI_AGAINST";
    return "RSI_NEUTRAL";
  }

  if (side === "SHORT") {
    if (n <= 45) return "RSI_CONTINUATION";
    if (n >= 55) return "RSI_AGAINST";
    return "RSI_NEUTRAL";
  }

  return "RSI_NEUTRAL";
}

function normalizeRsiBias(value, rsiHTF, side) {
  const direct = cleanToken(value, "");

  if (["BULLISH", "BEARISH", "NEUTRAL"].includes(direct)) return direct;

  const n = Number(rsiHTF);
  if (!Number.isFinite(n)) return "NEUTRAL";

  if (n >= 57) return "BULLISH";
  if (n <= 43) return "BEARISH";

  return "NEUTRAL";
}

export function buildMicroFamilyId({
  side,
  setupClass,
  scannerStage,
  reason,
  rsiEdge,
  rsiBias
} = {}) {
  const s = cleanToken(side);
  const setup = cleanToken(setupClass);
  const stage = cleanToken(scannerStage);
  const why = cleanToken(reason);
  const edge = cleanToken(rsiEdge);
  const bias = cleanToken(rsiBias);

  return `MF_${s}_${setup}_${stage}_${why}_${edge}_${bias}`;
}

export function buildRotationId({ weekKey, side, setupClass } = {}) {
  return `ROT_${cleanToken(weekKey)}_${cleanToken(side)}_${cleanToken(setupClass)}`;
}

export function classifyAnalyzeEvent(event = {}, opts = {}) {
  const weekKey = opts.weekKey || event.weekKey || event.activeWeekKey || null;

  const side = normalizeSide(
    event.side ??
      event.direction ??
      event.tradeSide ??
      event.signalSide ??
      event.bias
  );

  const scannerStage = normalizeStage(
    event.scannerStage ??
      event.stage ??
      event.actionType ??
      event.action ??
      event.type
  );

  const setupClass = normalizeSetupClass(
    event.setupClass ??
      event.class ??
      event.entryClass ??
      event.signalClass
  );

  const reason = normalizeReason(
    event.reason ??
      event.entryReason ??
      event.signalReason ??
      event.waitReason,
    setupClass
  );

  const rsi = event.rsi ?? event.rsiValue ?? event.rsi14 ?? event.rsiLtf;
  const rsiHTF = event.rsiHTF ?? event.htfRsi ?? event.rsiHigherTimeframe ?? rsi;

  const rsiEdge = normalizeRsiEdge(
    event.rsiEdge ?? event.microRsiEdge ?? event.rsiSignal,
    rsi,
    side
  );

  const rsiBias = normalizeRsiBias(
    event.rsiBias ?? event.rsiHTFBias ?? event.htfBias,
    rsiHTF,
    side
  );

  const microFamilyId =
    cleanToken(event.microFamilyId, "") ||
    buildMicroFamilyId({
      side,
      setupClass,
      scannerStage,
      reason,
      rsiEdge,
      rsiBias
    });

  const rotationId = buildRotationId({
    weekKey: weekKey || "NO_WEEK",
    side,
    setupClass
  });

  return {
    ok: side !== UNKNOWN,
    side,
    scannerStage,
    setupClass,
    reason,
    rsiEdge,
    rsiBias,
    microFamilyId,
    rotationId,
    parentFamilyId: `PF_${side}_${setupClass}_${scannerStage}`,
    symbol: event.symbol ?? event.baseCoin ?? event.instId ?? null
  };
}

export default classifyAnalyzeEvent;
