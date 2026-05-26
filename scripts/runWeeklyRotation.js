#!/usr/bin/env node

import process from 'node:process';

import {
  runWeeklyRotation,
  readRotationStatus,
} from '../lib/rotation/rotationRunner.js';

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;

  return fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return fallback;

  return parsed;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function getArgValue(name, fallback = null) {
  const index = process.argv.indexOf(name);

  if (index === -1) return fallback;

  return process.argv[index + 1] ?? fallback;
}

function buildOptionsFromCli() {
  const dryRun = hasArg('--dry-run') || parseBool(process.env.ROTATION_DRY_RUN, false);
  const force = hasArg('--force') || parseBool(process.env.ROTATION_FORCE, false);
  const json = hasArg('--json') || parseBool(process.env.ROTATION_JSON, false);

  const mode = getArgValue('--mode', process.env.ROTATION_MODE || 'weekly');

  const minClosed = parseNumber(
    getArgValue('--min-closed', process.env.ROTATION_MIN_CLOSED),
    undefined
  );

  const maxFamiliesPerSide = parseNumber(
    getArgValue('--max-per-side', process.env.ROTATION_MAX_PER_SIDE),
    undefined
  );

  const lookbackDays = parseNumber(
    getArgValue('--lookback-days', process.env.ROTATION_LOOKBACK_DAYS),
    undefined
  );

  return {
    dryRun,
    force,
    json,
    mode,
    minClosed,
    maxFamiliesPerSide,
    lookbackDays,
  };
}

function printHelp() {
  console.log(`
Weekly Rotation Runner

Gebruik:
  node scripts/runWeeklyRotation.js
  node scripts/runWeeklyRotation.js --dry-run
  node scripts/runWeeklyRotation.js --force
  node scripts/runWeeklyRotation.js --json

Opties:
  --dry-run              Bereken nieuwe rotatie, maar schrijf activeRotation.json niet weg.
  --force                Forceer nieuwe rotatie, ook als huidige rotatie nog actief is.
  --json                 Print machine-readable JSON.
  --mode weekly          Label voor rotatie-run. Default: weekly.
  --min-closed 20        Override minimum closed trades per family.
  --max-per-side 3       Override max families per LONG/SHORT.
  --lookback-days 7      Override lookback window.
`);
}

function cleanUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  );
}

function printHumanResult(result) {
  const rotation = result?.rotation || result?.activeRotation || null;
  const status = result?.status || null;
  const selected = rotation?.allowlist || [];

  console.log('');
  console.log('ROTATION RUN COMPLETE');
  console.log('---------------------');

  console.log(`Mode: ${result?.mode || rotation?.mode || 'n/a'}`);
  console.log(`Dry run: ${result?.dryRun ? 'YES' : 'NO'}`);
  console.log(`Rotation ID: ${rotation?.rotationId || 'n/a'}`);
  console.log(`Created at: ${rotation?.createdAt || 'n/a'}`);
  console.log(`Expires at: ${rotation?.expiresAt || 'n/a'}`);
  console.log(`Selected families: ${selected.length}`);

  if (status) {
    console.log(`Status: ${status.state || status.status || 'n/a'}`);
  }

  if (!selected.length) {
    console.log('');
    console.log('Geen families geselecteerd.');
    console.log('Meest waarschijnlijke oorzaak: nog te weinig closed trades of geen positieve Avg R.');
    return;
  }

  console.log('');
  console.log('ACTIVE ALLOWLIST');
  console.log('----------------');

  for (const item of selected) {
    const side = item.side || 'n/a';
    const familyId = item.familyId || 'n/a';
    const statusText = item.status || item.quality || 'n/a';
    const closed = item.closed ?? item.tradesClosed ?? 'n/a';
    const winrate = item.winratePct ?? item.winrate ?? 'n/a';
    const avgR = item.avgR ?? 'n/a';
    const pf = item.pf ?? item.profitFactor ?? 'n/a';

    console.log(
      `${side.padEnd(5)} | ${String(familyId).padEnd(36)} | ${String(statusText).padEnd(10)} | closed=${closed} | WR=${winrate} | avgR=${avgR} | PF=${pf}`
    );
  }

  console.log('');
}

async function main() {
  if (hasArg('--help') || hasArg('-h')) {
    printHelp();
    return;
  }

  const cliOptions = buildOptionsFromCli();

  const runOptions = cleanUndefined({
    dryRun: cliOptions.dryRun,
    force: cliOptions.force,
    mode: cliOptions.mode,
    minClosed: cliOptions.minClosed,
    maxFamiliesPerSide: cliOptions.maxFamiliesPerSide,
    lookbackDays: cliOptions.lookbackDays,
  });

  const result = await runWeeklyRotation(runOptions);
  const status = await readRotationStatus();

  const payload = {
    ok: true,
    ...result,
    status,
  };

  if (cliOptions.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHumanResult(payload);
}

main().catch(error => {
  const payload = {
    ok: false,
    error: error?.message || String(error),
    stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
  };

  if (hasArg('--json')) {
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error('');
    console.error('ROTATION RUN FAILED');
    console.error('-------------------');
    console.error(payload.error);

    if (payload.stack) {
      console.error('');
      console.error(payload.stack);
    }
  }

  process.exitCode = 1;
});