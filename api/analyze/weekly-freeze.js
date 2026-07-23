// ================= FILE: api/analyze/weekly-freeze.js =================
//
// Vercel cron handler: Sunday 22:00 UTC
// Closes the current week, prevents further updates
// MUST BE in vercel.json crons!
//

import { freezeWeek } from '../../src/analyze/freezeWeekly.js';

export default async function handler(req, res) {
  // Verify cron request
  if (req.headers['x-vercel-cron'] !== 'true') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const result = await freezeWeek();
    
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        reason: result.reason,
        message: 'Weekly freeze failed'
      });
    }
    
    return res.status(200).json({
      ok: true,
      message: 'Weekly freeze completed',
      details: result
    });
    
  } catch (err) {
    console.error('weekly-freeze cron error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
