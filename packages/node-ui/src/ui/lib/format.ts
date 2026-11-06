/**
 * Shared display formats (see DESIGN.md · Data display). Dense rows use
 * `formatTime` in hooks.ts and tokens have their own files; everything else
 * reads from here, so a date, count or ID looks the same on every screen.
 */

/** Shortens an address, hash or peer ID around an ellipsis. Keep the full value in a tooltip or accessible name. */
export function truncateAddress(address: string, head = 6, tail = 4): string {
  const value = (address ?? '').trim();
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** A date and time in full, for tooltips and detail rows. A value that isn't a date comes back as it was. */
export function formatDateTime(value: string | number | Date, options: { seconds?: boolean } = {}): string {
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value.replace(/^"|"$/g, '') : value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
  });
}

/** A count with the reader's own digit grouping. */
export function formatNumber(value: number): string {
  return value.toLocaleString();
}

/** Basis points as a percentage figure: 2500 is "25", 1250 is "12.5". */
export function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(bps % 100 === 0 ? 0 : 1);
}

/** Basis points with the sign: 2500 is "25%". */
export function formatBps(bps: number): string {
  return `${bpsToPercent(bps)}%`;
}

/** A node's role as people read it: Core or Edge. Anything else shows as it came. */
export function formatNodeRole(role: string | null | undefined): string {
  if (role === 'core') return 'Core';
  if (role === 'edge') return 'Edge';
  return role || '—';
}
