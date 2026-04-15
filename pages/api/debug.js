import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const [bull, bear, bullOpen, bearOpen] = await Promise.all([
    kv.get("state:bull"),
    kv.get("state:bear"),
    kv.get("open:bull"),
    kv.get("open:bear"),
  ]);

  res.json({
    ok: true,
    bull: {
      entry: bull?.funnel?.entry_ready?.length || 0,
      open: bullOpen?.length || 0,
    },
    bear: {
      entry: bear?.funnel?.entry_ready?.length || 0,
      open: bearOpen?.length || 0,
    },
  });
}