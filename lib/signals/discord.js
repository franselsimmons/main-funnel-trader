// lib/signals/discord.js
//
// Discord signaling for the Main Funnel repo (Vercel/Next.js).
// - Sends structured messages to a Discord webhook.
// - Gracefully no-ops if DISCORD_WEBHOOK_URL is not set.
//
// Exports:
// - sendSignal(payload, opts?)
// - formatSignal(payload) (useful for tests)
// - sendTestPing()
//
// Env:
// - DISCORD_WEBHOOK_URL (required to actually send)
// - DISCORD_WEBHOOK_USERNAME (optional)
// - DISCORD_WEBHOOK_AVATAR_URL (optional)
// - DISCORD_WEBHOOK_TIMEOUT_MS (optional, default 8000)

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function safeStr(x, d = "") {
  const s = String(x ?? "");
  return s.length ? s : d;
}

function pickColor(kind, stage) {
  const k = String(kind || "").toLowerCase();
  const s = up(stage);

  if (k === "trade_opened") return 0x2ecc71; // green
  if (k === "trade_closed") return 0xe74c3c; // red-ish
  if (k === "elite_watch") return 0xf1c40f; // yellow
  if (k === "signal") {
    if (s.startsWith("ELITE")) return 0x3498db; // blue
    if (s === "ALMOST") return 0x9b59b6; // purple
    if (s === "BUILDUP") return 0x95a5a6; // grey
    return 0x7f8c8d; // darker grey
  }
  return 0x5865f2; // discord blurple-ish
}

