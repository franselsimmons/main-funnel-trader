const DEFAULT_CONFIG = {
  lookbackDays: 7,

  // Minimum sample per microfamily
  minClosed: 6,

  // Hard quality floors
  minAvgR: 0.05,
  minProfitFactor: 1.15,

  // Per side
  maxPerSide: 3,

  // Anti-overfit
  preferStableStatus: true,
  rejectBadStatus: true,

  // PF caps voorkomen fake 999 PF dominance bij 0 losses
  pfCap: 8,

  // Belangrijk:
  // true = hoogste winrate wint, daarna sample/avgR/PF.
  // false = weighted selectorScore wint.
  winrateFirst: true,

  // Score weights blijven bestaan als fallback/tie-breaker
  weights: {
    avgR: 45,
    winrate: 25,
    pf: 15,
    sample: 10,
    stability: 5,
  },
};

const GOOD_STATUSES = new Set(['ELITE', 'HOT', 'GOOD', 'STABLE', 'CANDIDATE']);
const BAD_STATUSES = new Set(['BAD', 'EMPTY']);

function asNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  const cleaned = String(value)
    .replace('%', '')
    .replace(',', '.')
    .trim();

  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;

  return String(value).trim();
}

function normalizeSide(value) {
  const side = asString(value).toUpperCase();

  if (side.includes('LONG')) return 'LONG';
  if (side.includes('BULL')) return 'LONG';
  if (side.includes('BUY')) return 'LONG';

  if (side.includes('SHORT')) return 'SHORT';
  if (side.includes('BEAR')) return 'SHORT';
  if (side.includes('SELL')) return 'SHORT';

  return null;
}

function normalizeStatus(value) {
  return asString(value, 'COLLECTING').toUpperCase();
}

function normalizeWinrate(value) {
  const raw = asNumber(value, 0);

  if (raw > 1) return raw / 100;

  return raw;
}

function normalizePf(value, pfCap) {
  const pf = asNumber(value, 0);

  if (pf >= 999) return pfCap;
  if (pf < 0) return 0;

  return Math.min(pf, pfCap);
}

function pickFirst(record, keys, fallback = undefined) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null) return record[key];
  }

  return fallback;
}

function normalizeDefinition(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean).join(' | ');
  }

  if (value && typeof value === 'object') {
    return Object.values(value).map(item => String(item).trim()).filter(Boolean).join(' | ');
  }

  return asString(value);
}

export function normalizeMicroFamilyRow(row = {}, config = DEFAULT_CONFIG) {
  const familyId = asString(
    pickFirst(row, [
      'family',
      'FAMILY',
      'familyId',
      'microFamilyId',
      'microFamily',
      'id',
      'key',
    ])
  );

  const side = normalizeSide(
    pickFirst(row, [
      'side',
      'SIDE',
      'direction',
      'tradeSide',
    ])
  );

  const parent = asString(
    pickFirst(row, [
      'parent',
      'PARENT',
      'parentFamily',
      'parentFamilyId',
    ])
  );

  const status = normalizeStatus(
    pickFirst(row, [
      'status',
      'STATUS',
      'qualityStatus',
    ])
  );

  const closed = asNumber(
    pickFirst(row, [
      'closed',
      'CLOSED',
      'closedTrades',
      'nClosed',
      'completed',
      'completedTrades',
    ])
  );

  const wins = asNumber(
    pickFirst(row, [
      'wins',
      'WINS',
      'winCount',
    ])
  );

  const losses = asNumber(
    pickFirst(row, [
      'losses',
      'LOSSES',
      'lossCount',
    ])
  );

  const winrate = normalizeWinrate(
    pickFirst(row, [
      'winrate',
      'WINRATE',
      'wr',
      'WR',
      'winrateNum',
    ])
  );

  const avgR = asNumber(
    pickFirst(row, [
      'avgR',
      'AVG_R',
      'AVG R',
      'averageR',
      'meanR',
      'expectancyR',
    ])
  );

  const totalR = asNumber(
    pickFirst(row, [
      'totalR',
      'TOTAL_R',
      'TOTAL R',
    ])
  );

  const pf = normalizePf(
    pickFirst(row, [
      'pf',
      'PF',
      'profitFactor',
      'profit_factor',
      'profitFactorR',
    ]),
    config.pfCap
  );

  const definition = normalizeDefinition(
    pickFirst(row, [
      'definition',
      'DEFINITION',
      'labels',
      'signature',
      'desc',
      'cohortKey',
      'familyKey',
    ])
  );

  const observed = asNumber(
    pickFirst(row, [
      'observed',
      'OBSERVED',
      'trades',
      'TRADES',
      'sample',
    ]),
    closed
  );

  return {
    id: familyId,
    familyId,
    microFamilyId: familyId,
    side,
    parent,
    status,
    observed,
    closed,
    wins,
    losses,
    winrate,
    totalR,
    avgR,
    pf,
    definition,
    labels: definition
      ? definition.split('|').map(x => x.trim()).filter(Boolean)
      : [],
    raw: row,
  };
}

