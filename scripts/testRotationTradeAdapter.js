import assert from 'node:assert/strict';
import {
  loadRotationStatus,
  saveRotationStatus,
} from '../lib/rotation/rotationStore.js';

import {
  checkTradeSignalAgainstRotation,
  filterTradableSignalsByRotation,
  splitLiveAndBackgroundSignals,
  runRotationProtectedTrade,
  createRotationTradeAdapter,
} from '../lib/rotation/rotationTradeAdapter.js';

const silentLogger = Object.freeze({
  info: () => {},
  warn: () => {},
  error: () => {},
});

const TEST_LONG_FAMILY = 'MICRO_LONG_LONG_6_HFOQKE';
const TEST_SHORT_FAMILY = 'MICRO_SHORT_SHORT_UNKNOWN_1OJZ169';

function nowIso() {
  return new Date().toISOString();
}

function daysFromNowIso(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function makeAllowlistRow(overrides = {}) {
  return {
    familyId: overrides.familyId,
    side: overrides.side,
    level: overrides.level || 'MICRO',
    status: overrides.status || 'STABLE',
    closed: overrides.closed ?? 20,
    winrate: overrides.winrate ?? 70,
    avgR: overrides.avgR ?? 0.5,
    pf: overrides.pf ?? 2,
    score: overrides.score ?? 100,
    source: 'TEST',
    ...overrides,
  };
}

function makeTestRotationStatus() {
  const allowlist = [
    makeAllowlistRow({
      familyId: TEST_LONG_FAMILY,
      side: 'LONG',
      closed: 13,
      winrate: 92.3,
      avgR: 0.853,
      pf: 15.286,
    }),
    makeAllowlistRow({
      familyId: TEST_SHORT_FAMILY,
      side: 'SHORT',
      closed: 9,
      winrate: 55.6,
      avgR: 0.641,
      pf: 2.934,
    }),
  ];

  return {
    version: 1,
    mode: 'TEST',
    updatedAt: nowIso(),

    activeRotation: {
      id: `TEST_ROTATION_${Date.now()}`,
      weekKey: '2099-W01',
      sourceWeekKey: '2098-W52',
      selectedAt: nowIso(),
      activatedAt: nowIso(),
      expiresAt: daysFromNowIso(7),

      // Main field used by the live gate.
      allowlist,

      // Extra aliases so older/newer gate versions still read this safely.
      liveAllowlist: allowlist,
      allowedFamilies: allowlist,
      families: allowlist,

      meta: {
        createdBy: 'scripts/testRotationTradeAdapter.js',
        purpose: 'integration_test',
      },
    },

    previousRotation: null,
    history: [],
  };
}

function makeSignal(overrides = {}) {
  const side = overrides.side || 'LONG';
  const familyId = overrides.familyId || TEST_LONG_FAMILY;

  return {
    tradeId: overrides.tradeId || `TEST_${side}_${Date.now()}`,
    symbol: overrides.symbol || 'BTCUSDT',
    side,
    familyId,
    microFamilyId: familyId,
    level: 'MICRO',

    confluence: overrides.confluence ?? 80,
    sniperScore: overrides.sniperScore ?? 80,
    score: overrides.score ?? 80,
    rr: overrides.rr ?? 1.25,

    stage: overrides.stage || 'ENTRY',
    flow: overrides.flow || 'FLOW_TREND',
    session: overrides.session || 'EU',

    ...overrides,
  };
}

async function restoreOriginalStatus(originalStatus) {
  if (!originalStatus || typeof originalStatus !== 'object') {
    await saveRotationStatus({
      version: 1,
      mode: 'EMPTY_AFTER_TEST',
      updatedAt: nowIso(),
      activeRotation: null,
      previousRotation: null,
      history: [],
    });

    return;
  }

  await saveRotationStatus(originalStatus);
}

async function testSingleAllowedLong() {
  const signal = makeSignal({
    tradeId: 'TEST_ALLOWED_LONG',
    side: 'LONG',
    familyId: TEST_LONG_FAMILY,
  });

  const result = await checkTradeSignalAgainstRotation(signal, {
    logger: silentLogger,
    requireSideMatch: true,
  });

  assert.equal(result.allowed, true, 'allowed long should pass');
  assert.equal(result.rejected, false, 'allowed long should not be rejected');
  assert.equal(result.signal.rotation.allowed, true, 'rotation decision should be attached');
  assert.equal(result.signal.rotation.familyId, TEST_LONG_FAMILY, 'family id should match');

  return result;
}

async function testSingleAllowedShort() {
  const signal = makeSignal({
    tradeId: 'TEST_ALLOWED_SHORT',
    side: 'SHORT',
    familyId: TEST_SHORT_FAMILY,
  });

  const result = await checkTradeSignalAgainstRotation(signal, {
    logger: silentLogger,
    requireSideMatch: true,
  });

  assert.equal(result.allowed, true, 'allowed short should pass');
  assert.equal(result.rejected, false, 'allowed short should not be rejected');
  assert.equal(result.signal.rotation.allowed, true, 'rotation decision should be attached');
  assert.equal(result.signal.rotation.familyId, TEST_SHORT_FAMILY, 'family id should match');

  return result;
}

async function testRejectedUnknownFamily() {
  const signal = makeSignal({
    tradeId: 'TEST_REJECT_UNKNOWN_FAMILY',
    side: 'LONG',
    familyId: 'MICRO_LONG_NOT_IN_ROTATION',
  });

  const result = await checkTradeSignalAgainstRotation(signal, {
    logger: silentLogger,
    requireSideMatch: true,
  });

  assert.equal(result.allowed, false, 'unknown family should be rejected');
  assert.equal(result.rejected, true, 'unknown family should be rejected');
  assert.equal(result.signal.rotation.allowed, false, 'rotation decision should be attached');

  return result;
}

async function testRejectedSideMismatch() {
  const signal = makeSignal({
    tradeId: 'TEST_REJECT_SIDE_MISMATCH',
    side: 'SHORT',
    familyId: TEST_LONG_FAMILY,
  });

  const result = await checkTradeSignalAgainstRotation(signal, {
    logger: silentLogger,
    requireSideMatch: true,
  });

  assert.equal(result.allowed, false, 'same family with wrong side should be rejected');
  assert.equal(result.rejected, true, 'side mismatch should be rejected');

  return result;
}

async function testBatchFilter() {
  const signals = [
    makeSignal({
      tradeId: 'BATCH_ALLOWED_LONG',
      side: 'LONG',
      familyId: TEST_LONG_FAMILY,
    }),
    makeSignal({
      tradeId: 'BATCH_ALLOWED_SHORT',
      side: 'SHORT',
      familyId: TEST_SHORT_FAMILY,
    }),
    makeSignal({
      tradeId: 'BATCH_REJECTED',
      side: 'LONG',
      familyId: 'MICRO_LONG_NOT_ALLOWED',
    }),
  ];

  const result = await filterTradableSignalsByRotation(signals, {
    logger: silentLogger,
    requireSideMatch: true,
  });

  assert.equal(result.summary.input, 3, 'batch input should be 3');
  assert.equal(result.summary.allowed, 2, 'batch allowed should be 2');
  assert.equal(result.summary.rejected, 1, 'batch rejected should be 1');
  assert.equal(result.allowed.length, 2, 'allowed list should have 2 items');
  assert.equal(result.rejected.length, 1, 'rejected list should have 1 item');

  return result;
}

async function testSplitLiveAndBackground() {
  const signals = [
    makeSignal({
      tradeId: 'SPLIT_ALLOWED_LONG',
      side: 'LONG',
      familyId: TEST_LONG_FAMILY,
    }),
    makeSignal({
      tradeId: 'SPLIT_BACKGROUND_ONLY',
      side: 'SHORT',
      familyId: 'MICRO_SHORT_NOT_ALLOWED',
    }),
  ];

  const result = await splitLiveAndBackgroundSignals(signals, {
    logger: silentLogger,
    requireSideMatch: true,
  });

  assert.equal(result.liveTradable.length, 1, 'liveTradable should have 1 item');
  assert.equal(result.backgroundOnly.length, 1, 'backgroundOnly should have 1 item');
  assert.equal(result.allSignalsForAnalytics.length, 2, 'analytics should keep all signals');

  return result;
}

async function testProtectedExecution() {
  let executedCount = 0;

  const allowedSignal = makeSignal({
    tradeId: 'PROTECTED_ALLOWED',
    side: 'LONG',
    familyId: TEST_LONG_FAMILY,
  });

  const rejectedSignal = makeSignal({
    tradeId: 'PROTECTED_REJECTED',
    side: 'LONG',
    familyId: 'MICRO_LONG_BLOCKED',
  });

  const allowedResult = await runRotationProtectedTrade(
    allowedSignal,
    async signal => {
      executedCount += 1;

      return {
        orderSent: true,
        tradeId: signal.tradeId,
      };
    },
    {
      logger: silentLogger,
      requireSideMatch: true,
    },
  );

  const rejectedResult = await runRotationProtectedTrade(
    rejectedSignal,
    async signal => {
      executedCount += 1;

      return {
        orderSent: true,
        tradeId: signal.tradeId,
      };
    },
    {
      logger: silentLogger,
      requireSideMatch: true,
    },
  );

  assert.equal(allowedResult.executed, true, 'allowed protected trade should execute');
  assert.equal(allowedResult.skipped, false, 'allowed protected trade should not skip');

  assert.equal(rejectedResult.executed, false, 'rejected protected trade should not execute');
  assert.equal(rejectedResult.skipped, true, 'rejected protected trade should skip');

  assert.equal(executedCount, 1, 'executeFn should run only once');

  return {
    allowedResult,
    rejectedResult,
  };
}

async function testFactoryAdapter() {
  const adapter = createRotationTradeAdapter({
    logger: silentLogger,
    requireSideMatch: true,
  });

  const signal = makeSignal({
    tradeId: 'FACTORY_ALLOWED',
    side: 'LONG',
    familyId: TEST_LONG_FAMILY,
  });

  const result = await adapter.check(signal);

  assert.equal(result.allowed, true, 'factory adapter check should allow valid family');

  return result;
}

async function main() {
  console.log('RotationTradeAdapter test started');

  let originalStatus = null;

  try {
    originalStatus = await loadRotationStatus();
  } catch {
    originalStatus = null;
  }

  try {
    const testStatus = makeTestRotationStatus();
    await saveRotationStatus(testStatus);

    const loaded = await loadRotationStatus();

    assert.equal(
      loaded?.activeRotation?.allowlist?.length,
      2,
      'test rotation should have 2 allowed families',
    );

    await testSingleAllowedLong();
    await testSingleAllowedShort();
    await testRejectedUnknownFamily();
    await testRejectedSideMismatch();
    await testBatchFilter();
    await testSplitLiveAndBackground();
    await testProtectedExecution();
    await testFactoryAdapter();

    console.log('RotationTradeAdapter test passed');
  } finally {
    await restoreOriginalStatus(originalStatus);
    console.log('Original rotation status restored');
  }
}

main().catch(error => {
  console.error('RotationTradeAdapter test failed');
  console.error(error);
  process.exit(1);
});