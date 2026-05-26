import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const REQUIRED_FILES = Object.freeze([
  'lib/rotation/rotationStore.js',
  'scripts/runWeeklyRotation.js',
]);

const OPTIONAL_FILES = Object.freeze([
  'lib/rotation/rotationConfig.js',
  'lib/rotation/weekKey.js',
  'lib/rotation/weeklyRotation.js',
  'lib/rotation/rotationRunner.js',
  'lib/rotation/liveFamilyGate.js',
  'lib/rotation/familyGate.js',
  'lib/rotation/rotationMetrics.js',
  'lib/rotation/familyScoring.js',
]);

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

const STORE_MODULE_PATH = '../lib/rotation/rotationStore.js';

const GATE_MODULE_CANDIDATES = Object.freeze([
  '../lib/rotation/liveFamilyGate.js',
  '../lib/rotation/familyGate.js',
  '../lib/rotation/rotationGate.js',
]);

const GATE_FUNCTION_CANDIDATES = Object.freeze([
  'isFamilyAllowedForLive',
  'shouldAllowLiveFamily',
  'shouldAllowTrade',
  'isTradeAllowedByRotation',
  'applyLiveFamilyGate',
  'default',
]);

const logger = Object.freeze({
  info: (...args) => console.log('[test]', ...args),
  warn: (...args) => console.warn('[test:warn]', ...args),
  error: (...args) => console.error('[test:error]', ...args),
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
    json: args.has('--json'),
    quiet: args.has('--quiet'),
    strict: args.has('--strict'),
    minClosed: Number(getValue('--min-closed') || 1),
    maxFamilies: Number(getValue('--max-families') || 6),
  };
}

function createResult(name) {
  return {
    name,
    status: 'PENDING',
    message: '',
    details: null,
  };
}

function pass(result, message = 'OK', details = null) {
  result.status = 'PASS';
  result.message = message;
  result.details = details;

  return result;
}

function warn(result, message, details = null) {
  result.status = 'WARN';
  result.message = message;
  result.details = details;

  return result;
}

function fail(result, error, details = null) {
  result.status = 'FAIL';
  result.message = error?.message || String(error);
  result.details = details;

  return result;
}