export function isUsableMicroFamily(family, config = DEFAULT_CONFIG) {
  if (!family?.familyId) return false;
  if (!family?.side) return false;
  if (family.closed < config.minClosed) return false;
  if (family.avgR < config.minAvgR) return false;
  if (family.pf < config.minProfitFactor) return false;

  if (config.rejectBadStatus && BAD_STATUSES.has(family.status)) return false;

  return true;
}

function scoreSampleSize(closed, minClosed) {
  if (closed <= 0) return 0;

  // 6 closed = klein, 30+ closed = veel betrouwbaarder.
  return Math.min(1, closed / Math.max(minClosed * 5, 1));
}

function scoreStability(status) {
  if (status === 'ELITE') return 1;
  if (status === 'HOT') return 0.9;
  if (status === 'GOOD') return 0.8;
  if (status === 'STABLE') return 0.65;
  if (status === 'CANDIDATE') return 0.45;
  if (status === 'COLLECTING') return 0.25;

  return 0;
}

export function scoreMicroFamily(family, config = DEFAULT_CONFIG) {
  const weights = config.weights;

  const avgRScore = Math.max(0, Math.min(1, family.avgR / 1.25));
  const wrScore = Math.max(0, Math.min(1, family.winrate));
  const pfScore = Math.max(0, Math.min(1, family.pf / config.pfCap));
  const sampleScore = scoreSampleSize(family.closed, config.minClosed);
  const stabilityScore = scoreStability(family.status);

  const score =
    avgRScore * weights.avgR +
    wrScore * weights.winrate +
    pfScore * weights.pf +
    sampleScore * weights.sample +
    stabilityScore * weights.stability;

  return Number(score.toFixed(3));
}

function sortRankedFamilies(a, b, config) {
  if (config.winrateFirst !== false) {
    if (b.winrate !== a.winrate) return b.winrate - a.winrate;
    if (b.closed !== a.closed) return b.closed - a.closed;
    if (b.avgR !== a.avgR) return b.avgR - a.avgR;
    if (b.pf !== a.pf) return b.pf - a.pf;

    return b.selectorScore - a.selectorScore;
  }

  if (b.selectorScore !== a.selectorScore) return b.selectorScore - a.selectorScore;
  if (b.closed !== a.closed) return b.closed - a.closed;
  if (b.avgR !== a.avgR) return b.avgR - a.avgR;
  if (b.winrate !== a.winrate) return b.winrate - a.winrate;

  return b.pf - a.pf;
}

export function rankMicroFamilies(rows = [], options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...options,
    weights: {
      ...DEFAULT_CONFIG.weights,
      ...(options.weights || {}),
    },
  };

  if (!Array.isArray(rows)) return [];

  return rows
    .map(row => normalizeMicroFamilyRow(row, config))
    .filter(family => isUsableMicroFamily(family, config))
    .map(family => ({
      ...family,
      selectorScore: scoreMicroFamily(family, config),
    }))
    .sort((a, b) => sortRankedFamilies(a, b, config));
}

export function selectBestBySide(rows = [], options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...options,
    weights: {
      ...DEFAULT_CONFIG.weights,
      ...(options.weights || {}),
    },
  };

  const ranked = rankMicroFamilies(rows, config);

  const long = ranked
    .filter(family => family.side === 'LONG')
    .slice(0, config.maxPerSide);

  const short = ranked
    .filter(family => family.side === 'SHORT')
    .slice(0, config.maxPerSide);

  return {
    long,
    short,
    all: [...long, ...short],
    ranked,
  };
}

