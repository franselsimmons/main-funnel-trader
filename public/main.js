function render(data){

  const f = data.funnel;

  el("statusLine").innerText =
    `BTC: ${data.btc.state} • ENTRY ${f.entry.length} • ALMOST ${f.almost.length} • BUILDUP ${f.buildup.length} • RADAR ${f.radar.length}`;

  el("stageTradeReady").innerHTML =
    f.entry.map(coinRow).join("") || "Geen ENTRY";

  el("stageAlmost").innerHTML =
    f.almost.map(coinRow).join("") || "Geen ALMOST";

  el("stageBuildup").innerHTML =
    f.buildup.map(coinRow).join("") || "Geen BUILDUP";

  el("stageRadar").innerHTML =
    f.radar.map(coinRow).join("") || "Geen RADAR";
}