import { sendMainBotEntry } from "../lib/discordNotifier.js";

function mask(value) {
  return Boolean(value);
}

function buildSignalId(type) {
  return `test_main_${type}_${Date.now()}`;
}

function buildTestSignal(type) {
  const normalizedType = String(type || "A").toUpperCase();

  const baseSignal = {
    symbol: "BTCUSDT",
    side: "BULL",
    entry: 80000,
    tp: 200000,
    sl: 100,
    rr: 2,
    sniperScore: 85,
    confluence: 88,
    leverage: 10,
    riskPct: 2,
    dryRun: true,
  };

  if (normalizedType === "GOD") {
    return {
      ...baseSignal,
      signalId: buildSignalId("GOD"),
      grade: "GOD",
      setupClass: "GOD",
    };
  }

  if (normalizedType === "B") {
    return {
      ...baseSignal,
      signalId: buildSignalId("B"),
      grade: "B",
      setupClass: "B",
    };
  }

  return {
    ...baseSignal,
    signalId: buildSignalId("A"),
    grade: "A",
    setupClass: "A",
  };
}

export default async function handler(req, res) {
  try {
    const type = String(req.query.type || "A").toUpperCase();
    const signal = buildTestSignal(type);

    const result = await sendMainBotEntry(signal);

    return res.status(200).json({
      ok: true,
      test: "signal-system-to-main-bot-flow",
      type,
      env: {
        hasMainBotEnabled: mask(process.env.MAIN_BOT_ENABLED),
        hasMainBotWebhookUrl: mask(process.env.MAIN_BOT_WEBHOOK_URL),
        hasMainBotWebhookSecret: mask(process.env.MAIN_BOT_WEBHOOK_SECRET),
        mainBotDryRun: process.env.MAIN_BOT_DRY_RUN,
        defaultRiskPct: process.env.MAIN_BOT_DEFAULT_RISK_PCT,
        defaultLeverage: process.env.MAIN_BOT_DEFAULT_LEVERAGE,
      },
      signal,
      result,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      test: "signal-system-to-main-bot-flow",
      error: error.message,
      stack: error.stack,
    });
  }
}