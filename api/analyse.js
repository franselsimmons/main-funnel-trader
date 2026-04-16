export default function handler(req, res) {
  res.json({
    system: "MAIN",
    status: "ACTIVE",
    timestamp: Date.now()
  });
}