export default function handler(req, res) {
  res.json({
    message: "Analyse endpoint actief",
    timestamp: Date.now()
  });
}