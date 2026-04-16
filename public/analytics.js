const el = id => document.getElementById(id);

// Functie om 1 advies-item netjes te renderen zonder specifieke nummers
function adviceItemToHtml(item) {
  if (!item) return "";
  if (typeof item === "string") return `<div style="margin-bottom: 8px;">• ${item}</div>`;

  const message = item.message || "";
  let actionBadge = "";
  
  if (item.action === "STRENGER") {
    actionBadge = `<span class="badge-strenger">STRENGER</span>`;
  } else if (item.action === "SOEPELER") {
    actionBadge = `<span class="badge-soepeler">SOEPELER</span>`;
  }

  return `
    <div style="margin-bottom: 12px; display: flex; align-items: center; gap: 10px;">
      ${actionBadge} 
      <span style="color: #e2e8f0; font-size: 13px; line-height: 1.4;">${message}</span>
    </div>
  `;
}

// Globaal adviesblok bovenaan renderen
function renderGlobalAdvice(advice) {
  if (!advice) return "";
  const global = Array.isArray(advice.global) ? advice.global : [];
  if (global.length === 0) return "";

  return `
    <div class="analytics-card" style="border-color: #8b5cf6; box-shadow: 0 5px 20px rgba(139, 92, 246, 0.15);">
      <div class="a-header" style="border-bottom: none; margin-bottom: 0; padding-bottom: 0;">
        <div class="a-title" style="color: #a78bfa;">🧠 Globaal Systeem Status</div>
      </div>
      <div style="margin-top: 12px; font-size: 14px; font-weight: 600; line-height: 1.5;">
        ${global.map(g => `${g}`).join("<br/><br/>")}
      </div>
    </div>
  `;
}

// Functie om de HTML voor 1 statistiek-kaart te genereren (verborgen advies)
window.toggleAdvice = function(id) {
  const element = document.getElementById(id);
  element.style.display = element.style.display === "none" ? "block" : "none";
};

function block(title, data, side) {
  if (!data) return "";

  const adviceId = `adv-${side}-${title}`;
  const adviceHtml = data.advice && data.advice.length
    ? data.advice.map(adviceItemToHtml).join("")
    : `<span style="color: var(--green);">✅ Geen aanpassingen nodig.</span>`;

  return `
    <div class="analytics-card">
      <div class="a-header">
        <div class="a-title">${title}</div>
        <div class="a-total">Total: ${data.total || 0}</div>
      </div>
      
      <div class="a-stats">
        <div class="a-stat-row"><span class="a-stat-label">Good</span><span class="a-stat-val good">${data.reasons?.good || 0}%</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Low Score</span><span class="a-stat-val">${data.reasons?.lowScore || 0}%</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Weak Flow</span><span class="a-stat-val">${data.reasons?.weakFlow || 0}%</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Low Volume</span><span class="a-stat-val">${data.reasons?.lowVolume || 0}%</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Bad OB</span><span class="a-stat-val">${data.reasons?.badOB || 0}%</span></div>
      </div>
      
      <button onclick="toggleAdvice('${adviceId}')" style="width: 100%; padding: 12px; background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 8px; color: #a78bfa; font-weight: bold; cursor: pointer; text-align: center; font-size: 13px;">
        💡 Bekijk Filter Advies
      </button>

      <div id="${adviceId}" style="display: none; margin-top: 12px; padding: 16px; background: rgba(0,0,0,0.2); border-radius: 8px; border-left: 3px solid #8b5cf6;">
        ${adviceHtml}
      </div>
    </div>
  `;
}

async function load() {
  try {
    const res = await fetch("/api/public-latest");
    const data = await res.json();

    // Statusline update net als op de andere pagina's
    if (data.btc && data.regime) {
      el("statusLine").innerText = `BTC: ${data.btc.state} | Regime: ${data.regime}`;
    }

    if (!data.analytics) {
      el("analytics").innerHTML = "<p style='color: var(--red);'>Geen analytics data gevonden in API.</p>";
      return;
    }

    const a = data.analytics;
    let html = "";

    if (data.advice) html += renderGlobalAdvice(data.advice);

    for (const side of ["bull", "bear"]) {
      const titleColor = side === "bull" ? "var(--green)" : "var(--red)";
      const icon = side === "bull" ? "🟢" : "🔴";

      html += `<h2 class="side-title" style="color: ${titleColor};">${icon} ${side.toUpperCase()} FUNNEL</h2>`;

      for (const stage of ["entry", "almost", "buildup", "radar"]) {
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

setInterval(load, 15000);
load();