function toIso(date) {
  return new Date(date).toISOString();
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);

  return next;
}

function startOfUtcDay(date) {
  const next = new Date(date);
  next.setUTCHours(0, 0, 0, 0);

  return next;
}

export function createRotationId(date = new Date()) {
  const d = new Date(date);

  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  const minute = String(d.getUTCMinutes()).padStart(2, '0');

  return `ROT_${year}${month}${day}_${hour}${minute}`;
}

export function getDefaultRotationWindow(now = new Date(), lookbackDays = 7) {
  const activatedAt = startOfUtcDay(now);
  const expiresAt = addDays(activatedAt, lookbackDays);

  return {
    activatedAt: toIso(activatedAt),
    expiresAt: toIso(expiresAt),
  };
}

export function buildWeeklyRotation(rows = [], options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...options,
    weights: {
      ...DEFAULT_CONFIG.weights,
      ...(options.weights || {}),
    },
  };

  const now = options.now ? new Date(options.now) : new Date();
  const selected = selectBestBySide(rows, config);
  const window = getDefaultRotationWindow(now, config.lookbackDays);

  const allowlist = selected.all.map((family, index) => ({
    rank: index + 1,

    id: family.familyId,
    familyId: family.familyId,
    microFamilyId: family.microFamilyId || family.familyId,

    side: family.side,
    parent: family.parent,
    status: family.status,

    closed: family.closed,
    minClosed: family.closed,
    wins: family.wins,
    losses: family.losses,

    winrate: Number((family.winrate * 100).toFixed(2)),
    winrateNum: Number(family.winrate.toFixed(4)),

    avgR: Number(family.avgR.toFixed(4)),
    totalR: Number(family.totalR.toFixed(4)),
    pf: Number(family.pf.toFixed(4)),

    selectorScore: family.selectorScore,
    selectionMode: config.winrateFirst !== false ? 'WINRATE_FIRST' : 'WEIGHTED_SCORE',

    definition: family.definition,
    labels: family.labels || [],
  }));

  return {
    rotationId: createRotationId(now),
    id: createRotationId(now),

    status: allowlist.length > 0 ? 'ACTIVE' : 'EMPTY',
    mode: 'WEEKLY_MICRO_ROTATION',

    createdAt: toIso(now),
    activatedAt: window.activatedAt,
    expiresAt: window.expiresAt,

    source: {
      type: 'MICRO_FAMILY_ANALYSIS',
      lookbackDays: config.lookbackDays,
      minClosed: config.minClosed,
      minAvgR: config.minAvgR,
      minProfitFactor: config.minProfitFactor,
      maxPerSide: config.maxPerSide,
      winrateFirst: config.winrateFirst !== false,
    },

    summary: {
      totalAllowed: allowlist.length,
      longAllowed: allowlist.filter(item => item.side === 'LONG').length,
      shortAllowed: allowlist.filter(item => item.side === 'SHORT').length,
      candidatesScanned: Array.isArray(rows) ? rows.length : 0,
      candidatesQualified: selected.ranked.length,
    },

    allowlist,

    rejectedNote:
      'Live gate gebruikt alleen deze allowlist. Analyzer/scanner blijven alle families meten voor de volgende rotatie.',
  };
}

export function getRotationDecisionText(rotation) {
  if (!rotation) return 'NO_ROTATION';

  const long = rotation.allowlist?.filter(item => item.side === 'LONG') || [];
  const short = rotation.allowlist?.filter(item => item.side === 'SHORT') || [];

  const bestLong = long[0]?.familyId || long[0]?.id || 'NONE';
  const bestShort = short[0]?.familyId || short[0]?.id || 'NONE';

  return [
    `ROTATION ${rotation.status}`,
    `ID ${rotation.rotationId || rotation.id || 'UNKNOWN'}`,
    `LONG ${bestLong}`,
    `SHORT ${bestShort}`,
    `ALLOWLIST ${rotation.allowlist?.length || 0}`,
    `EXPIRES ${rotation.expiresAt || 'UNKNOWN'}`,
  ].join(' | ');
}

export default {
  buildWeeklyRotation,
  rankMicroFamilies,
  selectBestBySide,
  normalizeMicroFamilyRow,
  isUsableMicroFamily,
  scoreMicroFamily,
  getRotationDecisionText,
};