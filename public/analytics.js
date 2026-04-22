const el = id => document.getElementById(id);
window.latestAdvice = {};


// ================= HELPERS =================
function fmtTime(ts){

  if(!ts) return "-";

  try{
    return new Date(ts).toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }catch{
    return "-";
  }
}


function pct(count, total){

  if(!total) return 0;

  return Number(((count / total) * 100).toFixed(1));
}


function getReasonAdvice(reason){

  const map = {
    MAX_OPEN_TRADES: "Max open trades bereikt. Geen filterprobleem.",
    SYMBOL_COOLDOWN: "Cooldown voorkomt dubbele entries op dezelfde coin.",
    COOLDOWN: "Cooldown actief na vorige trade.",
    OPPOSITE_POSITION_OPEN: "Tegengestelde positie wordt correct geblokkeerd.",
    DUPLICATE_PROCESSING_LOCK: "Duplicate protection werkt.",
    LOW_VOL: "Te weinig volatiliteit. Correct geblokkeerd.",
    NO_FLOW: "Geen duidelijke flow. Correct geblokkeerd.",
    LOW_CONFLUENCE: "Setup mist bevestiging. Confluence niet versoepelen.",
    FAKE_BREAKOUT: "Fake breakout bescherming werkt.",
    OB_AGAINST: "Orderboek staat tegen trade. Correct geblokkeerd.",
    NO_LIQUIDATION_ROOM: "Te weinig ruimte naar liquidation/TP-zone.",
    BAD_MARKET_QUALITY: "Spread/depth slecht. Correct geblokkeerd.",
    OB_NEUTRAL_LOW_CONF: "Orderboek neutraal. Alleen doorlaten bij hoge confluence.",
    EXTREME_FUNDING: "Funding-risico. Correct geblokkeerd.",
    BULL_CROWDED_FUNDING: "Long te crowded. Correct geblokkeerd.",
    BEAR_CROWDED_FUNDING: "Short te crowded. Correct geblokkeerd.",
    BTC_BULL_BLOCK_SHORT: "Short tegen bullish BTC geblokkeerd.",
    BTC_BEAR_BLOCK_LONG: "Long tegen bearish BTC geblokkeerd.",
    COUNTERTREND_NOT_ELITE: "Countertrend is niet elite genoeg. Correct.",
    ENTRY_FILTERED: "Entry kwam niet door laatste kwaliteitscheck."
  };

  if(String(reason || "").startsWith("SYMBOL_ALREADY_OPEN_")){
    return "Er staat al een positie open op deze coin. Correct geblokkeerd.";
  }

  return map[reason] || "Geen specifieke actie nodig.";
}


// ================= TOGGLE & UI =================
window.toggleAdvice = function(adviceId){

  const elAdvice = el(adviceId);
  if(!elAdvice) return;

  const isHidden = elAdvice.style.display === "none";
  elAdvice.style.display = isHidden ? "block" : "none";
};


function adviceItemToHtml(item){

  if(!item) return "";

  if(typeof item === "string"){
    return `<div>• ${item}</div>`;
  }

  const message = item.message || "Onbekend advies";

  let actionColor = "#a78bfa";

  if(item.action === "STRENGER") actionColor = "var(--red)";
  if(item.action === "SOEPELER") actionColor = "var(--green)";

  const action = item.action
    ? `<span style="background: rgba(139,92,246,0.2); color:${actionColor}; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:bold; margin-right:6px; border:1px solid ${actionColor};">${item.action}</span>`
    : "";

  const values = (item.current !== undefined && item.recommended !== undefined)
    ? `<div style="font-size:12px; opacity:0.8; margin-top:2px;">${item.current} → ${item.recommended}</div>`
    : "";

  return `<div style="margin-bottom:10px;">• ${action}${message}${values}</div>`;
}


// ================= GLOBAL ADVICE =================
function renderGlobalAdvice(data){

  const global = data?.advice?.global || [];

  if(!global.length){

    el("globalAdvice").style.display = "block";

    const bullCount = Number(data?.bullCount || 0);
    const bearCount = Number(data?.bearCount || 0);
    const candidates = Number(data?.candidates || 0);
    const trades = Array.isArray(data?.trades) ? data.trades.length : 0;

    el("globalAdviceContent").innerHTML = `
      Funnel gevuld: Bull ${bullCount}, Bear ${bearCount}.<br>
      Echte trade candidates: ${candidates}. TradeSystem outputs: ${trades}.<br>
      <span class="muted" style="font-size: 11px;">Analyse gebruikt alleen echte filter-coins.</span>
    `;

    return;
  }

  el("globalAdvice").style.display = "block";
  el("globalAdviceContent").innerHTML =
    global.map(g => `• ${g}`).join("<br/><br/>");
}


