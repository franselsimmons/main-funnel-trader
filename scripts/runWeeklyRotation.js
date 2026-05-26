import {
  loadRotationStatus,
  saveRotationStatus,
} from '../lib/rotation/rotationStore.js';

const RUNNER_MODULE_CANDIDATES = Object.freeze([
  '../lib/rotation/weeklyRotation.js',
  '../lib/rotation/rotationRunner.js',
  '../lib/rotation/rotationOrchestrator.js',
  '../lib/rotation/rotationEngine.js',
]);

const RUNNER_FUNCTION_CANDIDATES = Object.freeze([
  'runWeeklyRotation',
  'runRotationCycle',
  'rotateWeeklyFamilies',
  'createWeeklyRotation',
  'buildWeeklyRotation',
  'runFamilyRotation',
  'default',
]);

const logger = Object.freeze({
  info: (...args) => console.log('[rotation]', ...args),
  warn: (...args) => console.warn('[rotation:warn]', ...args),
  error: (...args) => console.error('[rotation:error]', ...args),
});

function parseArgs(argv = process.argv.slice(2)) {
  const args = new Set(argv);

  const getValue = name => {
    const prefix = `${name}=`;
    const found = argv.find(item => item.startsWith(prefix));

    if (!found) return null;

    return found.slice(prefix.length).trim() || null;
  };

  return {
    dryRun: args.has('--dry') || args.has('--dry-run'),
    force: args.has('--force'),
    json: args.has('--json'),
    quiet: args.has('--quiet'),
    sourceWeekKey: getValue('--source-week'),
    targetWeekKey: getValue('--target-week'),
    minClosed: Number(getValue('--min-closed') || process.env.ROTATION_MIN_CLOSED || 6),
    maxFamilies: Number(getValue('--max-families') || process.env.ROTATION_MAX_FAMILIES || 6),
  };
}

async function loadRunnerModule() {
  const errors = [];

  for (const modulePath of RUNNER_MODULE_CANDIDATES) {
    try {
      const mod = await import(modulePath);

      return {
        modulePath,
        mod,
      };
    } catch (error) {
      errors.push({
        modulePath,
        message: error?.message || String(error),
      });
    }
  }

  const message = errors
    .map(item => `- ${item.modulePath}: ${item.message}`)
    .join('\n');

  throw new Error(`Geen weekly rotation runner-module gevonden.\n${message}`);
}

function resolveRunnerFunction(mod) {
  for (const name of RUNNER_FUNCTION_CANDIDATES) {
    if (typeof mod[name] === 'function') {
      return {
        name,
        fn: mod[name],
      };
    }
  }

  throw new Error(
    `Geen geldige runner-functie gevonden. Verwacht één van: ${RUNNER_FUNCTION_CANDIDATES.join(', ')}`,
  );
}

function asArray(value) {
  if (Array.isArray(value)) return value;

  return [];
}

function extractActiveRotation(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (payload.activeRotation && typeof payload.activeRotation === 'object') {
    return payload.activeRotation;
  }

  if (payload.rotation && typeof payload.rotation === 'object') {
    return payload.rotation;
  }

  if (payload.status?.activeRotation && typeof payload.status.activeRotation === 'object') {
    return payload.status.activeRotation;
  }

  if (payload.result?.activeRotation && typeof payload.result.activeRotation === 'object') {
    return payload.result.activeRotation;
  }

  if (payload.allowlist || payload.liveAllowlist || payload.allowedFamilies || payload.families) {
    return payload;
  }

  return null;
}

function extractAllowlist(activeRotation) {
  if (!activeRotation || typeof activeRotation !== 'object') return [];

  return [
    ...asArray(activeRotation.allowlist),
    ...asArray(activeRotation.liveAllowlist),
    ...asArray(activeRotation.allowedFamilies),
    ...asArray(activeRotation.families),
  ]
    .filter(Boolean)
    .filter((item, index, arr) => {
      const familyId = item.familyId || item.id || item.microFamilyId;
      if (!familyId) return false;

      return arr.findIndex(other => {
        const otherId = other.familyId || other.id || other.microFamilyId;

        return otherId === familyId;
      }) === index;
    });
}

