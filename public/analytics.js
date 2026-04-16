const el = id => document.getElementById(id);

// Simpele functie om een sectie in/uit te klappen (Toggle)
window.toggleAdvice = function(id) {
  const element = document.getElementById(id);
  if (element.style.display === "none") {
    element.style.display = "block";
  } else {
    element.style.display = "none";
  }
};

// Functie om 1 advies-item netjes te renderen
function adviceItemToHtml(item) {
  if (!item) return "";
  if (typeof item === "string") return `• ${item}`;

  const message = item.message || "";
  
  // Kleur badges op basis van de actie
  let actionBadge = "";
  if (item.action === "STRENGER") {
    actionBadge = `<span style="background: rgba(239, 68, 68, 0.2); color: var(--red); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-right: 6px;">STRENGER</span>`;
  } else if (item.action === "SOEPELER") {
    actionBadge = `<span style="background: rgba(34, 197, 94, 0.2); color: var(--green); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-right: 6px;">SOEPELER</span>`;
  } else if (item.action) {
    actionBadge = `<span style="background: rgba(255, 255, 255, 0.1); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-right: 6px;">${item.action}</span>`;
  }

  return `<div style="margin-bottom: 8px;">${actionBadge} <span style="color: #e2e8f0; font-size: 13px;">${message}</span></div>`;
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
      <div style="margin-top: 12px; font-size: 14px; font-weight: 600;">
        ${global.map(g => `${g}`).join("<br/>")}
      </div>
    </div>
  `;
}

// Render statistiek blok + verborgen advies per fase
function block(title, data, side) {
  if (!data) return "";

  const adviceId = `advice-${side}-${title}`;
  
  let adviceContent = "";
  if (data.advice && data.advice.length > 0) {
    adviceContent = data.advice.map(adviceItemToHtml).join("");
  } else {
    adviceContent = `<span style="color: var(--green);">✅ Geen aanpassingen nodig, instellingen lijken optimaal.</span>`;
  }

  return `
    <div class="analytics-card">
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
      
      <button onclick="toggleAdvice('${adviceId}')" style="width: 100%; padding: 10px; background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 8px; color: #a78bfa; font-weight: bold; cursor: pointer; text-align: center; font-size: 13px;">
        💡 Bekijk Systeem Advies
      </button>

      <div id="${adviceId}" style="display: none; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 8px; border-left: 3px solid #8b5cf6;">
        ${adviceContent}
      </div>
    </div>
  `;
}

async function load() {
  try {
    const res = await fetch("/api/public-latest");
    const data = await res.json();

    if (!data.analytics) {
      el("analytics").innerHTML = "<p style='color: var(--red);'>Geen analytics data gevonden in API.</p>";
      return;
    }

    const a = data.analytics;
    let html = "";

    // Toon het globale advies (Tekort/Teveel entries)
    if (data.advice) {
      html += renderGlobalAdvice(data.advice);
    }

    // Render Bull en Bear Funnels
    for (const side of ["bull", "bear"]) {
      const titleColor = side === "bull" ? "var(--green)" : "var(--red)";
      const icon = side === "bull" ? "🟢" : "🔴";

      html += `<h2 class="side-title" style="color: ${titleColor};">${icon} ${side.toUpperCase()} FUNNEL</h2>`;

      // Doorloop de fases (ENTRY bovenaan)
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

// Haal data elke 15 seconden op
setInterval(load, 15000);

// Laad direct bij het openen
load();
