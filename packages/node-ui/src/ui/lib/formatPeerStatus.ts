import { NODE_STATUS_POLL_MS, NODE_UNAVAILABLE_AFTER_FAILURES } from './nodeStatusPolicy.js';

export interface HeaderNodeStatus {
  word: string;
  tone: 'success' | 'warning' | 'danger' | 'pending';
  showPeers: boolean;
  /** Set when the peer tooltip doesn't apply, because no live status backs it. */
  tooltip?: string;
}

/**
 * The header's node status. It says only what the node reports, which is its
 * peer connections: `/api/status` carries no sync state.
 */
export function headerNodeStatus(
  statusLoaded: boolean,
  connectedPeers: number,
  statusFailures: number,
): HeaderNodeStatus {
  if (statusFailures >= NODE_UNAVAILABLE_AFTER_FAILURES) {
    return { word: 'Unavailable', tone: 'danger', showPeers: false, tooltip: `The node is not responding. Checking again every ${NODE_STATUS_POLL_MS / 1000} seconds.` };
  }
  if (!statusLoaded) {
    return { word: 'Connecting', tone: 'pending', showPeers: false, tooltip: 'Connecting to the node' };
  }
  return connectedPeers > 0
    ? { word: 'Connected', tone: 'success', showPeers: true }
    : { word: 'No peers', tone: 'warning', showPeers: false };
}

/**
 * Render the multiline tooltip surfaced on the global header peer
 * count (BUG-020). Operators previously had no way to see the
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
  peers: number,
  direct: number,
  relayed: number,
  uptimeMs: number,
): string {
  const lines = peers > 0
    ? ['Connected to the network', `${peers} peer${peers === 1 ? '' : 's'} (${direct} direct, ${relayed} relayed)`]
    : ['No peers connected'];
  if (uptimeMs > 0) lines.push(`Uptime ${formatUptime(uptimeMs)}`);
  return lines.join('\n');
}

/** Uptime as days, hours and minutes, the same everywhere it shows. */
export function formatUptime(ms: number): string {
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
