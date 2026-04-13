export function progressiveStage({
  prev,
  passes,
  now
}) {
  let stage = prev?.stage ?? 0;
  let streak = prev?.streak ?? 0;

  if (passes) {
    streak += 1;

    if (streak >= 2 && stage < 1) stage = 1;
    if (streak >= 4 && stage < 2) stage = 2;
    if (streak >= 6 && stage < 3) stage = 3;
  } else {
    streak = Math.max(0, streak - 1);
    if (streak === 0 && stage > 0) stage -= 1;
  }

  return { stage, streak, updatedAt: now };
}