function normalizeRotationStatus(payload, previousStatus) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Runner gaf geen bruikbare rotation payload terug.');
  }

  if (payload.version && Object.hasOwn(payload, 'activeRotation')) {
    return payload;
  }

  if (payload.status?.version && Object.hasOwn(payload.status, 'activeRotation')) {
    return payload.status;
  }

  const activeRotation = extractActiveRotation(payload);

  if (!activeRotation) {
    throw new Error('Runner payload bevat geen activeRotation.');
  }

  const allowlist = extractAllowlist(activeRotation);

  const normalizedActiveRotation = {
    ...activeRotation,
    allowlist,
    liveAllowlist: allowlist,
    allowedFamilies: allowlist,
    families: allowlist,
  };

  return {
    version: previousStatus?.version || 1,
    mode: payload.mode || previousStatus?.mode || 'WEEKLY_ROTATION',
    updatedAt: new Date().toISOString(),
    activeRotation: normalizedActiveRotation,
    previousRotation: previousStatus?.activeRotation || previousStatus?.previousRotation || null,
    history: asArray(previousStatus?.history),
  };
}

function summarizeStatus(status) {
  const activeRotation = status?.activeRotation || null;
  const allowlist = extractAllowlist(activeRotation);

  const longCount = allowlist.filter(item => String(item.side || '').toUpperCase() === 'LONG').length;
  const shortCount = allowlist.filter(item => String(item.side || '').toUpperCase() === 'SHORT').length;

  const topRows = allowlist.slice(0, 10).map(item => ({
    familyId: item.familyId || item.id || item.microFamilyId || 'UNKNOWN',
    side: item.side || 'UNKNOWN',
    status: item.status || item.quality || 'UNKNOWN',
    closed: item.closed ?? item.trades ?? 0,
    winrate: item.winrate ?? item.wr ?? null,
    avgR: item.avgR ?? item.averageR ?? null,
    pf: item.pf ?? item.profitFactor ?? null,
    score: item.score ?? null,
  }));

  return {
    id: activeRotation?.id || null,
    weekKey: activeRotation?.weekKey || null,
    sourceWeekKey: activeRotation?.sourceWeekKey || null,
    activatedAt: activeRotation?.activatedAt || activeRotation?.selectedAt || null,
    expiresAt: activeRotation?.expiresAt || null,
    allowed: allowlist.length,
    long: longCount,
    short: shortCount,
    topRows,
  };
}

function printTextSummary(summary, options) {
  if (options.quiet) return;

  console.log('');
  console.log('WEEKLY ROTATION COMPLETE');
  console.log('------------------------');
  console.log(`Rotation ID     : ${summary.id || 'n/a'}`);
  console.log(`Target week     : ${summary.weekKey || 'n/a'}`);
  console.log(`Source week     : ${summary.sourceWeekKey || 'n/a'}`);
  console.log(`Active from     : ${summary.activatedAt || 'n/a'}`);
  console.log(`Expires at      : ${summary.expiresAt || 'n/a'}`);
  console.log(`Allowed families: ${summary.allowed} (${summary.long} LONG / ${summary.short} SHORT)`);

  if (!summary.topRows.length) {
    console.log('');
    console.log('Geen allowlist families gevonden.');
    return;
  }

  console.log('');
  console.table(summary.topRows);
}

async function main() {
  const options = parseArgs();
  const previousStatus = await loadRotationStatus().catch(() => null);

  const { modulePath, mod } = await loadRunnerModule();
  const { name, fn } = resolveRunnerFunction(mod);

  logger.info(`using ${modulePath} -> ${name}`);

  const runnerPayload = await fn({
    ...options,
    logger,
    now: new Date(),
  });

  const normalizedStatus = normalizeRotationStatus(runnerPayload, previousStatus);
  const summary = summarizeStatus(normalizedStatus);

  if (!options.dryRun) {
    await saveRotationStatus(normalizedStatus);
  }

  if (options.json) {
    console.log(JSON.stringify({
      dryRun: options.dryRun,
      runnerModule: modulePath,
      runnerFunction: name,
      summary,
      status: normalizedStatus,
    }, null, 2));

    return;
  }

  printTextSummary(summary, options);

  if (options.dryRun && !options.quiet) {
    console.log('');
    console.log('DRY RUN: rotation status is niet opgeslagen.');
  }
}

main().catch(error => {
  console.error('Weekly rotation failed');
  console.error(error);
  process.exit(1);
});