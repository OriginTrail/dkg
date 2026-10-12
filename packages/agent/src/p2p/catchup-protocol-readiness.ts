import { mapWithConcurrency } from '../map-with-concurrency.js';

/** Check peer readiness with bounded probes while retaining candidate order. */
export async function selectSyncCapablePeers(
  peers: readonly { toString(): string }[],
  maxConcurrentProbes: number,
  probe: (peer: { toString(): string }) => Promise<boolean>,
): Promise<{ syncCapable: string[]; noProtocolPeers: number }> {
  const readiness = await mapWithConcurrency(peers, maxConcurrentProbes, probe);
  return {
    syncCapable: peers.filter((_peer, index) => readiness[index]).map((peer) => peer.toString()),
    noProtocolPeers: readiness.filter((ready) => !ready).length,
  };
}
