// Functie om het totaal aantal coins in een funnel op te tellen (voor het stickertje)
function countFunnel(funnelType) {
  if (!funnelType) return 0;
  
  // Tel entry, almost en buildup bij elkaar op (radar is vaak nog te breed)
  const entryCount = funnelType.entry ? funnelType.entry.length : 0;
  const almostCount = funnelType.almost ? funnelType.almost.length : 0;
  const buildupCount = funnelType.buildup ? funnelType.buildup.length : 0;
  
  return entryCount + almostCount + buildupCount; 
}

async function loadHome() {
  try {
    const res = await fetch(`/api/public-latest`);
    const data = await res.json();

    // Update Live Status in de Hero Kaart
    document.getElementById("btcState").innerText = data.btc?.state || "Unknown";
    document.getElementById("regimeState").innerText = (data.regime || "Unknown") + " 🟢";

    // Update de Live Badges op de dashboard kaarten
    if (data.funnel && data.funnel.bull) {
      document.getElementById("bullCount").innerText = countFunnel(data.funnel.bull);
    }
    
    if (data.funnel && data.funnel.bear) {
      document.getElementById("bearCount").innerText = countFunnel(data.funnel.bear);
    }

    if (data.trades) {
      document.getElementById("tradeCount").innerText = data.trades.length;
    }

  } catch (error) {
    console.error("Fout bij laden van data:", error);
    document.getElementById("btcState").innerText = "Fout";
    document.getElementById("regimeState").innerText = "Fout";
  }
}

// Haal data elke 10 seconden op zodat het dashboard lekker up-to-date blijft
setInterval(loadHome, 10000);

// Laad direct bij het openen
loadHome();
