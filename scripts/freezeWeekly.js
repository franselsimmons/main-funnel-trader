// ================= FILE: scripts/freezeWeekly.js =================

import { CONFIG } from '../src/config.js';
import { freezeWeeklyRotation } from '../src/analyze/rotationEngine.js';

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function getResultWeekKey(result, fallback = null) {
  return (
    result?.weekKey ||
    result?.sourceWeekKey ||
    result?.rotation?.sourceWeekKey ||
    fallback ||
    null
  );
}

function getResultRotationId(result) {
  return (
    result?.rotationId ||
    result?.rotation?.rotationId ||
    null
  );
}

function getResultCount(result) {
  return (
    result?.microFamilyIds?.length ||
    result?.rotation?.microFamilyIds?.length ||
    0
  );
}

async function main() {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);

  const weekKey =
    getArgValue('weekKey') ||
    getArgValue('week') ||
    undefined;

  const mode =
    getArgValue('mode') ||
    CONFIG.rotation?.mode ||
    'balanced';

  try {
    const result = await freezeWeeklyRotation({
      weekKey,
      mode
    });

    console.log(JSON.stringify({
      ok: result?.ok !== false,
      source: 'CLI_FREEZE_WEEKLY_ROTATION',
      argv,
      weekKey: getResultWeekKey(result, weekKey),
      mode,
      rotationId: getResultRotationId(result),
      selectedMicroFamilies: getResultCount(result),
      durationMs: Date.now() - startedAt,
      result
    }, null, 2));

    process.exitCode = result?.ok === false ? 1 : 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      source: 'CLI_FREEZE_WEEKLY_ROTATION',
      argv,
      weekKey: weekKey || null,
      mode,
      error: error?.message || String(error),
      stack: error?.stack,
      durationMs: Date.now() - startedAt
    }, null, 2));

    process.exitCode = 1;
  }
}

await main();