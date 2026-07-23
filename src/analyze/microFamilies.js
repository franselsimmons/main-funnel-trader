// ================= FILE: src/analyze/microFamilies.js =================
//
// Fixed Taxonomy: 75 child families (5 setups × 3 regimes × 5 confirmations)
// Symbol and execution fingerprints are METADATA ONLY - do NOT split families!
//

export const SETUP_ORDER = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

export const REGIME_ORDER = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

export const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

export const SHORT_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
export const SHORT_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
export const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

const SHORT_NAMESPACE = 'SHORT';
const SHORT_MICRO_PREFIX = 'MICRO_SHORT_';

/**
 * Build deterministic micro-family ID
 * Used for FIXED TAXONOMY (75 child families)
 * 
 * IMPORTANT: Only setup, regime, confirmation matter!
 * Symbol, execution, scanner fingerprints = METADATA ONLY
 */
export function buildShortChildTrueMicroFamilyId(setup = '', regime = '', confirmationProfile = '') {
  const s = String(setup || '').trim().toUpperCase();
  const r = String(regime || '').trim().toUpperCase();
  const c = String(confirmationProfile || '').trim().toUpperCase();
  
  if (!s || !r || !c) return null;
  if (!SHORT_FIXED_SETUP_TYPES.has(s)) return null;
  if (!SHORT_FIXED_REGIME_BUCKETS.has(r)) return null;
  if (!SHORT_CONFIRMATION_PROFILES.has(c)) return null;
  
  return `${SHORT_MICRO_PREFIX}${s}_${r}_${c}`;
}

/**
 * Build parent micro-family ID
 * Used for reference and diversity tracking
 */
export function buildShortParentTrueMicroFamilyId(setup = '', regime = '') {
  const s = String(setup || '').trim().toUpperCase();
  const r = String(regime || '').trim().toUpperCase();
  
  if (!s || !r) return null;
  if (!SHORT_FIXED_SETUP_TYPES.has(s)) return null;
  if (!SHORT_FIXED_REGIME_BUCKETS.has(r)) return null;
  
  return `${SHORT_MICRO_PREFIX}${s}_${r}`;
}

/**
 * Classify observation into micro-family
 * Returns child (75 families) + parent (15 families) IDs
 */
export function classifyMicroFamily(row = {}) {
  const setup = String(row.setup || '').trim().toUpperCase();
  const regime = String(row.regime || '').trim().toUpperCase();
  const confirmationProfile = String(row.confirmationProfile || '').trim().toUpperCase();
  
  // Normalize inputs
  const normalizedSetup = normalizeSetup(setup);
  const normalizedRegime = normalizeRegime(regime);
  const normalizedConfirmation = normalizeConfirmation(confirmationProfile);
  
  if (!normalizedSetup || !normalizedRegime || !normalizedConfirmation) {
    return {
      ok: false,
      reason: 'INVALID_TAXONOMY_INPUTS',
      childId: null,
      parentId: null
    };
  }
  
  const childId = buildShortChildTrueMicroFamilyId(
    normalizedSetup,
    normalizedRegime,
    normalizedConfirmation
  );
  
  const parentId = buildShortParentTrueMicroFamilyId(
    normalizedSetup,
    normalizedRegime
  );
  
  if (!childId || !parentId) {
    return {
      ok: false,
      reason: 'FAILED_TO_BUILD_FAMILY_IDS',
      childId: null,
      parentId: null
    };
  }
  
  return {
    ok: true,
    childId,
    parentId,
    setup: normalizedSetup,
    regime: normalizedRegime,
    confirmation: normalizedConfirmation,
    // Metadata (don't split family):
    symbol: row.symbol || null,
    scannerFingerprint: row.scannerFingerprint || null,
    executionFingerprint: row.executionFingerprint || null
  };
}

/**
 * Normalize setup (handle legacy aliases)
 */
function normalizeSetup(setup = '') {
  const s = String(setup || '').trim().toUpperCase();
  
  const aliases = {
    'BO': 'BREAKOUT',
    'BREAK': 'BREAKOUT',
    'BREAK_OUT': 'BREAKOUT',
    'BREAKOUT_SHORT': 'BREAKOUT',
    
    'RETEST_SHORT': 'RETEST',
    'PULLBACK': 'RETEST',
    'PULL_BACK': 'RETEST',
    'PB': 'RETEST',
    
    'SWEEP': 'SWEEP_REVERSAL',
    'SWEEP_REVERSE': 'SWEEP_REVERSAL',
    'SWEEP_REVERSAL_SHORT': 'SWEEP_REVERSAL',
    'REVERSAL': 'SWEEP_REVERSAL',
    'LIQ_SWEEP': 'SWEEP_REVERSAL',
    
    'CONT': 'CONTINUATION',
    'CONTINUATION_SHORT': 'CONTINUATION',
    'MOMENTUM': 'CONTINUATION',
    'TREND_CONTINUATION': 'CONTINUATION',
    
    'COMPRESS': 'COMPRESSION',
    'COMPRESSION_SHORT': 'COMPRESSION',
    'COIL': 'COMPRESSION',
    'SQUEEZE_SETUP': 'COMPRESSION'
  };
  
  return aliases[s] || s;
}

/**
 * Normalize regime (handle legacy aliases)
 */