function asArray(value) {
  if (Array.isArray(value)) return value;

  return [];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function pathExists(relativePath) {
  try {
    await fs.access(path.resolve(ROOT_DIR, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function importCandidate(modulePaths) {
  const errors = [];

  for (const modulePath of modulePaths) {
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

  throw new Error(`Geen module gevonden.\n${message}`);
}

function pickFunction(mod, candidates) {
  for (const name of candidates) {
    if (typeof mod[name] === 'function') {
      return {
        name,
        fn: mod[name],
      };
    }
  }

  throw new Error(`Geen geldige functie gevonden. Kandidaten: ${candidates.join(', ')}`);
}

function extractActiveRotation(payload) {
  if (!isObject(payload)) return null;

  if (isObject(payload.activeRotation)) return payload.activeRotation;
  if (isObject(payload.rotation)) return payload.rotation;
  if (isObject(payload.status?.activeRotation)) return payload.status.activeRotation;
  if (isObject(payload.result?.activeRotation)) return payload.result.activeRotation;

  if (
    payload.allowlist ||
    payload.liveAllowlist ||
    payload.allowedFamilies ||
    payload.families
  ) {
    return payload;
  }

  return null;
}

function extractAllowlist(activeRotation) {
  if (!isObject(activeRotation)) return [];

  const rows = [
    ...asArray(activeRotation.allowlist),
    ...asArray(activeRotation.liveAllowlist),
    ...asArray(activeRotation.allowedFamilies),
    ...asArray(activeRotation.families),
  ];

  const seen = new Set();

  return rows.filter(row => {
    if (!isObject(row)) return false;

    const familyId = row.familyId || row.id || row.microFamilyId;
    if (!familyId) return false;
    if (seen.has(familyId)) return false;

    seen.add(familyId);
    return true;
  });
}

function summarizeAllowlist(allowlist) {
  const long = allowlist.filter(row => String(row.side || '').toUpperCase() === 'LONG').length;
  const short = allowlist.filter(row => String(row.side || '').toUpperCase() === 'SHORT').length;

  return {
    total: allowlist.length,
    long,
    short,
    top: allowlist.slice(0, 6).map(row => ({
      familyId: row.familyId || row.id || row.microFamilyId || 'UNKNOWN',
      side: row.side || 'UNKNOWN',
      status: row.status || row.quality || 'UNKNOWN',
      closed: row.closed ?? row.trades ?? row.observed ?? 0,
      winrate: row.winrate ?? row.wr ?? null,
      avgR: row.avgR ?? row.averageR ?? null,
      pf: row.pf ?? row.profitFactor ?? null,
      score: row.score ?? null,
    })),
  };
}

async function testRequiredFiles() {
  const result = createResult('required files');

  try {
    const missing = [];

    for (const file of REQUIRED_FILES) {
      const exists = await pathExists(file);

      if (!exists) missing.push(file);
    }

    if (missing.length) {
      throw new Error(`Ontbrekende verplichte bestanden: ${missing.join(', ')}`);
    }

    return pass(result, 'Alle verplichte bestanden bestaan.');
  } catch (error) {
    return fail(result, error);
  }
}

async function testOptionalFiles() {
  const result = createResult('optional files');

  try {
    const present = [];
    const missing = [];

    for (const file of OPTIONAL_FILES) {
      const exists = await pathExists(file);

      if (exists) present.push(file);
      else missing.push(file);
    }

    if (missing.length) {
      return warn(result, 'Sommige optionele modules ontbreken.', {
        present,
        missing,
      });
    }

    return pass(result, 'Alle optionele modules bestaan.', {
      present,
    });
  } catch (error) {
    return fail(result, error);
  }
}

async function testRotationStore() {
  const result = createResult('rotation store');

  try {
    const store = await import(STORE_MODULE_PATH);

    if (typeof store.loadRotationStatus !== 'function') {
      throw new Error('loadRotationStatus ontbreekt.');
    }

    if (typeof store.saveRotationStatus !== 'function') {
      throw new Error('saveRotationStatus ontbreekt.');
    }

    const status = await store.loadRotationStatus().catch(error => ({
      loadWarning: error?.message || String(error),
    }));

    return pass(result, 'Store import en functies OK.', {
      hasStatus: isObject(status) && !status.loadWarning,
      loadWarning: status?.loadWarning || null,
    });
  } catch (error) {
    return fail(result, error);
  }
}

async function testRunnerDryRun(options) {
  const result = createResult('weekly runner dry-run');

  try {
    const { modulePath, mod } = await importCandidate(RUNNER_MODULE_CANDIDATES);
    const { name, fn } = pickFunction(mod, RUNNER_FUNCTION_CANDIDATES);

    const payload = await fn({
      dryRun: true,
      force: true,
      minClosed: options.minClosed,
      maxFamilies: options.maxFamilies,
      now: new Date(),
      logger,
    });

    if (!isObject(payload)) {
      throw new Error('Runner gaf geen object terug.');
    }

    const activeRotation = extractActiveRotation(payload);

    if (!activeRotation) {
      return warn(result, 'Runner draait, maar gaf nog geen activeRotation terug.', {
        modulePath,
        functionName: name,
        payloadKeys: Object.keys(payload),
      });
    }

    const allowlist = extractAllowlist(activeRotation);
    const summary = summarizeAllowlist(allowlist);

    if (!allowlist.length) {
      return warn(result, 'Runner draait, maar allowlist is leeg. Waarschijnlijk nog te weinig bruikbare data.', {
        modulePath,
        functionName: name,
        activeRotationKeys: Object.keys(activeRotation),
        summary,
      });
    }

    return pass(result, 'Runner dry-run OK.', {
      modulePath,
      functionName: name,
      summary,
    });
  } catch (error) {
    return fail(result, error);
  }
}

async function testGateModule() {
  const result = createResult('live gate module');

  try {
    const { modulePath, mod } = await importCandidate(GATE_MODULE_CANDIDATES);
    const { name } = pickFunction(mod, GATE_FUNCTION_CANDIDATES);

    return pass(result, 'Live gate module gevonden.', {
      modulePath,
      functionName: name,
    });
  } catch (error) {
    return warn(result, 'Geen live gate module gevonden of nog niet nodig.', {
      message: error?.message || String(error),
    });
  }
}

function countStatuses(results) {
  return results.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;

    return acc;
  }, {});
}

function printResults(results, options) {
  if (options.quiet) return;

  console.log('');
  console.log('WEEKLY ROTATION TEST');
  console.log('--------------------');

  console.table(results.map(row => ({
    test: row.name,
    status: row.status,
    message: row.message,
  })));

  const counts = countStatuses(results);

  console.log('');
  console.log(`PASS : ${counts.PASS || 0}`);
  console.log(`WARN : ${counts.WARN || 0}`);
  console.log(`FAIL : ${counts.FAIL || 0}`);

  const warnings = results.filter(row => row.status === 'WARN');
  const failures = results.filter(row => row.status === 'FAIL');

  if (warnings.length) {
    console.log('');
    console.log('Warnings:');
    for (const row of warnings) {
      console.log(`- ${row.name}: ${row.message}`);
    }
  }

  if (failures.length) {
    console.log('');
    console.log('Failures:');
    for (const row of failures) {
      console.log(`- ${row.name}: ${row.message}`);
    }
  }

  const runnerResult = results.find(row => row.name === 'weekly runner dry-run');

  if (runnerResult?.details?.summary?.top?.length) {
    console.log('');
    console.log('Dry-run allowlist top:');
    console.table(runnerResult.details.summary.top);
  }
}

async function main() {
  const options = parseArgs();

  const results = [
    await testRequiredFiles(),
    await testOptionalFiles(),
    await testRotationStore(),
    await testRunnerDryRun(options),
    await testGateModule(),
  ];

  const counts = countStatuses(results);
  const hasFailure = Boolean(counts.FAIL);
  const hasWarning = Boolean(counts.WARN);

  if (options.json) {
    console.log(JSON.stringify({
      ok: !hasFailure,
      strictOk: !hasFailure && !hasWarning,
      counts,
      results,
    }, null, 2));
  } else {
    printResults(results, options);
  }

  if (hasFailure) {
    process.exit(1);
  }

  if (options.strict && hasWarning) {
    process.exit(2);
  }
}

main().catch(error => {
  console.error('Weekly rotation test crashed');
  console.error(error);
  process.exit(1);
});