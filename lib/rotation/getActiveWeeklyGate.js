import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_CACHE_TTL_MS = 30_000;

const DEFAULT_KV_KEYS = [
  'weeklyRotation:activeGate',
  'weeklyRotation:active',
  'weekly-rotation:activeGate',
  'weekly-rotation:active',
  'rotation:weekly:activeGate',
  'rotation:weekly:active',
  'tradesystem:weeklyRotation:active',
];

const DEFAULT_FILE_PATHS = [
  path.join(process.cwd(), 'data', 'weekly-rotation-active.json'),
  path.join(process.cwd(), 'data', 'rotation', 'weekly-active-gate.json'),
  path.join(process.cwd(), 'data', 'rotation', 'active-weekly-gate.json'),
  path.join(process.cwd(), 'data', 'weekly-rotation', 'active.json'),
];

const VALID_MODES = new Set(['OFF', 'OBSERVE', 'SOFT', 'STRICT']);
const VALID_EMPTY_POLICIES = new Set(['ALLOW_ALL', 'DENY_ALL']);

const cache = {
  gate: null,
  expiresAt: 0,
  pending: null,
};

const upper = (value) => String(value ?? '').trim().toUpperCase();

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const unique = (items) => [...new Set(items.filter(Boolean))];

const safeArray = (value) => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const safeJsonParse = (value) => {
  if (!value) return null;
  if (isObject(value) || Array.isArray(value)) return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
};

const normalizeSide = (side) => {
  const value = upper(side);
  if (value === 'LONG') return 'LONG';
  if (value === 'SHORT') return 'SHORT';
  return 'UNKNOWN';
};

const normalizeMode = (rawMode) => {
  const envMode = process.env.WEEKLY_ROTATION_GATE_MODE;
  const mode = upper(envMode || rawMode || 'STRICT');

  if (mode === 'DISABLED') return 'OFF';
  if (mode === 'SHADOW') return 'OBSERVE';
  if (mode === 'OBSERVE_ONLY') return 'OBSERVE';
  if (mode === 'PAPER') return 'OBSERVE';

  return VALID_MODES.has(mode) ? mode : 'STRICT';
};

const normalizeEmptyPolicy = (rawPolicy) => {
  const envPolicy = process.env.WEEKLY_ROTATION_EMPTY_POLICY;
  const policy = upper(envPolicy || rawPolicy || 'ALLOW_ALL');

  return VALID_EMPTY_POLICIES.has(policy) ? policy : 'ALLOW_ALL';
};

const parseDefinitionLabels = (...values) => {
  const labels = [];

  for (const value of values) {
    if (!value) continue;

    if (Array.isArray(value)) {
      for (const item of value) labels.push(...parseDefinitionLabels(item));
      continue;
    }

    if (isObject(value)) {
      labels.push(...parseDefinitionLabels(Object.values(value)));
      continue;
    }

    const raw = String(value);

    if (raw.includes('|')) {
      labels.push(...raw.split('|').map((x) => x.trim()).filter(Boolean));
      continue;
    }

    if (raw.includes(',')) {
      labels.push(...raw.split(',').map((x) => x.trim()).filter(Boolean));
      continue;
    }

    labels.push(raw.trim());
  }

  return unique(labels.map(upper));
};

const normalizeFamily = (family, index = 0) => {
  if (!family) return null;

  if (typeof family === 'string') {
    const id = family.trim();

    if (!id) return null;

    return {
      id,
      familyId: id,
      microFamilyId: id.startsWith('MICRO_') ? id : null,
      subFamilyId: null,
      parentFamilyId: null,
      parent: null,
      level: id.startsWith('MICRO_') ? 'MICRO' : 'UNKNOWN',
      side: id.includes('_SHORT_') || id.startsWith('SHORT_') ? 'SHORT' : id.includes('_LONG_') || id.startsWith('LONG_') ? 'LONG' : 'UNKNOWN',
      definition: '',
      labels: [upper(id)],
      raw: family,
    };
  }

  if (!isObject(family)) return null;

  const id =
    family.id ||
    family.family ||
    family.familyId ||
    family.microFamilyId ||
    family.microFamily ||
    family.subFamilyId ||
    family.subFamily ||
    family.parentFamilyId ||
    family.parent ||
    `ACTIVE_FAMILY_${index + 1}`;

  const familyId = family.familyId || family.family || id;
  const microFamilyId = family.microFamilyId || family.microFamily || (String(id).startsWith('MICRO_') ? id : null);
  const subFamilyId = family.subFamilyId || family.subFamily || null;
  const parentFamilyId = family.parentFamilyId || family.parent || family.parentFamily || null;

  const definition =
    family.definition ||
    family.description ||
    family.signature ||
    family.labelsText ||
    safeArray(family.labels).join(' | ') ||
    '';

  const labels = parseDefinitionLabels(
    id,
    familyId,
    microFamilyId,
    subFamilyId,
    parentFamilyId,
    definition,
    family.labels,
    family.tags,
    family.criteriaLabels,
    family.definitionLabels,
  );

  return {
    id: String(id),
    familyId: familyId ? String(familyId) : String(id),
    microFamilyId: microFamilyId ? String(microFamilyId) : null,
    subFamilyId: subFamilyId ? String(subFamilyId) : null,
    parentFamilyId: parentFamilyId ? String(parentFamilyId) : null,
    parent: parentFamilyId ? String(parentFamilyId) : null,
    level: upper(family.level || (microFamilyId ? 'MICRO' : subFamilyId ? 'SUB' : 'PARENT')),
    side: normalizeSide(family.side || family.direction),
    definition: String(definition),
    labels,
    criteria: isObject(family.criteria) ? family.criteria : null,
    minClosed: Number(family.minClosed ?? family.closed ?? family.closedTrades ?? 0),
    winrate: Number(family.winrate ?? family.wr ?? 0),
    avgR: Number(family.avgR ?? family.averageR ?? 0),
    pf: Number(family.pf ?? family.profitFactor ?? 0),
    raw: family,
  };
};

