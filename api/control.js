let MODE = "bull";

export default function handler(req, res) {
  if (req.query.mode) {
    MODE = req.query.mode;
  }

  res.json({ mode: MODE });
}