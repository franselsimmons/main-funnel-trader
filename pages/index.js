export default function Home() {
  return (
    <div style={{
      padding: 40,
      background: "#0b1220",
      color: "white",
      minHeight: "100vh"
    }}>
      <h1>CryptoCroc V5</h1>
      <p>Trading System Online</p>

      <div style={{ marginTop: 20 }}>
        <a href="/analyse" style={{ marginRight: 20 }}>Analyse</a>
        <a href="/api/scan?mode=bull" style={{ marginRight: 20 }}>Run Bull Scan</a>
        <a href="/api/scan?mode=bear">Run Bear Scan</a>
      </div>
    </div>
  );
}