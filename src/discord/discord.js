// ================= FILE: src/discord/discord.js =================
//
// Discord webhook integration
// Sends alerts for: position entry, position exit, rotation activation
//

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

/**
 * Send raw message to Discord
 */
async function sendMessage(content = '') {
  try {
    if (!WEBHOOK_URL) {
      console.warn('⚠️  Discord webhook not configured');
      return {
        ok: false,
        reason: 'WEBHOOK_NOT_CONFIGURED'
      };
    }
    
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    
    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP_${response.status}`
      };
    }
    
    return {
      ok: true,
      sent: true
    };
    
  } catch (err) {
    console.error('Discord send error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Send embed message
 */
async function sendEmbed(embed = {}) {
  try {
    if (!WEBHOOK_URL) {
      console.warn('⚠️  Discord webhook not configured');
      return {
        ok: false,
        reason: 'WEBHOOK_NOT_CONFIGURED'
      };
    }
    
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [embed]
      })
    });
    
    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP_${response.status}`
      };
    }
    
    return {
      ok: true,
      sent: true
    };
    
  } catch (err) {
    console.error('Discord embed error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Position ENTRY alert
 * CALLED BY: TradeSystem when position is created
 */
export async function sendEntryAlert({
  symbol = '',
  side = 'SHORT',
  entryPrice = 0,
  tp = null,
  sl = null,
  risk = 0.01,
  microFamilyId = '',
  microFamilyScore = 0,
  size = 0,
  timestamp = Date.now()
} = {}) {
  
  try {
    const emoji = side === 'SHORT' ? '📉' : '📈';
    const riskPoints = (risk * 100).toFixed(2);
    const scoreStr = microFamilyScore > 0 ? `(Score: ${microFamilyScore.toFixed(1)})` : '';
    
    const embed = {
      title: `${emoji} ENTRY ALERT`,
      description: `${symbol} ${side}`,
      fields: [
        {
          name: 'Entry Price',
          value: `${entryPrice.toFixed(2)}`,
          inline: true
        },
        {
          name: 'Take Profit',
          value: tp ? `${tp.toFixed(2)}` : 'N/A',
          inline: true
        },
        {
          name: 'Stop Loss',
          value: sl ? `${sl.toFixed(2)}` : 'N/A',
          inline: true
        },
        {
          name: 'Risk',
          value: `${riskPoints}% (1R)`,
          inline: true
        },
        {
          name: 'Micro Family',
          value: `${microFamilyId} ${scoreStr}`,
          inline: false
        }
      ],
      color: side === 'SHORT' ? 16711680 : 65280, // Red for SHORT, Green for LONG
      timestamp: new Date(timestamp).toISOString()
    };
    
    return await sendEmbed(embed);
    
  } catch (err) {
    console.error('sendEntryAlert error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Position EXIT alert
 * CALLED BY: PositionEngine when position closes
 */
export async function sendExitAlert({
  symbol = '',
  side = 'SHORT',
  entryPrice = 0,
  exitPrice = 0,
  netR = 0,
  costR = 0,
  pnlPct = 0,
  outcome = 'UNCLEAR',
  hitTP = false,
  hitSL = false,
  microFamilyId = '',
  timestamp = Date.now()
} = {}) {
  
  try {
    const resultEmoji = netR > 0 ? '✅' : netR < 0 ? '❌' : '⚪';
    const tpEmoji = hitTP ? '🎯' : '';
    const slEmoji = hitSL ? '🔴' : '';
    
    const pnlStr = netR > 0
      ? `+${netR.toFixed(2)}R`
      : `${netR.toFixed(2)}R`;
    
    const embed = {
      title: `${resultEmoji} EXIT ALERT`,
      description: `${symbol} ${side} ${tpEmoji}${slEmoji}`,
      fields: [
        {
          name: 'Entry → Exit',
          value: `${entryPrice.toFixed(2)} → ${exitPrice.toFixed(2)}`,
          inline: true
        },
        {
          name: 'Net R',
          value: pnlStr,
          inline: true
        },
        {
          name: 'P&L %',
          value: `${(pnlPct * 100).toFixed(2)}%`,
          inline: true
        },
        {
          name: 'Cost',
          value: `-${costR.toFixed(2)}R`,
          inline: true
        },
        {
          name: 'Outcome',
          value: outcome,
          inline: true
        },
        {
          name: 'Micro Family',
          value: microFamilyId,
          inline: false
        }
      ],
      color: netR > 0 ? 65280 : netR < 0 ? 16711680 : 16776960, // Green, Red, Yellow
      timestamp: new Date(timestamp).toISOString()
    };
    
    return await sendEmbed(embed);
    
  } catch (err) {
    console.error('sendExitAlert error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * ROTATION ACTIVATION alert
 * CALLED BY: activateRotation when new rotation is activated
 */
export async function sendRotationAlert({
  rotationId = '',
  familiesSelected = 0,
  topScore = 0,
  avgScore = 0,
  topFamilies = [],
  timestamp = Date.now()
} = {}) {
  
  try {
    const familiesList = topFamilies.length > 0
      ? topFamilies.slice(0, 3).join('\n')
      : 'N/A';
    
    const embed = {
      title: '🔄 ROTATION ACTIVATED',
      description: `Weekly rotation updated`,
      fields: [
        {
          name: 'Families Selected',
          value: `${familiesSelected}/75 (Top performers)`,
          inline: true
        },
        {
          name: 'Top Score',
          value: `${topScore.toFixed(1)}`,
          inline: true
        },
        {
          name: 'Avg Score',
          value: `${avgScore.toFixed(1)}`,
          inline: true
        },
        {
          name: 'Top 3 Families',
          value: familiesList || 'Computing...',
          inline: false
        },
        {
          name: 'Rotation ID',
          value: rotationId,
          inline: false
        }
      ],
      color: 7419530, // Purple
      timestamp: new Date(timestamp).toISOString()
    };
    
    return await sendEmbed(embed);
    
  } catch (err) {
    console.error('sendRotationAlert error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * System status alert
 */
export async function sendStatusAlert({
  status = 'UNKNOWN',
  message = '',
  details = {}
} = {}) {
  
  try {
    const colorMap = {
      'OK': 65280,
      'WARNING': 16776960,
      'ERROR': 16711680
    };
    
    const color = colorMap[status] || 9807270;
    
    const embed = {
      title: `📊 ${status}`,
      description: message,
      fields: Object.entries(details).map(([key, value]) => ({
        name: key,
        value: String(value),
        inline: true
      })),
      color,
      timestamp: new Date().toISOString()
    };
    
    return await sendEmbed(embed);
    
  } catch (err) {
    console.error('sendStatusAlert error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export default {
  sendMessage,
  sendEmbed,
  sendEntryAlert,
  sendExitAlert,
  sendRotationAlert,
  sendStatusAlert
};
