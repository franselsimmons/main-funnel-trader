const el = id => document.getElementById(id);

// Functie om de HTML voor 1 statistiek-kaart te genereren (verborgen advies)
function block(title, data, side){
  if (!data) return "";

  // De lappen tekst in pop-ups verbergen
  const adviceId = `advice-${side}-${title}`;
  const adviceHtml = data.advice && data.advice.length
    ? data.advice.map(adviceItemToHtml).join("<br/>")
    : "<p style='color: var(--green);'>✅ Flow is gezond. Geen specifiek advies.</p>";

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
        <strong>💡 Systeem Advies</strong>
        ${adviceHtml}
      </div>
      
      <div class="advice-toggle-btn" onclick="toggleAdvice('${adviceId}')">💡 Bekijk Systeem Advies</div>
    </div>
  `;
}

// Functie om advies te tonen/verbergen (pop-up effect)
window.toggleAdvice = function(adviceId){
  const adviceContent = el(adviceId);
  const isHidden = adviceContent.style.display === "none" || adviceContent.style.display === "";
  adviceContent.style.display = isHidden ? "block" : "none";
};

// Functie om 1 advies-item netjes te renderen zonder specifieke code-nummers
function adviceItemToHtml(item){
  if (!item) return "";
  if (typeof item === "string") return `• ${item}`;

  const message = item.message || "";
  
  // Gekleurde badges voor de actie
  let actionColor = "#a78bfa"; // Paars voor algemeen
  if (item.action === "STRENGER") actionColor = "var(--red)";
  if (item.action === "SOEPELER") actionColor = "var(--green)";

  const action = item.action ? `<span class="a-action" style="background: rgba(139, 92, 246, 0.2); color: ${actionColor}; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; margin-right: 6px; border: 1px solid ${actionColor};">${item.action}</span>` : "";

  return `• ${action}${message}`;
}

// Globaal adviesblok renderen bovenaan
function renderGlobalAdvice(advice){
  if (!advice || !advice.global || advice.global.length === 0) {
    el("globalAdvice").style.display = "none";
    return;
  }

  el("globalAdvice").style.display = "block";
  el("globalAdviceContent").innerHTML = advice.global.map(g => `• ${g}`).join("<br/>");
}

async function load(){
  try {
    const res = await fetch("/api/public-latest");
    const data = await res.json();

    if (!data.analytics) {
      el("analytics").innerHTML = "<p style='color: var(--red);'>Geen analytics data gevonden in API.</p>";
      return;
    }

    const a = data.analytics;
    let html = "";

    // Eerst globaal advies tonen
    if (data.advice) {
      renderGlobalAdvice(data.advice);
    } else {
      el("globalAdvice").style.display = "none";
    }

    // Loop door Bull en Bear
    for(const side of ["bull","bear"]){
      const titleColor = side === "bull" ? "var(--green)" : "var(--red)";
      const icon = side === "bull" ? "🟢" : "🔴";

      html += `<h2 class="side-title" style="color: ${titleColor};">${icon} ${side.toUpperCase()} FUNNEL</h2>`;

      // Loop door de fases (ENTRY bovenaan)
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

// Haal data elke 15 seconden op
setInterval(load, 15000);

// Laad direct bij het openen
load();
