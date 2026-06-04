// ================= FILE: src/discord/discord.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, pushJsonLog } from '../redis.js';

async function postDiscord(content) {
  if (!CONFIG.discord.enabled || !CONFIG.discord.webhookUrl) {
    return { ok: true, skipped: true, reason: 'DISCORD_DISABLED' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.discord.timeoutMs);
  try {
    const res = await fetch(CONFIG.discord.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(content),
      signal: controller.signal
    });
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'DISCORD_TIMEOUT' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function logDiscord(type, payload, result) {
  const redis = getDurableRedis();
  await pushJsonLog(redis, KEYS.discord.logList, {
    type,
    payload,
    result,
    ts: Date.now()
  }, CONFIG.discord.logLimit).catch(() => null);
}

export async function sendEntryAlert(entry) {
  const title = `ACTIVE MICRO ENTRY — ${entry.symbol} ${entry.side?.toUpperCase()}`;
  const mf = entry.weeklyStats || {};
  const content = {
    embeds: [{
      title,
      color: 3066993,
      fields: [
        { name: 'Reason', value: String(entry.reason || 'ACTIVE_MICRO_FAMILY_ENTRY'), inline: true },
        { name: 'MicroFamily', value: `\`${entry.microFamilyId || 'NA'}\``, inline: false },
        { name: 'Family', value: String(entry.familyId || 'NA'), inline: true },
        { name: 'Weekly Rank', value: String(mf.rank ?? 'NA'), inline: true },
        { name: 'Weekly Stats', value: `completed=${mf.completed ?? 0}\nfairWR=${((mf.fairWinrate ?? 0) * 100).toFixed(1)}%\navgR=${mf.avgR ?? 0}\ntotalR=${mf.totalR ?? 0}\nbalanced=${mf.balancedScore ?? 0}`, inline: true },
        { name: 'Risk', value: `entry=${entry.entry}\nsl=${entry.sl}\ntp=${entry.tp}\nrr=${Number(entry.rr || 0).toFixed(2)}`, inline: true },
        { name: 'Context', value: `RSI=${entry.rsiZone}\nflow=${entry.flow}\nob=${entry.obRelation}\nbtc=${entry.btcState}\nregime=${entry.regime}`, inline: true }
      ],
      timestamp: new Date().toISOString()
    }]
  };
  const result = await postDiscord(content);
  await logDiscord('ENTRY', entry, result);
  return result;
}

export async function sendExitAlert(outcome) {
  const content = {
    embeds: [{
      title: `TRADE EXIT — ${outcome.symbol} ${outcome.side?.toUpperCase()} ${outcome.exitReason}`,
      color: Number(outcome.exitR || 0) >= 0 ? 3447003 : 15158332,
      fields: [
        { name: 'MicroFamily', value: `\`${outcome.microFamilyId || 'NA'}\``, inline: false },
        { name: 'Result', value: `exitR=${outcome.exitR}\npnlPct=${outcome.pnlPct}%`, inline: true },
        { name: 'Path', value: `mfeR=${outcome.mfeR}\nmaeR=${outcome.maeR}\ndirectSL=${Boolean(outcome.directToSL)}\nnearTP=${Boolean(outcome.nearTpSeen)}`, inline: true }
      ],
      timestamp: new Date().toISOString()
    }]
  };
  const result = await postDiscord(content);
  await logDiscord('EXIT', outcome, result);
  return result;
}

export async function sendWeeklyRotationReport(rotation, label = 'WEEKLY_ROTATION') {
  const top = (rotation.microFamilies || []).slice(0, 10)
    .map(row => `#${row.rank} ${row.side} ${row.familyId} ${row.microFamilyId}\ncompleted=${row.completed} fairWR=${((row.fairWinrate || 0) * 100).toFixed(1)}% avgR=${row.avgR} balanced=${row.balancedScore}`)
    .join('\n\n') || 'No active micro families selected.';

  const content = {
    embeds: [{
      title: label,
      color: 15844367,
      fields: [
        { name: 'Rotation', value: `id=${rotation.rotationId}\nsourceWeek=${rotation.sourceWeekKey}\nactiveWeek=${rotation.activeWeekKey}\nmode=${rotation.mode}` },
        { name: 'Top active microFamilies', value: top.slice(0, 3900) }
      ],
      timestamp: new Date().toISOString()
    }]
  };
  const result = await postDiscord(content);
  await logDiscord('WEEKLY_ROTATION', rotation, result);
  return result;
}

export async function sendResetReport(report) {
  const content = {
    embeds: [{
      title: `RESET — ${report.type}`,
      color: 15105570,
      fields: [
        { name: 'Result', value: `ok=${Boolean(report.ok)}\nreason=${report.reason || 'OK'}\nopenPositions=${report.openPositionsCount ?? 'NA'}` },
        { name: 'Deleted', value: JSON.stringify(report.deleted || {}, null, 2).slice(0, 1000) }
      ],
      timestamp: new Date().toISOString()
    }]
  };
  const result = await postDiscord(content);
  await logDiscord('RESET', report, result);
  return result;
}
