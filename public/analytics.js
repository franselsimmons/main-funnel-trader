const el = id => document.getElementById(id);

// Functie om 1 advies-item netjes te renderen
function adviceItemToHtml(item) {
  if (!item) return "";

  if (typeof item === "string") {
    return `• ${item}`;
  }

  const message = item.message || "";
  const change = item.change ? ` <span class="a-change">(${item.change})</span>` : "";
  const action = item.action ? `<span class="a-action">${item.action}</span> ` : "";

  return `• ${action}${message}${change}`;
}

// Functie om de HTML voor 1 statistiek-kaart te genereren
function block(title, data, side) {
  if (!data) return "";

  const adviceHtml =
    data.advice && data.advice.length
      ? data.advice.map(adviceItemToHtml).join("<br/>")
      : "Flow is gezond. Geen specifiek advies op dit moment.";

  return `
    <div class="analytics-card analytics-${side}">
      <div class="a-header">
        <div class="a-title">${title}</div>
        <div class="a-total">Total: ${data.total || 0}</div>
      </div>
      
      <div class="a-stats">
        <div class="a-stat-row">
          <span class="a-stat-label">Good</span>
          <span class="a-stat-val good">${data.reasons?.good || 0}</span>
        </div>
        <div class="a-stat-row">
          <span class="a-stat-label">Low Score</span>
          <span class="a-stat-val">${data.reasons?.lowScore || 0}</span>
        </div>
        <div class="a-stat-row">
          <span class="a-stat-label">Weak Flow</span>
          <span class="a-stat-val">${data.reasons?.weakFlow || 0}</span>
        </div>
        <div class="a-stat-row">
          <span class="a-stat-label">Low Volume</span>
          <span class="a-stat-val">${data.reasons?.lowVolume || 0}</span>
        </div>
        <div class="a-stat-row">
          <span class="a-stat-label">Bad OB</span>
          <span class="a-stat-val">${data.reasons?.badOB || 0}</span>
        </div>
      </div>
      
      <div class="a-advice">
        <strong>Systeem Advies</strong><br/>
        ${adviceHtml}
      </div>
    </div>
  `;
}

// Globaal adviesblok renderen
function renderGlobalAdvice(advice) {
  if (!advice) return "";

  const bull = advice.bull || {};
  const bear = advice.bear || {};
  const global = Array.isArray(advice.global) ? advice.global : [];

  let html = `
    <div class="analytics-card analytics-global">
      <div class="a-header">
        <div class="a-title">🧠 Globaal Systeem Advies</div>
        <div class="a-total">Live</div>
      </div>
      <div class="a-advice">
  `;

  if (global.length) {
    html += `<strong>Global</strong><br/>`;
    html += global.map(g => `• ${g}`).join("<br/>");
    html += `<br/><br/>`;
  }

  for (const sideName of ["bull", "bear"]) {
    const sideAdvice = sideName === "bull" ? bull : bear;
    const icon = sideName === "bull" ? "🟢" : "🔴";

    html += `<strong>${icon} ${sideName.toUpperCase()}</strong><br/>`;

    let found = false;

    for (const stage of ["entry", "almost", "buildup", "radar"]) {
      const list = sideAdvice?.[stage];

      if (Array.isArray(list) && list.length) {
        found = true;
        html += `<span class="a-stage">${stage.toUpperCase()}</span><br/>`;
        html += list.map(adviceItemToHtml).join("<br/>");
        html += `<br/><br/>`;
      }
    }

    if (!found) {
      html += `• Geen extra advies op dit moment.<br/><br/>`;
    }
  }

  html += `
      </div>
    </div>
  `;

  return html;
}

async function load() {
  try {
    const res = await fetch("/api/public-latest");
    const data = await res.json();

    if (!data.analytics) {
      el("analytics").innerHTML =
        "<p style='color: var(--red);'>Geen analytics data gevonden in API.</p>";
      return;
    }

    const a = data.analytics;
    let html = "";

    // Eerst globaal advies tonen
    if (data.advice) {
      html += renderGlobalAdvice(data.advice);
    }

    // Loop door Bull en Bear
    for (const side of ["bull", "bear"]) {
      const titleColor = side === "bull" ? "var(--green)" : "var(--red)";
      const icon = side === "bull" ? "🟢" : "🔴";

      html += `<h2 class="side-title" style="color: ${titleColor};">${icon} ${side.toUpperCase()} FUNNEL</h2>`;

      // Loop door de fases
      for (const stage of ["entry", "almost", "buildup", "radar"]) {
        if (a[side] && a[side][stage]) {
          html += block(stage.toUpperCase(), a[side][stage], side);
        }
      }
    }

    el("analytics").innerHTML = html;

  } catch (error) {
    console.error("Fetch fout:", error);
    el("analytics").innerHTML =
      "<p style='color: var(--red);'>Fout bij het laden van analytics data.</p>";
  }
}

// Haal data elke 15 seconden op
setInterval(load, 15000);

// Laad direct bij het openen
load();