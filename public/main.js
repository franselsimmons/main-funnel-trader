async function loadHome() {
  try {
    const res = await fetch(`/api/public-latest`);
    const data = await res.json();

    document.getElementById("btcState").innerText = data.btc?.state || "Unknown";
    document.getElementById("regimeState").innerText = data.regime || "Unknown";
  } catch (error) {
    document.getElementById("btcState").innerText = "Error";
    document.getElementById("regimeState").innerText = "Error";
  }
}

setInterval(loadHome, 15000);
loadHome();
