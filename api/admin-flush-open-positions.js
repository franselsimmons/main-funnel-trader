// api/admin-flush-open-positions.js

const STRATEGY_VERSION =
  process.env.TRADE_SYSTEM_STRATEGY_VERSION ||
  process.env.STRATEGY_VERSION ||
  'TS_V12_8_WEEKLY_MICRO_ROTATION_CLEAN';

const ADMIN_SECRET = process.env.TS_ADMIN_SECRET;
const FLUSH_ENABLED = process.env.TS_ADMIN_FLUSH_ENABLED === 'true';

const MODULE_CANDIDATES = [
  '../lib/tradesystem/tradesSystem.js',
  '../lib/tradesystem/jsonStoreAdapter.js',
  '../lib/tradesystem/positionManager.js',
  '../lib/tradesystem/portfolio.js',
  '../lib/tradesystem/db.js',
  '../lib/db.js',
];

const LOAD_EXPORT_NAMES = [
  'loadTradeSystemState',
  'loadTradeSystemDurableState',
  'loadDurableTradeSystemState',
  'loadDurableState',
  'loadRuntimeState',
  'loadTradeState',
  'loadState',
  'loadSplitState',
  'durableLoadSplit',
  'loadDurableSplit',
];

const SAVE_EXPORT_NAMES = [
  'saveTradeSystemState',
  'saveTradeSystemDurableState',
  'saveDurableTradeSystemState',
  'saveDurableState',
  'saveRuntimeState',
  'saveTradeState',
  'saveState',
  'saveSplitState',
  'durableSaveSplit',
  'saveDurableSplit',
];

function parseBody(req) {
  if (!req.body) return {};

  if (typeof req.body === 'object') {
    return req.body;
  }

  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

function asArray(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  if (value instanceof Map) {
    return [...value.values()].filter(Boolean);
  }

  if (typeof value === 'object') {
    return Object.values(value).filter(Boolean);
  }

  return [];
}

function emptyLike(value) {
  if (Array.isArray(value)) return [];
  if (value instanceof Map) return new Map();
  if (value && typeof value === 'object') return {};
  return [];
}

function uniqByTradeIdentity(rows) {
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const symbol = String(row?.symbol || '').toUpperCase();
    const side = String(row?.side || '').toLowerCase();
    const id =
      row?.tradeId ||
      row?.positionId ||
      row?.entryId ||
      row?.id ||
      `${symbol}:${side}:${row?.openedAt || row?.entryTs || row?.ts || ''}:${row?.entry || row?.entryPrice || ''}`;

    if (!symbol) continue;
    if (seen.has(id)) continue;

    seen.add(id);
    out.push(row);
  }

  return out;
}

function getSymbol(row) {
  return String(row?.symbol || row?.baseSymbol || '').toUpperCase();
}

function normalizeSide(side) {
  const s = String(side || '').toLowerCase();

  if (s === 'short') return 'bear';
  if (s === 'sell') return 'bear';
  if (s === 'bear') return 'bear';

  if (s === 'long') return 'bull';
  if (s === 'buy') return 'bull';
  if (s === 'bull') return 'bull';

  return s || null;
}

function getEntryPrice(pos) {
  return Number(
    pos?.entry ??
      pos?.entryPrice ??
      pos?.avgEntry ??
      pos?.avgEntryPrice ??
      pos?.openPrice ??
      pos?.price ??
      0
  );
}

function getClosePrice(pos) {
  const entry = getEntryPrice(pos);

  return Number(
    pos?.currentPrice ??
      pos?.markPrice ??
      pos?.lastPrice ??
      pos?.closePrice ??
      pos?.exitPrice ??
      entry
  );
}

function calcR(pos, closePrice) {
  const side = normalizeSide(pos?.side);
  const entry = getEntryPrice(pos);
  const sl = Number(pos?.sl ?? pos?.stopLoss ?? pos?.stop ?? 0);

  if (!side || !entry || !sl || !closePrice) return 0;

  const risk = Math.abs(entry - sl);
  if (!risk) return 0;

  if (side === 'bear') {
    return Number(((entry - closePrice) / risk).toFixed(4));
  }

  return Number(((closePrice - entry) / risk).toFixed(4));
}

