// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';
import { probeSnapshotPeerBatches } from './public-snapshot-peer-probes.js';
import type { SnapshotSourcePolicy } from './public-snapshot-policy.js';

export interface SnapshotSourcePorts extends Pick<SnapshotSourcePolicy, 'probe' | 'unavailableMessage'> {
  selfPeerId: string;
  /** Bounded phonebook/connected candidates are hints, never trust evidence. */
  candidates(signal: AbortSignal): Promise<readonly string[]>;
  connect(peer: string, signal: AbortSignal): Promise<void>;
}

/** Every source accepted by the bound policy may qualify; one job probes at most 16 hints,
 * four at a time, and pins at most four proven sources. Random order avoids a
 * fixed preferred core. Nothing changes the caller's one-hour job lifetime. */
export async function selectSnapshotSources(
  ports: SnapshotSourcePorts,
  signal: AbortSignal,
): Promise<readonly string[]> {
  signal.throwIfAborted();
  const nonce = randomBytes(32).toString('hex');
  const rank = (peer: string) => createHash('sha256').update(nonce).update(peer).digest('hex');
  const candidates = [...new Set(await ports.candidates(signal))]
    .filter(peer => typeof peer === 'string' && peer.length > 0 && peer.length <= 256 && peer !== ports.selfPeerId)
    .map(peer => ({ peer, rank: rank(peer) })).sort((a, b) => a.rank.localeCompare(b.rank))
    .slice(0, 16).map(candidate => candidate.peer);
  const selected: string[] = [];
  for await (const proven of probeSnapshotPeerBatches({
    candidates, connect: (peer, probeSignal) => ports.connect(peer, probeSignal),
    authenticate: (peer, probeSignal) => ports.probe(peer, nonce, probeSignal),
  }, signal)) {
    selected.push(...proven.slice(0, 4 - selected.length));
    if (selected.length === 4) break;
  }
  signal.throwIfAborted();
  if (!selected.length) throw new Error(ports.unavailableMessage);
  return Object.freeze(selected);
}