// ================= TRADE SYSTEM FALLBACK =================
function buildTradeSystemFallback(data){

  const list = Array.isArray(data?.trades)
    ? data.trades
    : [];

  const total = list.length;

  const entries = list.filter(t => t.action === "ENTRY");
  const waits = list.filter(t => t.action === "WAIT");
  const holds = list.filter(t => t.action === "HOLD");
  const partials = list.filter(t => t.action === "PARTIAL");
  const exits = list.filter(t => t.action === "EXIT");

  const waitMap = {};

  for(const w of waits){
    const key = String(w.reason || "UNKNOWN");
    waitMap[key] = (waitMap[key] || 0) + 1;
  }

  const waitReasons = Object.entries(waitMap)
    .map(([key, count]) => ({
      key,
      count,
      pct: pct(count, waits.length),
      advice: getReasonAdvice(key)
    }))
    .sort((a,b) => b.count - a.count);

  const avg = field => {

    const nums = list
      .map(x => Number(x?.[field] || 0))
      .filter(n => Number.isFinite(n));

    if(!nums.length) return 0;

    return Number((nums.reduce((a,b) => a + b, 0) / nums.length).toFixed(2));
  };

  const entryRate = pct(entries.length, total);
  const avgConfluence = avg("confluence");
  const avgRR = avg("rr");
  const topReason = waitReasons[0]?.key || null;

  const recommendations = {
    moreTrades: [],
    higherWinrate: [],
    higherPnl: []
  };

  if(total === 0){
    recommendations.moreTrades.push(
      "Scanner stuurt geen echte tradeCandidates. Meer trades krijg je via scanner-input, niet door TradeSystem filters los te gooien."
    );
    recommendations.moreTrades.push(
      "Veilige test: almost candidate threshold van 88 naar 85, terwijl TradeSystem de eindfilter blijft."
    );
  }

  if(total >= 8 && entryRate < 5){
    recommendations.moreTrades.push(
      "Entry-rate is laag. Stuur iets meer candidates naar TradeSystem in plaats van OB/confluence filters te versoepelen."
    );
  }

  if(topReason === "MAX_OPEN_TRADES"){
    recommendations.moreTrades.push(
      "Max open trades blokkeert entries. Overweeg MAX_OPEN_TRADES van 3 naar 4, maar alleen als gesloten trade-history positief blijft."
    );
  }

  if(topReason === "SYMBOL_COOLDOWN" || topReason === "COOLDOWN"){
    recommendations.moreTrades.push(
      "Cooldown blokkeert herentries. Verlaag cooldown pas na minimaal 30 gesloten trades."
    );
  }

  if(topReason === "ENTRY_FILTERED" && avgConfluence >= 78){
    recommendations.moreTrades.push(
      "Veel setups halen bijna de eindcheck. Test almost iets ruimer, maar alleen bij confluence ≥ 85."
    );
  }

  if(topReason === "OB_NEUTRAL_LOW_CONF" && avgConfluence >= 80){
    recommendations.moreTrades.push(
      "OB is vaak neutraal. Laat neutrale OB alleen door bij A-grade + confluence ≥ 88."
    );
  }

  if(topReason === "LOW_CONFLUENCE"){
    recommendations.higherWinrate.push(
      "Veel setups missen bevestiging. Confluence niet versoepelen; scanner moet betere candidates sturen."
    );
  }

  if(topReason === "OB_AGAINST"){
    recommendations.higherWinrate.push(
      "Orderboek staat vaak tegen de trade. Dit filter behouden voor hogere winrate."
    );
  }

  if(topReason === "BAD_MARKET_QUALITY"){
    recommendations.higherWinrate.push(
      "Slechte spread/depth wordt correct geblokkeerd. Dit verhoogt betrouwbaarheid."
    );
  }

  if(topReason === "NO_FLOW" || topReason === "LOW_VOL"){
    recommendations.higherWinrate.push(
      "Markt heeft te weinig flow/volatiliteit. Niet versoepelen; dit voorkomt chop trades."
    );
  }

  if(topReason === "COUNTERTREND_NOT_ELITE"){
    recommendations.higherWinrate.push(
      "Countertrend trades worden streng gefilterd. Dit is goed voor blind volgen."
    );
  }

  if(entries.length > 0 && avgConfluence < 75){
    recommendations.higherWinrate.push(
      "Entries hebben lage gemiddelde confluence. Maak entry alleen geldig bij confluence ≥ 78 of A-grade."
    );
  }

  if(entries.length > 0 && avgConfluence >= 80){
    recommendations.higherWinrate.push(
      "Entry kwaliteit is gezond. Niet strenger maken zonder verliesdata."
    );
  }

  if(entries.length > 0 && avgRR < 1){
    recommendations.higherPnl.push(
      "Gemiddelde RR is laag. Laat lage RR alleen toe bij A-grade en hoge confluence."
    );
  }

  if(entries.length > 0 && avgRR >= 1.2){
    recommendations.higherPnl.push(
      "RR is gezond. PnL verbeteren zit dan vooral in trailing/partials, niet in entries."
    );
  }

  if(topReason === "NO_LIQUIDATION_ROOM"){
    recommendations.higherPnl.push(
      "Te weinig ruimte naar liquidatie/TP-zone. Dit filter behouden; het beschermt PnL."
    );
  }

  if(entries.length > 0 && avgConfluence >= 85){
    recommendations.higherPnl.push(
      "Sterke confluence. Voor A-grade trades kun je partial iets later houden om meer upside te pakken."
    );
  }

  if(recommendations.moreTrades.length === 0){
    recommendations.moreTrades.push(
      "Meer trades nu niet forceren. Eerst huidige kwaliteit meten tot minimaal 20-30 gesloten trades."
    );
  }

  if(recommendations.higherWinrate.length === 0){
    recommendations.higherWinrate.push(
      "Winrate-filtering ziet er normaal uit. Houd OB, confluence, funding en countertrend guards actief."
    );
  }

  if(recommendations.higherPnl.length === 0){
    recommendations.higherPnl.push(
      "PnL-advies wordt sterker zodra trade-history gesloten WIN/LOSS trades bevat."
    );
  }

  let advice = "TradeSystem gezond. Geen directe wijziging nodig.";

  if(total === 0){
    advice = "Geen echte tradeCandidates deze scan. Meer trades krijg je via scanner-input, niet door TradeSystem losser te maken.";
  }else if(entries.length === 0 && waits.length > 0){
    advice = `Geen entries. Grootste blokkade: ${topReason || "UNKNOWN"}. Bekijk advies hieronder.`;
  }else if(entryRate > 25){
    advice = "Veel entries. Let op overtrading; kwaliteit eventueel iets strenger.";
  }else if(entryRate < 3 && total >= 10){
    advice = "Weinig entries uit veel candidates. Alleen versoepelen als grootste blokkade geen kwaliteitsfilter is.";
  }

  return {
    total,
    entries: entries.length,
    waits: waits.length,
    holds: holds.length,
    partials: partials.length,
    exits: exits.length,
    entryRate,
    waitRate: pct(waits.length, total),
    avgConfluence,
    avgRR,
    avgScore: avg("score"),
    waitReasons,
    recommendations,
    advice
  };
}


