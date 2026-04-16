const el = id => document.getElementById(id);

// Functie om de HTML voor 1 statistiek-kaart te genereren
function block(title, data, side){
  if (!data) return "";

  const adviceId = `advice-${side}-${title}`;
  const adviceHtml = data.advice && data.advice.length
    ? data.advice.map(adviceItemToHtml).join("<br/>")
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
      
      <div class="advice-content" id="${adviceId}">
        <strong>💡 Filter Advies</strong>
        ${adviceHtml}
      </div>
      
      <div class="advice-toggle-btn" onclick="toggleAdvice('${adviceId}')">💡 Bekijk Systeem Advies</div>
    </div>
  `;
}

// Functie om advies te tonen/verbergen
window.toggleAdvice = function(adviceId){
  const adviceContent = el(adviceId);
  const isHidden = adviceContent.style.display === "none" || adviceContent.style.display === "";
  adviceContent.style.display = isHidden ? "block" : "none";
};

// Functie om advies badges netjes te renderen
function adviceItemToHtml(item){
  if (!item) return "";
  if (typeof item === "string") return `• ${item}`;

  const message = item.message || "";
  let actionColor = "#a78bfa"; 
  if (item.action === "STRENGER") actionColor = "var(--red)";
  if (item.action === "SOEPELER") actionColor = "var(--green)";

  const action = item.action ? `<span style="background: rgba(139, 92, 246, 0.2); color: ${actionColor}; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; margin-right: 6px; border: 1px solid ${actionColor};">${item.action}</span>` : "";

  return `<div style="margin-bottom: 8px;">• ${action}${message}</div>`;
}

// Globaal advies renderen in de specifieke box bovenaan
function renderGlobalAdvice(advice){
  if (!advice || !advice.global || advice.global.length === 0) {
    el("globalAdvice").style.display = "none";
    return;
  }

  el("globalAdvice").style.display = "block";
  el("globalAdviceContent").innerHTML = advice.global.map(g => `• ${g}`).join("<br/><br/>");
}

async function load(){
  try {
    const res = await fetch("/api/public-latest");
    const data = await res.json();

    // Vul het statusLine element in met BTC en Regime info, net als op Bull en Bear
    if (data.btc && data.regime) {
      el("statusLine").innerText = `BTC: ${data.btc.state} | Regime: ${data.regime}`;
    }

    if (!data.analytics) {
      el("analytics").innerHTML = "<p style='color: var(--red);'>Geen analytics data gevonden in API.</p>";
      return;
    }

    const a = data.analytics;
    let html = "";

    if (data.advice) {
      renderGlobalAdvice(data.advice);
    } else {
      el("globalAdvice").style.display = "none";
    }

    for(const side of ["bull","bear"]){
      const titleColor = side === "bull" ? "var(--green)" : "var(--red)";
      const icon = side === "bull" ? "🟢" : "🔴";

      html += `<h2 class="side-title" style="color: ${titleColor};">${icon} ${side.toUpperCase()} FUNNEL</h2>`;

      for(const stage of ["entry","almost","buildup","radar"]){
        if (a[side] && a[side][stage]) {
          html += block(stage.toUpperCase(), a[side][stage], side);
        }
      }
    }

    el("analytics").innerHTML = html;

  } catch (error) {
    console.error("Fetch fout:", error);
    el("analytics").innerHTML = "<p style='color: var(--red);'>Fout bij het laden van analytics data.</p>";
  }
}

// 15 sec auto-refresh
setInterval(load, 15000);
load();
