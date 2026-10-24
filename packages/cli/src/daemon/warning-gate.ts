/** Whether an attribution warns now, and how many repeats it held back since its last warning. */
type WarningDecision = { readonly warn: true; readonly heldBack: number } | { readonly warn: false };

/**
 * One warning per key per interval, over a bounded key set that evicts the
 * least recently warned key first. A window that starts in the future (the
 * clock stepped back) has expired.
 */
export function createWarningGate(
  now: () => number,
  intervalMs: number,
  cacheMax: number,
): (key: string) => WarningDecision {
  const windows = new Map<string, { warnedAt: number; heldBack: number }>();
  return (key) => {
    const at = now();
    const window = windows.get(key);
    if (window !== undefined) {
      const elapsed = at - window.warnedAt;
      if (elapsed >= 0 && elapsed < intervalMs) {
        window.heldBack += 1;
        return { warn: false };
      }
    } else if (windows.size >= cacheMax) {
      const oldest = windows.keys().next();
      if (!oldest.done) windows.delete(oldest.value);
    }
    windows.delete(key);
    windows.set(key, { warnedAt: at, heldBack: 0 });
    return { warn: true, heldBack: window?.heldBack ?? 0 };
  };
}