function buildManualExit(pos, index, now, reason) {
  const symbol = getSymbol(pos);
  const side = normalizeSide(pos?.side);
  const entry = getEntryPrice(pos);
  const closePrice = getClosePrice(pos);
  const pnlR = calcR(pos, closePrice);

  return {
    ...pos,

    id: `manual_flush_exit_${symbol}_${side}_${now}_${index}`,
    tradeId:
      pos?.tradeId ||
      pos?.positionId ||
      pos?.entryId ||
      `manual_flush_trade_${symbol}_${side}_${now}_${index}`,

    type: 'exit',
    action: 'EXIT',
    eventType: 'EXIT',

    symbol,
    side,

    entry,
    entryPrice: entry,

    exit: closePrice,
    exitPrice: closePrice,
    closePrice,

    r: pnlR,
    pnlR,
    finalR: pnlR,

    reason,
    exitReason: reason,
    closeReason: reason,
    outcome: 'MANUAL_FLUSH',

    openedAt: pos?.openedAt ?? pos?.entryTs ?? pos?.ts ?? null,
    closedAt: now,
    exitTs: now,
    ts: now,

    manualFlush: true,
    forceClosed: true,
    forceExit: true,

    // Belangrijk: deze flush mag micro-learning / weekly rotation NIET trainen.
    learnEligible: false,
    analysisEligible: false,
    microLearningEligible: false,
    rotationLearningEligible: false,

    excludeFromLearning: true,
    excludeFromAnalysis: true,
    excludeFromMicroLearning: true,
    excludeFromRotationLearning: true,

    excludedReason: reason,
    source: 'VERCEL_ADMIN_FLUSH_OPEN_POSITIONS',
  };
}

function collectOpenPositions(state) {
  const direct = asArray(state?.openPositions);
  const memory = asArray(state?.memory).filter((row) => {
    const action = String(row?.action || row?.type || '').toLowerCase();
    return action !== 'exit' && getSymbol(row);
  });

  const active = asArray(state?.activePositions);
  const positionsBySymbol = asArray(state?.positionsBySymbol);
  const openBySymbol = asArray(state?.openBySymbol);

  return uniqByTradeIdentity([
    ...direct,
    ...memory,
    ...active,
    ...positionsBySymbol,
    ...openBySymbol,
  ]);
}

function clearOpenContainers(state) {
  const keys = [
    'openPositions',
    'memory',
    'activePositions',
    'positionsBySymbol',
    'openBySymbol',
    'openPositionBySymbol',
    'openPositionsBySymbol',
    'symbolOpenMap',
    'activeBySymbol',
  ];

  for (const key of keys) {
    if (state[key] !== undefined) {
      state[key] = emptyLike(state[key]);
    }
  }
}

function pruneRecentEntriesForClosedSymbols(state, closedSymbols) {
  if (!Array.isArray(state.recentEntries)) return;

  state.recentEntries = state.recentEntries.filter((row) => {
    const symbol = getSymbol(row);
    return !closedSymbols.has(symbol);
  });
}

function pruneSymbolMapsForClosedSymbols(state, closedSymbols) {
  const mapKeys = [
    'reentryCooldowns',
    'symbolCooldowns',
    'cooldownsBySymbol',
    'lastEntryBySymbol',
    'lastSignalBySymbol',
    'lastTradeBySymbol',
    'entryLocksBySymbol',
    'symbolLocks',
  ];

  for (const key of mapKeys) {
    const value = state[key];

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    for (const symbol of closedSymbols) {
      delete value[symbol];
      delete value[symbol.toLowerCase()];
      delete value[`${symbol}USDT`];
      delete value[`${symbol}_USDT`];
    }
  }
}

async function importCandidateModules() {
  const modules = [];
  const errors = [];

  for (const path of MODULE_CANDIDATES) {
    try {
      const mod = await import(path);
      modules.push({
        path,
        mod,
      });
    } catch (error) {
      errors.push({
        path,
        error: error?.message || String(error),
      });
    }
  }

  return {
    modules,
    errors,
  };
}

function flattenExports(entry) {
  const out = {};

  for (const [key, value] of Object.entries(entry.mod || {})) {
    out[key] = value;
  }

  if (entry.mod?.default && typeof entry.mod.default === 'object') {
    for (const [key, value] of Object.entries(entry.mod.default)) {
      out[key] = value;
    }
  }

  return out;
}

function pickFunction(modules, names) {
  for (const entry of modules) {
    const exports = flattenExports(entry);

    for (const name of names) {
      if (typeof exports[name] === 'function') {
        return {
          name,
          path: entry.path,
          fn: exports[name],
        };
      }
    }
  }

  return null;
}

function listExports(modules) {
  return modules.map((entry) => {
    const exports = flattenExports(entry);

    return {
      path: entry.path,
      exports: Object.keys(exports).sort(),
    };
  });
}

