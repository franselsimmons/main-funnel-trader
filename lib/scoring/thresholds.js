// lib/scoring/thresholds.js
// Main + Moon thresholds + adaptive thresholds builder
//
// Exports:
// - BASE_THRESHOLDS
// - THRESHOLDS
// - buildAdaptiveThresholds
//
// Notes:
// - Adaptive thresholds respond to performance + regime
// - HEADWIND increases market threshold (stricter)
// - EXPANSION slightly relaxes timing (more momentum opportunities)

export const BASE_THRESHOLDS = {
  market: 45,
  timing: 60,
  quality: 60,
};

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * buildAdaptiveThresholds
 * performance: { winRate, drawdown } (optional)
 * regime: "EXPANSION"|"TREND"|"HEADWIND"|"CONTRACTION" (optional)
 */
export function buildAdaptiveThresholds({ performance, regime }) {
  const winRate = n(performance?.winRate, 50);
  const drawdown = n(performance?.drawdown, 0);

  let timing = BASE_THRESHOLDS.timing;
  let quality = BASE_THRESHOLDS.quality;
  let market = BASE_THRESHOLDS.market;

  // Losing streak / weak edge -> stricter
  if (winRate < 45) {
    timing += 4;
    quality += 5;
    market += 4;
  }
  if (winRate < 35) {
    timing += 3;
    quality += 4;
  }

  // High drawdown -> much stricter
  if (drawdown > 40) {
    timing += 6;
    quality += 6;
    market += 5;
  }
  if (drawdown > 55) {
    timing += 4;
    quality += 4;
  }

  // Strong edge -> slightly looser
  if (winRate > 60 && drawdown < 15) {
    timing -= 3;
    quality -= 3;
    market -= 2;
  }

  const reg = String(regime || "").toUpperCase();
  if (reg === "HEADWIND") market += 6;
  if (reg === "EXPANSION") timing -= 2;

  return {
    timing: clamp(timing, 58, 75),
    quality: clamp(quality, 60, 78),
    market: clamp(market, 45, 65),
  };
}

/**
 * Global thresholds used by scanners and UI.
 * Keep these stable; adaptive thresholds are computed on top.
 */
export const THRESHOLDS = {
  market: { current: BASE_THRESHOLDS.market, advised: 55 },
  timing: { current: BASE_THRESHOLDS.timing, advised: 65 },
  quality: { current: BASE_THRESHOLDS.quality, advised: 68 },
  btcAlignment: { current: 50, advised: 55 },

  // Exit behavior (used by trade manager / UI)
  exit: {
    giveback: 1.5, // percent points giveback before soft exit (if you add trailing logic)
  },

  // MAIN system thresholds
  main: {
    // Top-level shortlist gating
    perfectCandidate: 76,
    qualityScore: 68,
    timingScore: 71,
    liquidityScore: 66,
    marketScore: 56,
    btcAlignmentScore: 55,

    // Entry readiness gates (used in scan state-machine)
    entryReady: {
      perfectCandidate: 70,
      qualityScore: 62,
      timingScore: 64,
      liquidityScore: 58,
      marketScore: 44,
      breakoutPressure: 54,
    },

    // WATCH setup gating (pre-entry)
    nearEntryWatch: {
      entryQuality: 70,
      persistenceScore: 60,
      breakoutPressure: 63,
      obScore: 0.01,
    },

    // Watch-to-open stabilization
    stableWatch: {
      entryQuality: 64,
      persistence: 56,
      breakoutPressure: 59,
    },

    // Execution-quality guidance (optional)
    execution: {
      entryQuality: 68,
      persistence: 60,
      breakoutPressure: 63,
    },

    // Optional: make execution decisions more strict for non-elite
    executionScore: {
      eliteOpen: 62,
      almostOpen: 60,
    },

    // Super scanner bucket (premium list)
    superScanner: {
      perfectCandidate: 74,
      qualityScore: 68,
    },

    // Micro-filters
    filters: {
      obScore: 0.008,
      spread: 0.9,
    },
  },

  // MOON system thresholds (kept here for symmetry, used in moon repo later)
  moon: {
    perfectCandidate: 72,
    qualityScore: 68,
    timingScore: 67,
    liquidityScore: 62,
    marketScore: 52,
    btcAlignmentScore: 55,

    entryReady: {
      perfectCandidate: 66,
      qualityScore: 58,
      timingScore: 60,
      liquidityScore: 54,
      marketScore: 40,
      breakoutPressure: 52,
    },

    nearEntryWatch: {
      entryQuality: 66,
      persistenceScore: 56,
      breakoutPressure: 61,
      obScore: 0.008,
    },

    stableWatch: {
      entryQuality: 60,
      persistence: 52,
      breakoutPressure: 57,
    },

    execution: {
      entryQuality: 64,
      persistence: 56,
      breakoutPressure: 61,
    },

    executionScore: {
      eliteOpen: 58,
      almostOpen: 56,
    },

    superScanner: {
      perfectCandidate: 72,
      qualityScore: 68,
    },

    filters: {
      obScore: 0.008,
      spread: 0.8,
    },
  },
};