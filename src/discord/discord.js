// ================= FILE: src/discord/discord.js =================
// COMPLEET Discord webhook integration

import axios from 'axios';
import { CONFIG } from '../config.js';
import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, formatDuration, formatCurrency, roundTo } from '../utils.js';

const WEBHOOK_URL = CONFIG.DISCORD.WEBHOOK_URL;

export async function sendDiscordAlert(message = '', alertType = 'INFO', options = {}) {
  try {
    if (!CONFIG.DISCORD.ENABLED || !WEBHOOK_URL) {
      console.log('Discord disabled or no webhook URL');
      return { ok: false, reason: 'DISABLED' };
    }

    const typeConfig = CONFIG.DISCORD.ALERT_TYPES[alertType] || {
      emoji: 'ℹ️',
      color: 0x0088ff
    };

    const embed = {
      title: `${typeConfig.emoji} ${alertType}`,
      description: message,
      color: typeConfig.color,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'ARS-U Platform v2'
      }
    };

    if (options.fields) {
      embed.fields = options.fields;
    }

    if (options.thumbnail) {
      embed.thumbnail = { url: options.thumbnail };
    }

    const payload = {
      username: 'ARS-U Trading System',
      avatar_url: 'https://cdn-icons-png.flaticon.com/512/1995/1995467.png',
      embeds: [embed]
    };

    const response = await axios.post(WEBHOOK_URL, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    await logDiscordMessage({
      type: alertType,
      message,
      embed,
      status: 'SENT',
      timestamp: now()
    });

    return {
      ok: true,
      sent: true,
      status: response.status
    };

  } catch (err) {
    console.error('❌ Discord alert error:', err.message);

    await logDiscordMessage({
      type: alertType,
      message,
      status: 'FAILED',
      error: err.message,
      timestamp: now()
    });

    return {
      ok: false,
      sent: false,
      error: err.message
    };
  }
}

export async function sendEntryAlert(trade = {}) {
  try {
    const fields = [
      { name: 'Symbol', value: trade.symbol, inline: true },
      { name: 'Setup', value: trade.setup, inline: true },
      { name: 'Regime', value: trade.regime, inline: true },
      { name: 'Entry Price', value: formatCurrency(trade.entryPrice), inline: true },
      { name: 'Stop Loss', value: formatCurrency(trade.sl), inline: true },
      { name: 'Take Profit', value: formatCurrency(trade.tp), inline: true },
      { name: 'R/R Ratio', value: `${roundTo(trade.rrRatio, 2)}:1`, inline: true },
      { name: 'Position Size', value: `${trade.entrySize} contracts`, inline: true },
      { name: 'Risk/Reward %', value: `${roundTo(trade.riskPct * 100, 2)}% / ${roundTo(trade.rewardPct * 100, 2)}%`, inline: true }
    ];

    if (trade.microFamilyId) {
      fields.push({ name: 'Family', value: trade.microFamilyId, inline: true });
    }

    return await sendDiscordAlert(
      `**SHORT ENTRY**\n${trade.symbol} triggered on ${trade.setup} setup`,
      'ENTRY',
      { fields }
    );

  } catch (err) {
    console.error('sendEntryAlert error:', err);
    return { ok: false, error: err.message };
  }
}

export async function sendExitAlert(trade = {}) {
  try {
    const emoji = trade.exitReason === 'TAKE_PROFIT_HIT' ? '🎯' : (trade.exitReason === 'STOP_LOSS_HIT' ? '🛑' : '⚖️');
    const pnlColor = trade.netPnlR > 0 ? '✅' : '❌';

    const fields = [
      { name: 'Symbol', value: trade.symbol, inline: true },
      { name: 'Exit Reason', value: trade.exitReason, inline: true },
      { name: 'Duration', value: formatDuration(trade.durationSeconds * 1000), inline: true },
      { name: 'Entry Price', value: formatCurrency(trade.entryPrice), inline: true },
      { name: 'Exit Price', value: formatCurrency(trade.exitPrice), inline: true },
      { name: 'P&L', value: `${pnlColor} ${formatCurrency(trade.pnl)} (${roundTo(trade.pnlPercent, 2)}%)`, inline: true },
      { name: 'Net P&L', value: `${formatCurrency(trade.pnl * (1 - 0.003))} (${roundTo(trade.netPnlPercent, 2)}%)`, inline: true },
      { name: 'R-value', value: `${roundTo(trade.netPnlR, 3)}R`, inline: true }
    ];

    if (trade.microFamilyId) {
      fields.push({ name: 'Family', value: trade.microFamilyId, inline: true });
    }

    return await sendDiscordAlert(
      `${emoji} **${trade.exitReason}**\n${trade.symbol} closed at ${formatCurrency(trade.exitPrice)}`,
      'EXIT',
      { fields }
    );

  } catch (err) {
    console.error('sendExitAlert error:', err);
    return { ok: false, error: err.message };
  }
}