async function callLoad(loadFn) {
  const attempts = [
    [{ strategyVersion: STRATEGY_VERSION, source: 'VERCEL_ADMIN_FLUSH_LOAD' }],
    [STRATEGY_VERSION],
    [],
  ];

  let lastError = null;

  for (const args of attempts) {
    try {
      const result = await loadFn(...args);
      if (result && typeof result === 'object') return result;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('LOAD_FAILED');
}

async function callSave(saveFn, state, reason) {
  const runId = `admin_flush_${Date.now()}`;

  const attempts = [
    [
      state,
      {
        strategyVersion: STRATEGY_VERSION,
        runId,
        reason,
        source: 'VERCEL_ADMIN_FLUSH_OPEN_POSITIONS',
      },
    ],
    [state, STRATEGY_VERSION],
    [state],
  ];

  let lastError = null;

  for (const args of attempts) {
    try {
      return await saveFn(...args);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('SAVE_FAILED');
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      expected: 'POST',
    });
  }

  if (!FLUSH_ENABLED) {
    return res.status(403).json({
      ok: false,
      error: 'ADMIN_FLUSH_DISABLED',
      fix: 'Set TS_ADMIN_FLUSH_ENABLED=true in Vercel env and redeploy.',
    });
  }

  const secret = req.headers['x-admin-secret'];

  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED',
    });
  }

  const body = parseBody(req);
  const dryRun = body.dryRun !== false;
  const reason = body.reason || 'MANUAL_FLUSH_CLEAR_CAP';
  const pruneRecentEntries = body.pruneRecentEntries !== false;

  const imported = await importCandidateModules();

  const load = pickFunction(imported.modules, LOAD_EXPORT_NAMES);
  const save = pickFunction(imported.modules, SAVE_EXPORT_NAMES);

  if (!load || !save) {
    return res.status(500).json({
      ok: false,
      error: 'DURABLE_STATE_LOAD_SAVE_EXPORT_NOT_FOUND',
      strategyVersion: STRATEGY_VERSION,
      foundModules: listExports(imported.modules),
      importErrors: imported.errors,
      expectedLoadNames: LOAD_EXPORT_NAMES,
      expectedSaveNames: SAVE_EXPORT_NAMES,
    });
  }

  const state = await callLoad(load.fn);
  const openPositions = collectOpenPositions(state);
  const now = Date.now();

  const manualExits = openPositions.map((pos, index) =>
    buildManualExit(pos, index, now, reason)
  );

  const closedSymbols = new Set(
    openPositions.map((pos) => getSymbol(pos)).filter(Boolean)
  );

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      strategyVersion: STRATEGY_VERSION,

      loader: {
        name: load.name,
        path: load.path,
      },

      saver: {
        name: save.name,
        path: save.path,
      },

      openBefore: openPositions.length,
      exitsToAppend: manualExits.length,
      symbolsToClear: [...closedSymbols].slice(0, 50),
      symbolCount: closedSymbols.size,

      currentCounts: {
        entries: asArray(state.entries).length,
        exits: asArray(state.exits).length,
        closedTrades: asArray(state.closedTrades).length,
        recentEntries: asArray(state.recentEntries).length,
        memory: asArray(state.memory).length,
      },

      reason,
      durationMs: Date.now() - startedAt,
    });
  }

  state.exits = [...asArray(state.exits), ...manualExits];

  // Niet standaard toevoegen aan closedTrades.
  // Reden: dit zijn administratieve exits, geen echte performance samples.
  // De exits zijn genoeg om entries - exits te neutraliseren.
  if (body.includeClosedTrades === true) {
    state.closedTrades = [...asArray(state.closedTrades), ...manualExits];
  }

  clearOpenContainers(state);

  if (pruneRecentEntries) {
    pruneRecentEntriesForClosedSymbols(state, closedSymbols);
  }

  pruneSymbolMapsForClosedSymbols(state, closedSymbols);

  state.lastManualFlush = {
    at: now,
    reason,
    source: 'VERCEL_ADMIN_FLUSH_OPEN_POSITIONS',
    openBefore: openPositions.length,
    exitsCreated: manualExits.length,
    symbolsCleared: closedSymbols.size,
    includeClosedTrades: body.includeClosedTrades === true,
    pruneRecentEntries,
  };

  await callSave(save.fn, state, reason);

  return res.status(200).json({
    ok: true,
    dryRun: false,
    strategyVersion: STRATEGY_VERSION,

    loader: {
      name: load.name,
      path: load.path,
    },

    saver: {
      name: save.name,
      path: save.path,
    },

    openBefore: openPositions.length,
    openAfter: collectOpenPositions(state).length,
    exitsCreated: manualExits.length,
    symbolsCleared: closedSymbols.size,

    countsAfterMutation: {
      entries: asArray(state.entries).length,
      exits: asArray(state.exits).length,
      closedTrades: asArray(state.closedTrades).length,
      recentEntries: asArray(state.recentEntries).length,
      memory: asArray(state.memory).length,
    },

    reason,
    durationMs: Date.now() - startedAt,
  });
}