// ================= RENDER TRADE SYSTEM =================
function renderTradeSystemAnalysis(data){

  const box = el("tradeSystemAnalysis");
  if(!box) return;

  const ts = data.tradeSystemAnalysis || buildTradeSystemFallback(data);

  const waitReasons = Array.isArray(ts.waitReasons)
    ? ts.waitReasons
    : [];

  const rec = ts.recommendations || {
    moreTrades: [],
    higherWinrate: [],
    higherPnl: []
  };

  const recHtml = `
    <div class="system-advice">
      <strong>📈 Meer trades</strong><br>
      ${(rec.moreTrades || []).map(x => `• ${x}`).join("<br>")}
    </div>

    <div class="system-advice">
      <strong>🎯 Hogere winrate</strong><br>
      ${(rec.higherWinrate || []).map(x => `• ${x}`).join("<br>")}
    </div>

    <div class="system-advice">
      <strong>💰 Hogere PnL</strong><br>
      ${(rec.higherPnl || []).map(x => `• ${x}`).join("<br>")}
    </div>
  `;

  const rows = waitReasons.length
    ? waitReasons.map(r => `
        <div style="
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 12px;
          padding: 12px;
          margin-bottom: 10px;
        ">
          <div style="display:flex; justify-content:space-between; gap:8px; margin-bottom:6px;">
            <span style="font-weight:800; color:#fff;">${r.key}</span>
            <span style="color:#a78bfa; font-weight:800;">${r.count}x · ${r.pct}%</span>
          </div>
          <div style="color:var(--muted); font-size:13px; line-height:1.5;">
            ${r.advice}
          </div>
        </div>
      `).join("")
    : `<div class="muted" style="text-align:center; padding:10px;">Geen blokkades deze scan.</div>`;

  box.innerHTML = `
    <h2 style="color:#a78bfa; margin:0 0 14px; font-size:20px;">⚡ TradeSystem Analyse</h2>

    <div class="metric-grid">
      <div class="metric-box"><span>Total Candidates</span><strong>${ts.total || 0}</strong></div>
      <div class="metric-box"><span>Entries</span><strong>${ts.entries || 0}</strong></div>
      <div class="metric-box"><span>Waits</span><strong>${ts.waits || 0}</strong></div>
      <div class="metric-box"><span>Entry Rate</span><strong>${ts.entryRate || 0}%</strong></div>
      <div class="metric-box"><span>Avg Confluence</span><strong>${ts.avgConfluence || 0}</strong></div>
      <div class="metric-box"><span>Avg RR</span><strong>${ts.avgRR || 0}</strong></div>
    </div>

    <div class="system-advice">
      💡 ${ts.advice || "Geen advies beschikbaar."}
    </div>

    ${recHtml}

    <div style="margin-top:20px; margin-bottom:8px; font-size:11px; font-weight:800; color:#a78bfa; letter-spacing:1px; text-transform:uppercase;">
      Top Blokkades
    </div>

    <div>
      ${rows}
    </div>
  `;
}