function fmtPct(x) {
  const v = n(x, 0);
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function fmtUsd(x) {
  const v = n(x, 0);
  const sign = v > 0 ? "+" : "";
  return `${sign}$${v.toFixed(2)}`;
}

function shortNum(x) {
  const v = n(x, 0);
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return `${v.toFixed(0)}`;
}

function fmtPrice(x) {
  const v = n(x, 0);
  if (v >= 100) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(6);
  return v.toFixed(8);
}

function buildCoinUrl(coin) {
  // Optional: if you later add a UI route like /coin/BTC
  const sym = safeStr(coin?.symbol, "");
  if (!sym) return null;
  return null;
}

function addField(fields, name, value, inline = true) {
  if (!value) return;
  fields.push({ name, value: String(value).slice(0, 1024), inline: !!inline });
}

export function formatSignal(payload = {}) {
  const webhookUsername = safeStr(process.env.DISCORD_WEBHOOK_USERNAME, "Main Funnel");
  const webhookAvatar = safeStr(process.env.DISCORD_WEBHOOK_AVATAR_URL, "");

  const source = safeStr(payload.source, "main");
  const mode = safeStr(payload.mode, "bull");
  const stage = safeStr(payload.stage, payload.coin?.stage || "RADAR");
  const kind = safeStr(payload.kind, "signal");

  const coin = payload.coin || {};
  const symbol = safeStr(coin.symbol, safeStr(payload.symbol, ""));
  const name = safeStr(coin.name, "");
  const titleLeft = symbol ? `${symbol}${name ? ` • ${name}` : ""}` : "Signal";
  const title = `${titleLeft} — ${up(kind)} (${up(mode)} / ${up(stage)})`;

  const btcState = safeStr(payload.btcState, payload.btc?.state || "NEUTRAL");
  const reason = safeStr(payload.reason, "");

  const fields = [];

  // Price / change
  if (coin.price != null) addField(fields, "Price", `$${fmtPrice(coin.price)}`, true);
  if (coin.change1h != null) addField(fields, "1h", fmtPct(coin.change1h), true);
  if (coin.change24 != null) addField(fields, "24h", fmtPct(coin.change24), true);
  if (coin.range24 != null) addField(fields, "Range24", fmtPct(coin.range24), true);

  // Scores
  if (coin.perfectCandidateScore != null) addField(fields, "Perfect", `${n(coin.perfectCandidateScore, 0)}`, true);
  if (coin.qualityScore != null) addField(fields, "Quality", `${n(coin.qualityScore, 0)}`, true);
  if (coin.timingScore != null) addField(fields, "Timing", `${n(coin.timingScore, 0)}`, true);
  if (coin.liquidityScore != null) addField(fields, "Liquidity", `${n(coin.liquidityScore, 0)}`, true);
  if (coin.marketScore != null) addField(fields, "Market", `${n(coin.marketScore, 0)}`, true);
  if (coin.btcAlignmentScore != null) addField(fields, "BTC Align", `${n(coin.btcAlignmentScore, 0)}`, true);

  // Stage details
  if (coin.entryQuality != null) addField(fields, "EntryQuality", `${n(coin.entryQuality, 0)}`, true);
  if (coin.persistenceScore != null) addField(fields, "Persistence", `${n(coin.persistenceScore, 0)}`, true);
  if (coin.velocity != null) addField(fields, "Velocity", `${n(coin.velocity, 0).toFixed(3)}`, true);
  if (coin.vm != null) addField(fields, "VM", `${n(coin.vm, 0).toFixed(3)}`, true);

  // Orderbook
  const ob = coin.ob || {};
  if (ob.spreadPct != null) addField(fields, "Spread", `${n(ob.spreadPct, 0).toFixed(3)}%`, true);
  if (ob.depthMinUsd1p != null) addField(fields, "Depth(1%)", `$${shortNum(ob.depthMinUsd1p)}`, true);
  if (ob.score != null) addField(fields, "OB Score", `${n(ob.score, 0).toFixed(5)}`, true);

  // Trade plan
  const tp = coin.tradePlan || payload.tradePlan || null;
  if (tp) {
    addField(fields, "Plan Entry", `$${fmtPrice(tp.entry)}`, true);
    addField(fields, "Plan SL", `$${fmtPrice(tp.sl)}`, true);
    addField(fields, "Plan TP", `$${fmtPrice(tp.tp)}`, true);
    if (tp.rr != null) addField(fields, "RR", `${n(tp.rr, 0).toFixed(2)}`, true);
    if (tp.slPct != null) addField(fields, "SL%", `${n(tp.slPct, 0).toFixed(2)}%`, true);
    if (tp.tpPct != null) addField(fields, "TP%", `${n(tp.tpPct, 0).toFixed(2)}%`, true);
  }

  // Position / exit info (if included)
  const pos = payload.position || payload.pos || null;
  if (pos) {
    if (pos.pnlPct != null) addField(fields, "PnL%", fmtPct(pos.pnlPct), true);
    if (pos.pnlUsd != null) addField(fields, "PnL$", fmtUsd(pos.pnlUsd), true);
    if (pos.exitKind) addField(fields, "Exit", safeStr(pos.exitKind), true);
  }

  // Links (optional)
  const coinUrl = buildCoinUrl(coin);
  const links = [];
  if (coinUrl) links.push(`[Open coin](${coinUrl})`);

  const descriptionParts = [];
  if (reason) descriptionParts.push(`**Reason:** ${reason}`);
  descriptionParts.push(`**BTC:** ${up(btcState)}`);
  if (payload.regime) descriptionParts.push(`**Regime:** ${up(payload.regime)}`);
  if (payload.scannedAt) descriptionParts.push(`**Scan:** ${new Date(payload.scannedAt).toISOString()}`);

  const embed = {
    title: title.slice(0, 256),
    description: descriptionParts.join("\n").slice(0, 4096),
    color: pickColor(kind, stage),
    fields: fields.slice(0, 25),
    footer: { text: `source=${source}` },
    timestamp: new Date().toISOString(),
  };

  if (links.length) embed.description += `\n\n${links.join(" • ")}`;

  const body = {
    username: webhookUsername,
    embeds: [embed],
  };

  if (webhookAvatar) body.avatar_url = webhookAvatar;

 