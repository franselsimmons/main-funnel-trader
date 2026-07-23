// ================= FILE: src/analyze/microFamilies.js =================
// COMPLEET micro-family taxonomy management

import { CONFIG } from '../config.js';

const PARENT_FAMILIES = [
  // 5 SETUPS × 3 REGIMES = 15 PARENTS
  { id: 'P_BREAKOUT_TREND', setup: 'BREAKOUT', regime: 'TREND' },
  { id: 'P_BREAKOUT_CHOP', setup: 'BREAKOUT', regime: 'CHOP' },
  { id: 'P_BREAKOUT_SQUEEZE', setup: 'BREAKOUT', regime: 'SQUEEZE' },
  { id: 'P_RETEST_TREND', setup: 'RETEST', regime: 'TREND' },
  { id: 'P_RETEST_CHOP', setup: 'RETEST', regime: 'CHOP' },
  { id: 'P_RETEST_SQUEEZE', setup: 'RETEST', regime: 'SQUEEZE' },
  { id: 'P_SWEEP_TREND', setup: 'SWEEP_REVERSAL', regime: 'TREND' },
  { id: 'P_SWEEP_CHOP', setup: 'SWEEP_REVERSAL', regime: 'CHOP' },
  { id: 'P_SWEEP_SQUEEZE', setup: 'SWEEP_REVERSAL', regime: 'SQUEEZE' },
  { id: 'P_CONT_TREND', setup: 'CONTINUATION', regime: 'TREND' },
  { id: 'P_CONT_CHOP', setup: 'CONTINUATION', regime: 'CHOP' },
  { id: 'P_CONT_SQUEEZE', setup: 'CONTINUATION', regime: 'SQUEEZE' },
  { id: 'P_COMP_TREND', setup: 'COMPRESSION', regime: 'TREND' },
  { id: 'P_COMP_CHOP', setup: 'COMPRESSION', regime: 'CHOP' },
  { id: 'P_COMP_SQUEEZE', setup: 'COMPRESSION', regime: 'SQUEEZE' }
];

const MICRO_CHILDREN = [
  // 5 SETUPS × 3 REGIMES × 5 CONFIRMATION = 75 CHILDREN
  // Format: { id, setup, regime, confirmation, parentId }
];

function generateMicroChildren() {
  const children = [];
  const setups = ['BREAKOUT', 'RETEST', 'SWEEP_REVERSAL', 'CONTINUATION', 'COMPRESSION'];
  const regimes = ['TREND', 'CHOP', 'SQUEEZE'];
  const confirmations = ['A_STRONG_ALIGN', 'B_FLOW_ALIGN', 'C_VOLUME_ALIGN', 'D_MIXED_OK', 'E_WEAK_CONTRA'];

  let idx = 0;
  for (const setup of setups) {
    for (const regime of regimes) {
      for (const confirmation of confirmations) {
        const parentId = PARENT_FAMILIES.find(p => p.setup === setup && p.regime === regime).id;
        children.push({
          id: `M_${setup.substring(0, 4)}_${regime.substring(0, 3)}_${confirmations.indexOf(confirmation)}`,
          setup,
          regime,
          confirmation,
          parentId,
          index: idx++
        });
      }
    }
  }
  return children;
}

const MICRO_FAMILIES = generateMicroChildren();

export function classifyMicroFamily(trade = {}) {
  const setup = trade.setup || 'UNKNOWN';
  const regime = trade.regime || 'UNKNOWN';
  const confirmation = trade.confirmationProfile || 'E_WEAK_CONTRA';

  const parent = PARENT_FAMILIES.find(p => p.setup === setup && p.regime === regime);
  if (!parent) {
    return { ok: false, reason: 'INVALID_SETUP_REGIME' };
  }

  const child = MICRO_FAMILIES.find(
    m => m.setup === setup && m.regime === regime && m.confirmation === confirmation
  );
  if (!child) {
    return { ok: false, reason: 'INVALID_CONFIRMATION' };
  }

  return {
    ok: true,
    parentId: parent.id,
    childId: child.id,
    parentSetup: parent.setup,
    parentRegime: parent.regime,
    childConfirmation: child.confirmation
  };
}

export function getMicroFamilyStats(familyId = '') {
  const family = MICRO_FAMILIES.find(f => f.id === familyId);
  if (!family) return null;

  return {
    id: family.id,
    setup: family.setup,
    regime: family.regime,
    confirmation: family.confirmation,
    parentId: family.parentId
  };
}

export function getAllParentFamilies() {
  return PARENT_FAMILIES;
}

export function getAllMicroFamilies() {
  return MICRO_FAMILIES;
}

export function getFamiliesBySetup(setup = '') {
  return MICRO_FAMILIES.filter(f => f.setup === setup);
}

export function getFamiliesByRegime(regime = '') {
  return MICRO_FAMILIES.filter(f => f.regime === regime);
}

export function getFamiliesByConfirmation(confirmation = '') {
  return MICRO_FAMILIES.filter(f => f.confirmation === confirmation);
}

export default {
  classifyMicroFamily, getMicroFamilyStats, getAllParentFamilies, getAllMicroFamilies,
  getFamiliesBySetup, getFamiliesByRegime, getFamiliesByConfirmation
};
