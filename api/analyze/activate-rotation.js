// ================= FILE: api/analyze/activate-rotation.js =================
//
// Vercel cron handler: Monday 00:00 UTC
// Activates new rotation based on last week's stats
// Selects top 42 families
// MUST BE in vercel.json crons!
//

import { activateWeeklyRotation } from '../../src/analyze/activateRotation.js';

export default async function handler(req, res) {
  // Verify cron request
  if (req.headers['x-vercel-cron'] !== 'true') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const result = await activateWeeklyRotation();
    
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        reason: result.reason,
        message: 'Rotation activation failed'
      });
    }
    
    return res.status(200).json({
      ok: true,
      message: 'Rotation activated',
      details: result
    });
    
  } catch (err) {
    console.error('activate-rotation cron error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
