async function load(){

  const res = await fetch("/api/public-latest");
  const data = await res.json();

  document.getElementById("signals").innerHTML =
    data.signals.map(s=>`
      <div class="coin">
        <b>${s.symbol}</b><br/>
        Signal: ${s.signal}<br/>
        Stage: ${s.stage}<br/>
        Score: ${s.score}
      </div>
    `).join("");
}

setInterval(load,15000);
load();