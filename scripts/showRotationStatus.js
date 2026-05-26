#!/usr/bin/env node

import process from 'node:process';

import { readRotationStatus } from '../lib/rotation/rotationRunner.js';

function hasArg(name) {
  return process.argv.includes(name);
}

function getArgValue(name, fallback = null) {
  const index = process.argv.indexOf(name);

  if (index === -1) return fallback;

  return process.argv[index + 1] ?? fallback;
}

function printHelp() {
  console.log(`
Rotation Status Viewer

Gebruik:
  node scripts/showRotationStatus.js
  node scripts/showRotationStatus.js --json
  node scripts/showRotationStatus.js --families
  node scripts/showRotationStatus.js --side LONG
  node scripts/showRotationStatus.js --side SHORT

Opties:
  --json          Print volledige status als JSON.
  --families      Print alleen actieve families.
  --side LONG     Filter op LONG families.
  --side SHORT    Filter op SHORT families.
`);
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  return [];
}

function normalizeFamily(item) {
  if (!item || typeof item !== 'object') {
    return {
      familyId: 'UNKNOWN',
      side: 'UNKNOWN',
      status: 'UNKNOWN',
      closed: 0,
      winratePct: 0,
      avgR: 0,
      pf: 0,
      definition: '',
    };
  }

  return {
    familyId: item.familyId || item.id || item.microFamilyId || 'UNKNOWN',
    side: item.side || 'UNKNOWN',
    status: item.status || item.quality || item.label || 'UNKNOWN',
    closed: item.closed ?? item.tradesClosed ?? item.closedTrades ?? 0,
    winratePct: item.winratePct ?? item.winrate ?? item.wr ?? 0,
    avgR: item.avgR ?? item.averageR ?? 0,
    pf: item.pf ?? item.profitFactor ?? 0,
    score: item.score ?? item.rotationScore ?? item.rankScore ?? 0,
    definition: item.definition || item.labels || item.signature || '',
  };
}

function getActiveRotation(status) {
  return (
    status?.activeRotation ||
    status?.rotation ||
    status?.currentRotation ||
    status ||
    null
  );
}

function getAllowlist(status) {
  const rotation = getActiveRotation(status);

  return asArray(
    rotation?.allowlist ||
      rotation?.families ||
      rotation?.selectedFamilies ||
      status?.allowlist ||
      status?.families ||
      []
  ).map(normalizeFamily);
}

function formatNumber(value, decimals = 3) {
  const number = Number(value);

  if (!Number.isFinite(number)) return 'n/a';

  return number.toFixed(decimals);
}

function formatPct(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return 'n/a';

  if (number <= 1 && number >= 0) {
    return `${(number * 100).toFixed(1)}%`;
  }

  return `${number.toFixed(1)}%`;
}

function pad(value, length) {
  return String(value ?? '').padEnd(length).slice(0, length);
}

function printFamilyTable(families) {
  if (!families.length) {
    console.log('Geen actieve families gevonden.');
    return;
  }

  console.log(
    [
      pad('SIDE', 6),
      pad('FAMILY', 38),
      pad('STATUS', 12),
      pad('CLOSED', 8),
      pad('WR', 9),
      pad('AVG R', 9),
      pad('PF', 9),
      pad('SCORE', 9),
    ].join(' | ')
  );

  console.log('-'.repeat(118));

  for (const family of families) {
    console.log(
      [
        pad(family.side, 6),
        pad(family.familyId, 38),
        pad(family.status, 12),
        pad(family.closed, 8),
        pad(formatPct(family.winratePct), 9),
        pad(formatNumber(family.avgR), 9),
        pad(formatNumber(family.pf), 9),
        pad(formatNumber(family.score), 9),
      ].join(' | ')
    );
  }
}

function printFamilyDetails(families) {
  if (!families.length) return;

  console.log('');
  console.log('ACTIVE FAMILY DEFINITIONS');
  console.log('-------------------------');

  for (const family of families) {
    console.log('');
    console.log(`${family.side} | ${family.familyId}`);
    console.log(`Status: ${family.status}`);
    console.log(`Closed: ${family.closed}`);
    console.log(`Winrate: ${formatPct(family.winratePct)}`);
    console.log(`Avg R: ${formatNumber(family.avgR)}`);
    console.log(`PF: ${formatNumber(family.pf)}`);

    if (family.definition) {
      if (Array.isArray(family.definition)) {
        console.log(`Definition: ${family.definition.join(' | ')}`);
      } else {
        console.log(`Definition: ${family.definition}`);
      }
    }
  }
}

function printHumanStatus(status) {
  const rotation = getActiveRotation(status);
  const families = getAllowlist(status);

  const state =
    status?.state ||
    status?.status ||
    rotation?.state ||
    rotation?.status ||
    'UNKNOWN';

  const active =
    status?.active ??
    status?.isActive ??
    rotation?.active ??
    rotation?.isActive ??
    false;

  const createdAt =
    rotation?.createdAt ||
    rotation?.startedAt ||
    status?.createdAt ||
    status?.startedAt ||
    'n/a';

  const expiresAt =
    rotation?.expiresAt ||
    rotation?.validUntil ||
    status?.expiresAt ||
    status?.validUntil ||
    'n/a';

  const rotationId =
    rotation?.rotationId ||
    rotation?.id ||
    status?.rotationId ||
    status?.id ||
    'n/a';

  const mode = rotation?.mode || status?.mode || 'n/a';
  const source = rotation?.source || status?.source || 'n/a';

  const longCount = families.filter(family => family.side === 'LONG').length;
  const shortCount = families.filter(family => family.side === 'SHORT').length;

  console.log('');
  console.log('ROTATION STATUS');
  console.log('---------------');
  console.log(`State: ${state}`);
  console.log(`Active: ${active ? 'YES' : 'NO'}`);
  console.log(`Rotation ID: ${rotationId}`);
  console.log(`Mode: ${mode}`);
  console.log(`Source: ${source}`);
  console.log(`Created at: ${createdAt}`);
  console.log(`Expires at: ${expiresAt}`);
  console.log(`Families: ${families.length} total | LONG ${longCount} | SHORT ${shortCount}`);
  console.log('');

  printFamilyTable(families);
  printFamilyDetails(families);

  console.log('');
}

async function main() {
  if (hasArg('--help') || hasArg('-h')) {
    printHelp();
    return;
  }

  const status = await readRotationStatus();
  const sideFilter = getArgValue('--side', 'ALL')?.toUpperCase();

  let families = getAllowlist(status);

  if (sideFilter === 'LONG' || sideFilter === 'SHORT') {
    families = families.filter(family => family.side === sideFilter);
  }

  if (hasArg('--json')) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          status,
          filteredFamilies: families,
        },
        null,
        2
      )
    );

    return;
  }

  if (hasArg('--families')) {
    printFamilyTable(families);
    printFamilyDetails(families);
    return;
  }

  printHumanStatus({
    ...status,
    allowlist: families,
  });
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
    console.error('ROTATION STATUS FAILED');
    console.error('----------------------');
    console.error(payload.error);

    if (payload.stack) {
      console.error('');
      console.error(payload.stack);
    }
  }

  process.exitCode = 1;
});