// ================= FUNNEL BLOKKEN =================
function block(title, data, side){

  if(!data) return "";

  const adviceId = `advice-${side}-${title}`;
  const stageKey = title.toLowerCase();
  const adviceList = window.latestAdvice?.[side]?.[stageKey] || [];

  const adviceHtml = adviceList.length
    ? adviceList.map(adviceItemToHtml).join("")
    : "<span style='color: var(--green);'>✅ Flow is gezond. Geen specifiek advies.</span>";

  return `
    <div class="analysis-card">
      <div class="a-header">
        <div class="a-title">${title}</div>
        <div class="a-total">Total: ${data.total || 0}</div>
      </div>

      <div class="a-stats">
        <div class="a-stat-row"><span class="a-stat-label">Good</span><span class="a-stat-val good">${data.reasons?.good || "0%"}</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Low Score</span><span class="a-stat-val">${data.reasons?.lowScore || "0%"}</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Weak Flow</span><span class="a-stat-val">${data.reasons?.weakFlow || "0%"}</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Low Volume</span><span class="a-stat-val">${data.reasons?.lowVolume || "0%"}</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Bad OB</span><span class="a-stat-val">${data.reasons?.badOB || "0%"}</span></div>
      </div>

      <div class="advice-content" id="${adviceId}">
        <strong>💡 Filter Advies</strong>
        ${adviceHtml}
      </div>

      <div class="advice-toggle-btn" onclick="toggleAdvice('${adviceId}')">💡 Bekijk Systeem Advies</div>
    </div>
  `;
}


// ================= LOAD SCRIPT =================
async function load(){

  try{

    const res = await fetch(`/api/public-latest?t=${Date.now()}`, {
      cache: "no-store"
    });

    const data = await res.json();

    if(!data?.ok){
      throw new Error(data?.error || "API error");
    }

    window.latestAdvice = data.advice || {};

    if(data.btc && data.regime){
      el("statusLine").innerText =
        `BTC: ${data.btc.state} | Regime: ${data.regime} | Laatste scan: ${fmtTime(data.updatedAt || data.storedAt)}`;
    }

    if(!data.analytics){
      el("analytics").innerHTML =
        "<p style='color: var(--red);'>Geen analytics data gevonden.</p>";
      return;
    }

    renderGlobalAdvice(data);
    renderTradeSystemAnalysis(data);

    const a = data.analytics;
    let html = "";

    for(const side of ["bull", "bear"]){

      const color = side === "bull" ? "var(--green)" : "var(--red)";
      const icon = side === "bull" ? "🟢" : "🔴";

      html += `<h2 class="side-title" style="color:${color};">${icon} ${side.toUpperCase()}</h2>`;

      for(const stage of ["entry", "almost", "buildup", "radar"]){
        if(a[side]?.[stage]){
          html += block(stage.toUpperCase(), a[side][stage], side);
        }
      }
    }

    el("analytics").innerHTML = html;

  }catch(e){

    console.error("Analytics load error:", e);

    if(el("tradeSystemAnalysis")){
      el("tradeSystemAnalysis").innerHTML = `
        <h2 style="color:#a78bfa; margin:0 0 14px;">⚡ TradeSystem Analyse</h2>
        <p style="color:var(--red);">TradeSystem analyse kon niet geladen worden.</p>
      `;
    }

    if(el("analytics")){
      el("analytics").innerHTML =
        "<p style='color:red;'>Fout bij laden</p>";
    }
  }
}


setInterval(load, 15000);
load();