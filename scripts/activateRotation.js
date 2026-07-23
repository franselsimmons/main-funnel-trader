// ================= FILE: src/analyze/activateRotation.js =================
//
// Implementation: Build and activate new rotation
// CALLED BY: api/analyze/activate-rotation.js (cron Monday 00:00 UTC)
//
// Process:
//  1. Read frozen week stats
//  2. Rank families by balancedScore
//  3. Select top 42
//  4. Save as ROTATION:ACTIVE
//  5. Send Discord alert
//

import { buildRotationFromWeek, activateRotation as saveRotation } from './rotationEngine.js';
import { Redis } from '@upstash/redis';
import { keys } from '../keys.js';
import * as discord from '../discord/discord.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

/**
 * Main rotation activation function
 */
export async function activateWeeklyRotation() {
  try {
    const weekKey = 'SHORT_LIVE';
    
    // Build rotation from last week's stats
    console.log(`🔄 Building rotation from ${weekKey}...`);
    
    const buildResult = await buildRotationFromWeek(weekKey);
    
    if (!buildResult.ok) {
      console.error('Build failed:', buildResult.reason);
      return buildResult;
    }
    
    const rotation = buildResult.rotation;
    
    console.log(`✅ Built rotation: ${rotation.activeMicroFamilyIds.length} families`);
    
    // Save rotation
    console.log(`💾 Saving rotation...`);
    
    const saveResult = await saveRotation(rotation);
    
    if (!saveResult.ok) {
      console.error('Save failed:', saveResult.reason);
      return saveResult;
    }
    
    console.log(`✅ Rotation saved: ${saveResult.rotationId}`);
    
    // Send Discord alert
    console.log(`📢 Sending Discord alert...`);
    
    try {
      const families = rotation.activeMicroFamilyIds.slice(0, 5); // Top 5 for display
      const familiesStr = families.join(', ');
      const topScore = rotation.stats.topScore;
      const avgScore = rotation.stats.avgScore;
      
      await discord.sendRotationAlert({
        rotationId: rotation.rotationId,
        familiesSelected: rotation.activeMicroFamilyIds.length,
        topScore,
        avgScore,
        topFamilies: families
      });
      
      console.log(`✅ Discord alert sent`);
    } catch (discordErr) {
      console.warn(`⚠️  Discord alert failed: ${discordErr.message}`);
      // Don't fail the rotation if Discord fails
    }
    
    return {
      ok: true,
      rotationId: rotation.rotationId,
      familiesSelected: rotation.activeMicroFamilyIds.length,
      topScore: rotation.stats.topScore,
      avgScore: rotation.stats.avgScore,
      timestamp: new Date().toISOString()
    };
    
  } catch (err) {
    console.error('activateWeeklyRotation error:', err);
    return {
      ok: false,
      reason: 'ACTIVATION_FAILED',
      error: err.message
    };
  }
}

export default {
  activateWeeklyRotation
};
