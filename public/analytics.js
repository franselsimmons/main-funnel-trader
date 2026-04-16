const el = id => document.getElementById(id);

// 🔥 toevoegen (globaal opslaan)
window.latestAdvice = {};


// ================= BLOCK =================
function block(title, data, side){

  if (!data) return "";

  const adviceId = `advice-${side}-${title}`;

  // 🔥 NIEUW: juiste advies ophalen
  const stageKey = title.toLowerCase();

  const adviceList =
    window.latestAdvice?.[side]?.[stageKey] || [];

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
        <div class="a-stat-row">
          <span class="a-stat-label">Good</span>
          <span class="a-stat-val good">${data.reasons?.good || 0}%</span>
        </div>
        <div class="a-stat-row">
          <span class="a-stat-label">Low Score</span>
          <span class="a-stat-val">${data.reasons?.lowScore || 0}%</span>
        </div>
        <div class="a-stat-row">
          <span class="a-stat-label">Weak Flow</span>
          <span class="a-stat-val">${data.reasons?.weakFlow || 0}%</span>
        </div>
        <div class="a-stat-row">
          <span class="a-stat-label">Low Volume</span>
          <span class="a-stat-val">${data.reasons?.lowVolume || 0}%</span>
        </div>
        <div class="a-stat-row">
          <span class="a-stat-label">Bad OB</span>
          <span class="a-stat-val">${data.reasons?.badOB || 0}%</span>
        </div>
      </div>
      
      <div class="advice-content" id="${adviceId}" style="display:none;">
        <strong>💡 Filter Advies</strong>
        ${adviceHtml}
      </div>
      
      <div class="advice-toggle-btn" onclick="toggleAdvice('${adviceId}')">
        💡 Bekijk Systeem Advies
      </div>
    </div>
  `;
}


// ================= TOGGLE =================
window.toggleAdvice = function(adviceId){
  const elAdvice = el(adviceId);
  const isHidden = elAdvice.style.display === "none";
  elAdvice.style.display = isHidden ? "block" : "none";
};


// ================= ADVICE ITEM =================
function adviceItemToHtml(item){

  if (!item) return "";

  // 🔥 extra safe (voorkomt undefined)
  if (typeof item === "string") {
    return `<div>• ${item}</div>`;
  }

  const message = item.message || "Onbekend advies";

  let actionColor = "#a78bfa";

  if (item.action === "STRENGER") actionColor = "var(--red)";
  if (item.action === "SOEPELER") actionColor = "var(--green)";

  const action = item.action
    ? `<span style="
        background: rgba(139,92,246,0.2);
        color:${actionColor};
        padding:2px 6px;
        border-radius:4px;
        font-size:11px;
        font-weight:bold;
        margin-right:6px;
        border:1px solid ${actionColor};
      ">${item.action}</span>`
    : "";

  const values = (item.current !== undefined && item.recommended !== undefined)
    ? `<div style="font-size:12px; opacity:0.8; margin-top:2px;">
         ${item.current} → ${item.recommended}
       </div>`
    : "";

  return `
    <div style="margin-bottom:10px;">
      • ${action}${message}
      ${values}
    </div>
  `;
}


// ================= GLOBAL =================
function renderGlobalAdvice(advice){

  if (!advice || !advice.global || advice.global.length === 0){
    el("globalAdvice").style.display = "none";
    return;
  }

  el("globalAdvice").style.display = "block";

  el("globalAdviceContent").innerHTML =
    advice.global.map(g => `• ${g}`).join("<br/><br/>");
}


// ================= LOAD =================
async function load(){

  try{

    const res = await fetch("/api/public-latest");
    const data = await res.json();

    // 🔥 BELANGRIJK: opslaan
    window.latestAdvice = data.advice || {};

    if (data.btc && data.regime){
      el("statusLine").innerText =
        `BTC: ${data.btc.state} | Regime: ${data.regime}`;
    }

    if (!data.analytics){
      el("analytics").innerHTML =
        "<p style='color: var(--red);'>Geen analytics data gevonden.</p>";
      return;
    }

    if (data.advice){
      renderGlobalAdvice(data.advice);
    } else {
      el("globalAdvice").style.display = "none";
    }

    const a = data.analytics;
    let html = "";

    for(const side of ["bull","bear"]){

      const color = side === "bull" ? "var(--green)" : "var(--red)";
      const icon = side === "bull" ? "🟢" : "🔴";

      html += `<h2 style="color:${color};">${icon} ${side.toUpperCase()}</h2>`;

      for(const stage of ["entry","almost","buildup","radar"]){
        if(a[side]?.[stage]){
          html += block(stage.toUpperCase(), a[side][stage], side);
        }
      }
    }

    el("analytics").innerHTML = html;

  }catch(e){

    console.error(e);

    el("analytics").innerHTML =
      "<p style='color:red;'>Fout bij laden</p>";
  }
}


// ================= INIT =================
setInterval(load, 15000);
load();