function normalizeRegime(regime = '') {
  const r = String(regime || '').trim().toUpperCase();
  
  const aliases = {
    'TRENDING': 'TREND',
    'BEAR_TREND': 'TREND',
    'DOWNTREND': 'TREND',
    'IMPULSE': 'TREND',
    'UP_TREND': 'TREND',
    
    'RANGE': 'CHOP',
    'RANGING': 'CHOP',
    'SIDEWAYS': 'CHOP',
    'CHOPPY': 'CHOP',
    'MEAN_REVERT': 'CHOP',
    
    'VOL_SQUEEZE': 'SQUEEZE',
    'SQUEEZE_REGIME': 'SQUEEZE',
    'TIGHT_RANGE': 'SQUEEZE'
  };
  
  return aliases[r] || r;
}

/**
 * Normalize confirmation (handle legacy aliases)
 */
function normalizeConfirmation(confirmation = '') {
  const c = String(confirmation || '').trim().toUpperCase();
  
  const aliases = {
    'A': 'A_STRONG_ALIGN',
    'STRONG': 'A_STRONG_ALIGN',
    'STRONG_ALIGN': 'A_STRONG_ALIGN',
    'FULL_ALIGN': 'A_STRONG_ALIGN',
    'ALL_ALIGN': 'A_STRONG_ALIGN',
    'HIGH_CONFLUENCE': 'A_STRONG_ALIGN',
    
    'B': 'B_FLOW_ALIGN',
    'FLOW': 'B_FLOW_ALIGN',
    'FLOW_ALIGN': 'B_FLOW_ALIGN',
    'MOMENTUM_ALIGN': 'B_FLOW_ALIGN',
    
    'C': 'C_VOLUME_ALIGN',
    'VOLUME': 'C_VOLUME_ALIGN',
    'VOLUME_ALIGN': 'C_VOLUME_ALIGN',
    'VOL_ALIGN': 'C_VOLUME_ALIGN',
    'OB_VOLUME_ALIGN': 'C_VOLUME_ALIGN',
    
    'D': 'D_MIXED_OK',
    'MIXED': 'D_MIXED_OK',
    'MIXED_OK': 'D_MIXED_OK',
    'NEUTRAL_OK': 'D_MIXED_OK',
    
    'E': 'E_WEAK_CONTRA',
    'WEAK': 'E_WEAK_CONTRA',
    'WEAK_CONTRA': 'E_WEAK_CONTRA',
    'CONTRA': 'E_WEAK_CONTRA'
  };
  
  return aliases[c] || c;
}

/**
 * Check if ID is valid child micro-family
 */
export function isShortChildTrueMicroFamilyId(id = '') {
  const value = String(id || '').trim().toUpperCase();
  
  if (!value.startsWith(SHORT_MICRO_PREFIX)) return false;
  
  const parts = value.substring(SHORT_MICRO_PREFIX.length).split('_');
  if (parts.length !== 3) return false;
  
  const [setup, regime, confirmation] = parts;
  
  return (
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmation)
  );
}

/**
 * Check if ID is valid parent micro-family
 */
export function isShortParentTrueMicroFamilyId(id = '') {
  const value = String(id || '').trim().toUpperCase();
  
  if (!value.startsWith(SHORT_MICRO_PREFIX)) return false;
  
  const parts = value.substring(SHORT_MICRO_PREFIX.length).split('_');
  if (parts.length !== 2) return false;
  
  const [setup, regime] = parts;
  
  return (
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime)
  );
}

/**
 * Get all 75 possible child micro-family IDs
 */
export function getAllChildMicroFamilyIds() {
  const result = [];
  
  for (const setup of SETUP_ORDER) {
    for (const regime of REGIME_ORDER) {
      for (const confirmation of CONFIRMATION_PROFILE_ORDER) {
        const id = buildShortChildTrueMicroFamilyId(setup, regime, confirmation);
        if (id) result.push(id);
      }
    }
  }
  
  return result;
}

/**
 * Get all 15 possible parent micro-family IDs
 */
export function getAllParentMicroFamilyIds() {
  const result = [];
  
  for (const setup of SETUP_ORDER) {
    for (const regime of REGIME_ORDER) {
      const id = buildShortParentTrueMicroFamilyId(setup, regime);
      if (id) result.push(id);
    }
  }
  
  return result;
}

/**
 * Extract setup, regime, confirmation from child ID
 */
export function parseShortChildMicroFamilyId(id = '') {
  const value = String(id || '').trim().toUpperCase();
  
  if (!isShortChildTrueMicroFamilyId(value)) {
    return {
      valid: false,
      setup: null,
      regime: null,
      confirmation: null
    };
  }
  
  const parts = value.substring(SHORT_MICRO_PREFIX.length).split('_');
  const [setup, regime, confirmation] = parts;
  
  return {
    valid: true,
    setup,
    regime,
    confirmation
  };
}

export default {
  buildShortChildTrueMicroFamilyId,
  buildShortParentTrueMicroFamilyId,
  classifyMicroFamily,
  isShortChildTrueMicroFamilyId,
  isShortParentTrueMicroFamilyId,
  getAllChildMicroFamilyIds,
  getAllParentMicroFamilyIds,
  parseShortChildMicroFamilyId,
  SETUP_ORDER,
  REGIME_ORDER,
  CONFIRMATION_PROFILE_ORDER
};
