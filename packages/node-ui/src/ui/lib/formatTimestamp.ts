/**
 * Render a timestamp with date awareness so old entries are
 * unmistakable from fresh ones (BUG-003).
 *
 * - Same-day: "3:57 PM" (compact, the dropdown's intended form).
 * - Yesterday: "Yesterday 8:12 PM" — sub-24h-but-not-same-day
 *   should still be unambiguous.
 * - Earlier same week: "Mon 9:14 AM".
 * - Older: "Mar 11, 2026, 9:00 AM".
 *
 * Deliberately a separate module so Vitest can import the helper
 * without booting Header.tsx (which depends on `localStorage` at
 * module init via the layout store and therefore can't be loaded
 * inside node-test environments).
 */
export function formatNotificationTimestamp(
  ts: string | number | Date | undefined,
  now: Date = new Date(),
): string {
  if (ts == null || ts === '') return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  const diffMs = now.getTime() - d.getTime();
  if (diffMs >= 0 && diffMs < 7 * 24 * 60 * 60 * 1000) {
    const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Comparator for sorting notification-shaped objects newest-first.
 *
 * `Notification.ts` is a unix-epoch number (see `api.ts`). The naive
 * comparator
 *
 *   (a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts))
 *
 * silently breaks because `Date.parse('1716732000000')` is `NaN`,
 * which makes the comparator return `NaN` for every pair and leaves
 * the dropdown unsorted. We therefore compare the numeric values
 * directly, falling back to 0 for missing/non-finite/non-numeric
 * timestamps so a stray `null` doesn't push the entire list to
 * the top.
 */
export function compareNotificationByTsDesc(
  a: { ts?: number | null },
  b: { ts?: number | null },
): number {
  const at = typeof a.ts === 'number' && Number.isFinite(a.ts) ? a.ts : 0;
  const bt = typeof b.ts === 'number' && Number.isFinite(b.ts) ? b.ts : 0;
  return bt - at;
}
