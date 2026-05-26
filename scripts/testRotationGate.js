import assert from 'node:assert/strict';

import {
  shouldAllowByRotation,
  isRotationTradable,
  explainRotationDecision,
} from '../lib/rotation/rotationGate.js';

const futureIso = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const pastIso = () => new Date(Date.now() - 60 * 1000).toISOString();

function makeStatus(overrides = {}) {
  return {
    activeRotation: {
      id: 'rotation_test_week',
      state: 'ACTIVE',
      active: true,
      startedAt: new Date().toISOString(),
      expiresAt: futureIso(),
      allowlist: [
        {
          familyId: 'MICRO_LONG_LONG_6_HFOQKE',
          side: 'LONG',
          status: 'STABLE',
          closed: 13,
          avgR: 0.853,
          pf: 15.286,
          winratePct: 92.3,
        },
        {
          familyId: 'MICRO_SHORT_SHORT_UNKNOWN_1OJZ169',
          side: 'SHORT',
          status: 'STABLE',
          closed: 9,
          avgR: 0.641,
          pf: 2.934,
          winratePct: 55.6,
        },
      ],
      ...overrides,
    },
  };
}

function makeSignal(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'LONG',
    microFamilyId: 'MICRO_LONG_LONG_6_HFOQKE',
    familyId: 'LONG_6',
    sniperScore: 42,
    confluence: 45,
    ...overrides,
  };
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('rotation tradable wanneer active=true en niet expired', () => {
  const status = makeStatus();
  const result = isRotationTradable(status);

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'ROTATION_ACTIVE');
  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.active, true);
});

test('rotation blokt wanneer active=false', () => {
  const status = makeStatus({ active: false });
  const result = isRotationTradable(status);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ROTATION_NOT_ACTIVE');
});

test('rotation blokt wanneer expired', () => {
  const status = makeStatus({ expiresAt: pastIso() });
  const result = isRotationTradable(status);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ROTATION_EXPIRED');
});

test('LONG signal wordt toegestaan wanneer microFamilyId in allowlist zit', () => {
  const status = makeStatus();
  const signal = makeSignal();

  const decision = shouldAllowByRotation(signal, status);

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'FAMILY_ALLOWED');
  assert.equal(decision.matchedFamily.familyId, 'MICRO_LONG_LONG_6_HFOQKE');
  assert.equal(decision.candidateSide, 'LONG');
});

test('SHORT signal wordt toegestaan wanneer microFamilyId in allowlist zit', () => {
  const status = makeStatus();
  const signal = makeSignal({
    side: 'SHORT',
    microFamilyId: 'MICRO_SHORT_SHORT_UNKNOWN_1OJZ169',
    familyId: 'SHORT_UNKNOWN',
  });

  const decision = shouldAllowByRotation(signal, status);

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'FAMILY_ALLOWED');
  assert.equal(decision.matchedFamily.familyId, 'MICRO_SHORT_SHORT_UNKNOWN_1OJZ169');
  assert.equal(decision.candidateSide, 'SHORT');
});

test('signal wordt geblokt wanneer family niet in actieve rotation zit', () => {
  const status = makeStatus();
  const signal = makeSignal({
    microFamilyId: 'MICRO_LONG_FAKE_NOT_ALLOWED',
  });

  const decision = shouldAllowByRotation(signal, status);

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'FAMILY_NOT_IN_ACTIVE_ROTATION');
});

test('signal wordt geblokt wanneer side niet matcht', () => {
  const status = makeStatus();
  const signal = makeSignal({
    side: 'SHORT',
    microFamilyId: 'MICRO_LONG_LONG_6_HFOQKE',
  });

  const decision = shouldAllowByRotation(signal, status);

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'FAMILY_NOT_IN_ACTIVE_ROTATION');
});

test('side mismatch kan bewust worden uitgezet', () => {
  const status = makeStatus();
  const signal = makeSignal({
    side: 'SHORT',
    microFamilyId: 'MICRO_LONG_LONG_6_HFOQKE',
  });

  const decision = shouldAllowByRotation(signal, status, {
    requireSideMatch: false,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'FAMILY_ALLOWED');
});

test('nested signal object wordt correct gelezen', () => {
  const status = makeStatus();

  const signal = {
    signal: {
      side: 'LONG',
      microFamilyId: 'MICRO_LONG_LONG_6_HFOQKE',
    },
  };

  const decision = shouldAllowByRotation(signal, status);

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'FAMILY_ALLOWED');
});

test('uppercase/lowercase family ids worden genormaliseerd', () => {
  const status = makeStatus();

  const signal = makeSignal({
    microFamilyId: 'micro_long_long_6_hfoqke',
  });

  const decision = shouldAllowByRotation(signal, status);

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'FAMILY_ALLOWED');
});

test('missing family id blokt standaard failClosed', () => {
  const status = makeStatus();
  const signal = {
    symbol: 'ETHUSDT',
    side: 'LONG',
  };

  const decision = shouldAllowByRotation(signal, status);

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'MISSING_CANDIDATE_FAMILY_ID');
});

test('missing family id kan failOpen worden gezet', () => {
  const status = makeStatus();
  const signal = {
    symbol: 'ETHUSDT',
    side: 'LONG',
  };

  const decision = shouldAllowByRotation(signal, status, {
    failClosed: false,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'MISSING_CANDIDATE_FAMILY_ID_FAIL_OPEN');
});

test('empty allowlist blokt standaard', () => {
  const status = makeStatus({
    allowlist: [],
  });

  const signal = makeSignal();
  const decision = shouldAllowByRotation(signal, status);

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'EMPTY_ALLOWLIST_FAIL_CLOSED');
});

test('empty allowlist kan failOpen worden gezet', () => {
  const status = makeStatus({
    allowlist: [],
  });

  const signal = makeSignal();
  const decision = shouldAllowByRotation(signal, status, {
    failClosed: false,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'EMPTY_ALLOWLIST_FAIL_OPEN');
});

test('geen rotation status blokt standaard', () => {
  const signal = makeSignal();
  const decision = shouldAllowByRotation(signal, null);

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'NO_ROTATION_STATUS');
});

test('geen rotation status kan bewust allowed worden', () => {
  const signal = makeSignal();

  const decision = shouldAllowByRotation(signal, null, {
    allowWhenNoRotation: true,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'NO_ROTATION_ALLOWED_BY_CONFIG');
});

test('disabled gate laat alles door', () => {
  const signal = makeSignal({
    microFamilyId: 'NOT_ALLOWED',
  });

  const decision = shouldAllowByRotation(signal, null, {
    enabled: false,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'GATE_DISABLED');
});

test('explainRotationDecision geeft bruikbare logregel', () => {
  const status = makeStatus();
  const signal = makeSignal();

  const decision = shouldAllowByRotation(signal, status);
  const line = explainRotationDecision(decision);

  assert.equal(typeof line, 'string');
  assert.equal(line.includes('allowed=true'), true);
  assert.equal(line.includes('FAMILY_ALLOWED'), true);
  assert.equal(line.includes('MICRO_LONG_LONG_6_HFOQKE'), true);
});

async function run() {
  let passed = 0;
  let failed = 0;

  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`✅ ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`❌ ${item.name}`);
      console.error(error);
    }
  }

  console.log('');
  console.log(`Rotation gate tests: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

run();