const normalizeAllowlist = (raw) => {
  if (!raw) return [];

  const items = [
    ...safeArray(raw.allowlist),
    ...safeArray(raw.allowed),
    ...safeArray(raw.activeFamilies),
    ...safeArray(raw.activeMicroFamilies),
    ...safeArray(raw.selectedFamilies),
    ...safeArray(raw.selected),
    ...safeArray(raw.winners),
    ...safeArray(raw.winnerFamilies),
    ...safeArray(raw.discordAllowlist),
    ...safeArray(raw.mainDiscordAllowlist),
    ...safeArray(raw.longAllowlist),
    ...safeArray(raw.shortAllowlist),
  ];

  const normalized = items
    .flat()
    .map(normalizeFamily)
    .filter(Boolean);

  const seen = new Set();

  return normalized.filter((family) => {
    const key = upper(family.id || family.familyId);
    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
};

const createNoopWeeklyGate = (reason = 'NO_ACTIVE_CONFIG', meta = {}) => ({
  enabled: false,
  mode: 'OFF',
  emptyPolicy: 'ALLOW_ALL',
  source: meta.source || 'none',
  sourceKey: meta.sourceKey || null,
  sourcePath: meta.sourcePath || null,
  activeWeekId: null,
  selectedFromWeekId: null,
  selectedAt: null,
  loadedAt: new Date().toISOString(),
  activeCount: 0,
  allowlist: [],
  longAllowlist: [],
  shortAllowlist: [],
  reason,
  decide(candidate = {}) {
    return decideWeeklyGate(this, candidate);
  },
});

export function normalizeActiveWeeklyGate(rawValue, meta = {}) {
  const raw = safeJsonParse(rawValue);

  if (!raw) {
    return createNoopWeeklyGate('NO_ACTIVE_CONFIG', meta);
  }

  const envDisabled = process.env.WEEKLY_ROTATION_GATE_ENABLED === '0';
  const mode = envDisabled ? 'OFF' : normalizeMode(raw.mode || raw.gateMode);
  const emptyPolicy = normalizeEmptyPolicy(raw.emptyPolicy);

  const allowlist = normalizeAllowlist(raw);
  const longAllowlist = allowlist.filter((family) => family.side === 'LONG' || family.side === 'UNKNOWN');
  const shortAllowlist = allowlist.filter((family) => family.side === 'SHORT' || family.side === 'UNKNOWN');

  const enabled = mode !== 'OFF';

  return {
    enabled,
    mode,
    emptyPolicy,
    source: meta.source || raw.source || 'unknown',
    sourceKey: meta.sourceKey || raw.sourceKey || null,
    sourcePath: meta.sourcePath || raw.sourcePath || null,
    activeWeekId: raw.activeWeekId || raw.weekId || raw.targetWeekId || null,
    selectedFromWeekId: raw.selectedFromWeekId || raw.sourceWeekId || raw.fromWeekId || null,
    selectedAt: raw.selectedAt || raw.createdAt || raw.updatedAt || null,
    loadedAt: new Date().toISOString(),
    activeCount: allowlist.length,
    allowlist,
    longAllowlist,
    shortAllowlist,
    raw,
    decide(candidate = {}) {
      return decideWeeklyGate(this, candidate);
    },
  };
}

const collectCandidateIds = (candidate) => {
  if (!candidate) return [];

  const ids = [
    candidate.id,
    candidate.family,
    candidate.familyId,
    candidate.frozenFamilyId,
    candidate.activeFamilyId,
    candidate.microFamily,
    candidate.microFamilyId,
    candidate.subFamily,
    candidate.subFamilyId,
    candidate.parentFamily,
    candidate.parentFamilyId,
    candidate.parent,
    candidate.setupId,
    candidate.signalFamilyId,
  ];

  for (const key of [
    'familyIds',
    'families',
    'microFamilies',
    'microFamilyIds',
    'subFamilies',
    'subFamilyIds',
    'parentFamilies',
    'parentFamilyIds',
    'tags',
    'labels',
  ]) {
    ids.push(...safeArray(candidate[key]));
  }

  return unique(ids.map((x) => String(x ?? '').trim()).filter(Boolean));
};

const collectCandidateLabels = (candidate) => {
  if (!candidate) return [];

  return parseDefinitionLabels(
    collectCandidateIds(candidate),
    candidate.definition,
    candidate.signature,
    candidate.labels,
    candidate.tags,
    candidate.criteriaLabels,
    candidate.definitionLabels,
    candidate.quality,
    candidate.market,
    candidate.timing,
    candidate.stage,
    candidate.flow,
    candidate.rsi,
    candidate.rsiZone,
    candidate.obBias,
    candidate.btcState,
    candidate.funding,
    candidate.tfStrength,
    candidate.session,
  );
};

const sameId = (a, b) => {
  if (!a || !b) return false;
  return upper(a) === upper(b);
};

const fieldMatches = (actual, expected) => {
  if (expected === undefined || expected === null || expected === '') return true;

  if (Array.isArray(expected)) {
    return expected.some((item) => fieldMatches(actual, item));
  }

  if (typeof expected === 'number') {
    const actualNumber = Number(actual);
    return Number.isFinite(actualNumber) && actualNumber === expected;
  }

  if (typeof expected === 'boolean') {
    return Boolean(actual) === expected;
  }

  return upper(actual) === upper(expected);
};

const matchesCriteria = (candidate, criteria) => {
  if (!isObject(criteria)) return false;

  for (const [key, expected] of Object.entries(criteria)) {
    if (!fieldMatches(candidate?.[key], expected)) {
      return false;
    }
  }

  return true;
};

const findMatchingActiveFamily = (gate, candidate = {}) => {
  const side = normalizeSide(candidate.side || candidate.direction);
  const candidateIds = collectCandidateIds(candidate);
  const candidateLabels = collectCandidateLabels(candidate);

  const idSet = new Set(candidateIds.map(upper));
  const labelSet = new Set(candidateLabels);

  const candidates =
    side === 'LONG'
      ? gate.longAllowlist
      : side === 'SHORT'
        ? gate.shortAllowlist
        : gate.allowlist;

  for (const family of candidates) {
    if (family.side !== 'UNKNOWN' && side !== 'UNKNOWN' && family.side !== side) {
      continue;
    }

    const familyIds = unique([
      family.id,
      family.familyId,
      family.microFamilyId,
      family.subFamilyId,
      family.parentFamilyId,
      family.parent,
    ]);

    const exactIdMatch = familyIds.some((id) => idSet.has(upper(id)));
    if (exactIdMatch) {
      return {
        family,
        matchType: 'ID',
      };
    }

    if (family.criteria && matchesCriteria(candidate, family.criteria)) {
      return {
        family,
        matchType: 'CRITERIA',
      };
    }

    const labels = safeArray(family.labels).map(upper).filter(Boolean);
    const enoughLabels = labels.length >= 3;
    const allLabelsMatch = enoughLabels && labels.every((label) => labelSet.has(label));

    if (allLabelsMatch) {
      return {
        family,
        matchType: 'LABELS',
      };
    }
  }

  return null;
};

export function decideWeeklyGate(gate, candidate = {}) {
  const checkedAt = new Date().toISOString();

  if (!gate?.enabled || gate.mode === 'OFF') {
    return {
      allowed: true,
      matched: false,
      matchType: 'GATE_OFF',
      reason: gate?.reason || 'WEEKLY_GATE_OFF',
      mode: gate?.mode || 'OFF',
      activeWeekId: gate?.activeWeekId || null,
      selectedFromWeekId: gate?.selectedFromWeekId || null,
      activeCount: gate?.activeCount || 0,
      activeFamilyId: null,
      activeFamily: null,
      checkedAt,
    };
  }

  if (!gate.allowlist?.length) {
    const allowOnEmpty = gate.emptyPolicy === 'ALLOW_ALL';

    return {
      allowed: allowOnEmpty,
      matched: false,
      matchType: 'EMPTY_ALLOWLIST',
      reason: allowOnEmpty ? 'EMPTY_ALLOWLIST_ALLOW_ALL' : 'EMPTY_ALLOWLIST_DENY_ALL',
      mode: gate.mode,
      activeWeekId: gate.activeWeekId || null,
      selectedFromWeekId: gate.selectedFromWeekId || null,
      activeCount: 0,
      activeFamilyId: null,
      activeFamily: null,
      checkedAt,
    };
  }

  const match = findMatchingActiveFamily(gate, candidate);

  if (match) {
    return {
      allowed: true,
      matched: true,
      matchType: match.matchType,
      reason: 'MATCHED_ACTIVE_WEEKLY_FAMILY',
      mode: gate.mode,
      activeWeekId: gate.activeWeekId || null,
      selectedFromWeekId: gate.selectedFromWeekId || null,
      activeCount: gate.activeCount,
      activeFamilyId: match.family.id,
      activeFamily: match.family,
      checkedAt,
    };
  }

  const observeOnly = gate.mode === 'OBSERVE' || gate.mode === 'SOFT';

  return {
    allowed: observeOnly,
    matched: false,
    matchType: 'NO_MATCH',
    reason: observeOnly ? 'NO_MATCH_OBSERVE_ONLY' : 'NO_MATCH_BLOCKED',
    mode: gate.mode,
    activeWeekId: gate.activeWeekId || null,
    selectedFromWeekId: gate.selectedFromWeekId || null,
    activeCount: gate.activeCount,
    activeFamilyId: null,
    activeFamily: null,
    checkedAt,
  };
}

async function tryReadKv(keys) {
  if (process.env.WEEKLY_ROTATION_DISABLE_KV === '1') return null;

  let kv;

  try {
    const mod = await import('@vercel/kv');
    kv = mod.kv;
  } catch {
    return null;
  }

  if (!kv?.get) return null;

  for (const key of keys) {
    if (!key) continue;

    try {
      const value = await kv.get(key);

      if (value) {
        return {
          value,
          source: 'kv',
          sourceKey: key,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function tryReadFiles(filePaths) {
  for (const filePath of filePaths) {
    if (!filePath) continue;

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const value = safeJsonParse(content);

      if (value) {
        return {
          value,
          source: 'file',
          sourcePath: filePath,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function loadActiveRaw(options = {}) {
  const envJson = safeJsonParse(process.env.WEEKLY_ROTATION_ACTIVE_JSON);

  if (envJson) {
    return {
      value: envJson,
      source: 'env',
      sourceKey: 'WEEKLY_ROTATION_ACTIVE_JSON',
    };
  }

  const kvKeys = unique([
    options.kvKey,
    process.env.WEEKLY_ROTATION_ACTIVE_KEY,
    ...DEFAULT_KV_KEYS,
  ]);

  const kvResult = await tryReadKv(kvKeys);
  if (kvResult) return kvResult;

  const filePaths = unique([
    options.filePath,
    process.env.WEEKLY_ROTATION_ACTIVE_FILE,
    ...DEFAULT_FILE_PATHS,
  ]);

  const fileResult = await tryReadFiles(filePaths);
  if (fileResult) return fileResult;

  return null;
}

export async function getActiveWeeklyGate(options = {}) {
  const now = Date.now();
  const ttlMs = Number(options.cacheTtlMs ?? process.env.WEEKLY_ROTATION_GATE_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS);

  if (!options.forceRefresh && cache.gate && cache.expiresAt > now) {
    return cache.gate;
  }

  if (!options.forceRefresh && cache.pending) {
    return cache.pending;
  }

  cache.pending = (async () => {
    const loaded = await loadActiveRaw(options);

    const gate = loaded
      ? normalizeActiveWeeklyGate(loaded.value, loaded)
      : createNoopWeeklyGate('NO_ACTIVE_CONFIG');

    cache.gate = gate;
    cache.expiresAt = Date.now() + Math.max(0, ttlMs);
    cache.pending = null;

    return gate;
  })();

  return cache.pending;
}

export async function isTradeAllowedByActiveWeeklyGate(candidate = {}, options = {}) {
  const gate = await getActiveWeeklyGate(options);
  return gate.decide(candidate);
}

export function clearActiveWeeklyGateCache() {
  cache.gate = null;
  cache.expiresAt = 0;
  cache.pending = null;
}

export function explainWeeklyGateDecision(decision) {
  if (!decision) return 'NO_DECISION';

  if (decision.allowed && decision.matched) {
    return `ALLOW: matched ${decision.activeFamilyId} via ${decision.matchType}`;
  }

  if (decision.allowed && !decision.matched) {
    return `ALLOW: ${decision.reason}`;
  }

  return `BLOCK: ${decision.reason}`;
}

export default getActiveWeeklyGate;