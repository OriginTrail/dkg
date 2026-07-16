/**
 * Render the multiline tooltip surfaced on the global header status
 * pill (BUG-020). Operators previously had no way to see the
 * direct/relayed connection breakdown or the node uptime without
 * jumping to Settings; the tooltip puts both one hover away.
 *
 * Deliberately a separate module so Vitest can import the helper
 * without booting `Header.tsx` (which transitively pulls in the
 * layout store, which calls `localStorage` at module init and so
 * can't be loaded in a node test environment).
 *
 * The output is a `\n`-separated string suitable for the `title=`
 * attribute. Chrome wraps `title=` on `\n` but NOT on `\r` or
 * `<br>`, so the choice of separator is part of the contract.
 */
export function formatPeerStatusTooltip(
  synced: boolean,
  peers: number,
  direct: number,
  relayed: number,
  uptimeMs: number,
): string {
  const lines = [
    synced ? 'Synced with the network' : 'Syncing with the network',
    `${peers} peer${peers === 1 ? '' : 's'} (${direct} direct, ${relayed} relayed)`,
  ];
  if (uptimeMs > 0) lines.push(`Uptime ${formatUptimeShort(uptimeMs)}`);
  return lines.join('\n');
}

function formatUptimeShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}