export async function sendScanReport(scanStats = {}) {
  try {
    const fields = [
      { name: 'Candidates Found', value: `${scanStats.candidatesCount}`, inline: true },
      { name: 'Symbols Processed', value: `${scanStats.processed}`, inline: true },
      { name: 'Qualification Rate', value: `${roundTo((scanStats.candidatesCount / Math.max(1, scanStats.processed)) * 100, 1)}%`, inline: true },
      { name: 'Market Condition', value: scanStats.weather || 'UNKNOWN', inline: true }
    ];

    if (scanStats.errors > 0) {
      fields.push({ name: 'Errors', value: `${scanStats.errors}`, inline: true });
    }

    return await sendDiscordAlert(
      `**SCAN REPORT**\nFound ${scanStats.candidatesCount} qualified candidates`,
      'SCAN_RESULT',
      { fields }
    );

  } catch (err) {
    console.error('sendScanReport error:', err);
    return { ok: false, error: err.message };
  }
}

export async function sendHaltAlert(reasons = []) {
  try {
    const fields = reasons.map((reason, i) => ({
      name: `Reason ${i + 1}`,
      value: reason,
      inline: false
    }));

    return await sendDiscordAlert(
      `**TRADING HALTED**\nRisk limits exceeded`,
      'HALT',
      { fields }
    );

  } catch (err) {
    console.error('sendHaltAlert error:', err);
    return { ok: false, error: err.message };
  }
}

export async function sendRotationAlert(rotation = {}) {
  try {
    const fields = [
      { name: 'Active Families', value: `${rotation.selectedFamilies?.length || 0}/${rotation.targetFamilies || 42}`, inline: true },
      { name: 'Activated At', value: new Date(rotation.activatedAt).toISOString(), inline: false }
    ];

    if (rotation.topFamilies && rotation.topFamilies.length > 0) {
      const topList = rotation.topFamilies.slice(0, 5).map(f => `• ${f.id}: ${roundTo(f.score, 2)}`).join('\n');
      fields.push({ name: 'Top 5 Families', value: topList, inline: false });
    }

    return await sendDiscordAlert(
      `**ROTATION ACTIVATED**\n${rotation.selectedFamilies?.length || 0} families selected for this week`,
      'ROTATION',
      { fields }
    );

  } catch (err) {
    console.error('sendRotationAlert error:', err);
    return { ok: false, error: err.message };
  }
}

export async function sendErrorAlert(error = '', context = '') {
  try {
    const fields = [
      { name: 'Error', value: error, inline: false },
      { name: 'Context', value: context || 'N/A', inline: false },
      { name: 'Time', value: new Date().toISOString(), inline: false }
    ];

    return await sendDiscordAlert(
      `**ERROR**\n${error}`,
      'ERROR',
      { fields }
    );

  } catch (err) {
    console.error('sendErrorAlert error:', err);
    return { ok: false, error: err.message };
  }
}

export async function sendDailySummary(summary = {}) {
  try {
    const fields = [
      { name: 'Trades Completed', value: `${summary.completedTrades || 0}`, inline: true },
      { name: 'Win Rate', value: `${roundTo(summary.winRate || 0, 1)}%`, inline: true },
      { name: 'Total P&L', value: formatCurrency(summary.totalPnl || 0), inline: true },
      { name: 'Largest Win', value: formatCurrency(summary.largestWin || 0), inline: true },
      { name: 'Largest Loss', value: formatCurrency(summary.largestLoss || 0), inline: true },
      { name: 'Profit Factor', value: `${roundTo(summary.profitFactor || 1, 2)}`, inline: true }
    ];

    if (summary.drawdown) {
      fields.push({ name: 'Current Drawdown', value: `${roundTo(summary.drawdown * 100, 2)}%`, inline: true });
    }

    const message = summary.totalPnl > 0 ? '✅ Daily Summary - Profitable Day!' : (summary.totalPnl < 0 ? '❌ Daily Summary - Losing Day' : '⚪ Daily Summary - Breakeven');

    return await sendDiscordAlert(
      message,
      'TRADE_UPDATE',
      { fields }
    );

  } catch (err) {
    console.error('sendDailySummary error:', err);
    return { ok: false, error: err.message };
  }
}

async function logDiscordMessage(logData = {}) {
  try {
    const redis = getRedis();
    const timestamp = logData.timestamp || now();
    const key = keys.discordLog(timestamp);

    await redis.set(key, logData);

    return { ok: true };
  } catch (err) {
    console.error('logDiscordMessage error:', err);
    return { ok: false, error: err.message };
  }
}

export async function testWebhook() {
  try {
    if (!WEBHOOK_URL) {
      return { ok: false, reason: 'NO_WEBHOOK_URL' };
    }

    const testPayload = {
      username: 'ARS-U Test',
      content: '✅ Discord webhook is working!'
    };

    const response = await axios.post(WEBHOOK_URL, testPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    return {
      ok: true,
      working: true,
      status: response.status
    };

  } catch (err) {
    console.error('testWebhook error:', err.message);
    return {
      ok: false,
      working: false,
      error: err.message
    };
  }
}

export default {
  sendDiscordAlert,
  sendEntryAlert,
  sendExitAlert,
  sendScanReport,
  sendHaltAlert,
  sendRotationAlert,
  sendErrorAlert,
  sendDailySummary,
  testWebhook
};
