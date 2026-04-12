import { useEffect, useState } from "react"

export default function AnalysePage() {

  const [analysis, setAnalysis] = useState(null)

  useEffect(() => {
    fetch("/api/analyse")
      .then(r => r.json())
      .then(setAnalysis)
  }, [])

  return (
    <div style={{ padding: 40 }}>
      <h1>Analyse Meester</h1>

      <h2>Stats</h2>
      <pre>
        {JSON.stringify(analysis?.stats, null, 2)}
      </pre>

      <h2>Suggestions</h2>

      {analysis?.suggestions?.map((s, i) => (
        <div key={i} style={{ marginBottom: 20 }}>
          <strong>{s.type}</strong>
          <div>{s.message}</div>
          <div>Suggestion: {s.suggestedChange}</div>
          <div>Confidence: {Math.round(s.confidence * 100)}%</div>
        </div>
      ))}
    </div>
  )
}