import WebSocket from "ws";
import { kv } from "@vercel/kv";

let market = {};
let positions = [];

function initWS(symbols) {
  const ws = new WebSocket("wss://ws.bitget.com/v2/ws/public");

  ws.on("open", () => {
    symbols.forEach(sym => {
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [{
          instType: "SP",
          channel: "ticker",
          instId: sym + "USDT"
        }]
      }));
    });
  });

  ws.on("message", (data) => {
    const j = JSON.parse(data);
    if (!j.data) return;

    const sym = j.arg.instId.replace("USDT", "");
    market[sym] = {
      price: Number(j.data[0].lastPr)
    };
  });
}

async function engineLoop(mode) {
  const funnel = await kv.get(`funnel:${mode}`);
  if (!funnel) return;

  const candidates = funnel.funnel.entry_ready || [];

  for (const c of candidates) {
    const live = market[c.symbol];
    if (!live) continue;

    const dist = Math.abs((live.price - c.tradePlan.entry) / c.tradePlan.entry) * 100;

    if (dist < 0.5) {
      positions.push({
        symbol: c.symbol,
        entry: live.price,
        sl: c.tradePlan.sl,
        tp: c.tradePlan.tp
      });

      console.log("TRADE OPENED:", c.symbol);
    }
  }
}

export async function initEngine(mode = "bull") {
  const funnel = await kv.get(`funnel:${mode}`);
  const symbols = (funnel?.funnel.entry_ready || []).map(x => x.symbol);

  initWS(symbols);

  setInterval(() => engineLoop(mode), 1000);
}