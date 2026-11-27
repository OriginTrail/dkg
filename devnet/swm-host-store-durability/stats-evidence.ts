export function requireGraphFrameCount(perCg: Record<string, { entries: number }> | undefined,
  contextGraphId: string, wireId: string | undefined, expectedFrames: number): void {
  const keys = new Set([contextGraphId.toLowerCase(), ...(wireId ? [wireId.toLowerCase()] : [])]);
  const row = Object.entries(perCg ?? {}).find(([key]) => keys.has(key.toLowerCase()))?.[1];
  if (!row) throw new Error(`Host stats omit tested graph ${contextGraphId}`);
  if (row.entries !== expectedFrames) throw new Error(`Host stats for ${contextGraphId}: ${row.entries} entries, expected ${expectedFrames}`);
}
