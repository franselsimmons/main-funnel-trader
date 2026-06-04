// ================= FILE: scripts/activateRotation.js =================

import { activateNextRotation } from '../src/analyze/rotationEngine.js';

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function getResultWeekKey(result, fallback = null) {
  return (
    result?.weekKey ||
    result?.activeRotation?.activeWeekKey ||
    result?.activeRotation?.sourceWeekKey ||
    fallback ||
    null
  );
}

function getResultRotationId(result) {
  return (
    result?.rotationId ||
    result?.activeRotation?.rotationId ||
    null
  );
}

function getActivatedCount(result) {
  return (
    result?.activeRotation?.microFamilyIds?.length ||
    result?.microFamilyIds?.length ||
    0
  );
}

async function main() {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);

  const options = {
    force: hasFlag('force'),
    weekKey: getArgValue('weekKey') || getArgValue('week') || undefined
  };

  try {
    const result = await activateNextRotation();

    console.log(JSON.stringify({
      ok: result?.ok !== false,
      source: 'CLI_ACTIVATE_NEXT_ROTATION',
      argv,
      requested: options,
      weekKey: getResultWeekKey(result, options.weekKey || null),
      rotationId: getResultRotationId(result),
      activatedMicroFamilies: getActivatedCount(result),
      durationMs: Date.now() - startedAt,
      result
    }, null, 2));

    process.exitCode = result?.ok === false ? 1 : 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      source: 'CLI_ACTIVATE_NEXT_ROTATION',
      argv,
      requested: options,
      error: error?.message || String(error),
      stack: error?.stack,
      durationMs: Date.now() - startedAt
    }, null, 2));

    process.exitCode = 1;
  }
}

await main();