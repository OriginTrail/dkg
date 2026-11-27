import type { Rfc64CatalogReplayPeerReservationV1, Rfc64CatalogReplayPeerDemandHandleV1 } from '../../src/rfc64/catalog-replay-types-v1.js';
import type { Rfc64CatalogConnectionReplayResultV1 } from '../../src/rfc64/catalog-replay-run-reporter-v1.js';
import { afterEach, vi } from 'vitest';
import { Rfc64CatalogReplayConnectionRuntimeV1, type Rfc64CatalogReplayConnectionRuntimePortsV1 } from '../../src/rfc64/catalog-replay-connection-runtime-v1.js';
import { Rfc64BackgroundWorkDispatcherV1 } from '../../src/rfc64/background-work-dispatcher-v1.js';
export const owners: Rfc64BackgroundWorkDispatcherV1[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.closeAndDrain()));
  vi.useRealTimers();
});

export type TestConnectionPorts = Omit<Rfc64CatalogReplayConnectionRuntimePortsV1, 'reserveFence'> & {
  reserveFence(contextGraphId: string, peerId: string): Rfc64CatalogReplayPeerReservationV1 | null;
  replay(contextGraphId: string, demand: Rfc64CatalogReplayPeerDemandHandleV1, signal: AbortSignal): Promise<Rfc64CatalogConnectionReplayResultV1>;
};
export function makeRuntime(ports: Omit<TestConnectionPorts, 'admittedConnectedPeerIds' | 'schedule' | 'wait'>
  & Partial<Pick<TestConnectionPorts, 'admittedConnectedPeerIds' | 'schedule' | 'wait'>>,
  debounceMs?: number, maxPeers?: number): Rfc64CatalogReplayConnectionRuntimeV1 {
  const owner = new Rfc64BackgroundWorkDispatcherV1(); owners.push(owner);
  return new Rfc64CatalogReplayConnectionRuntimeV1({
    admittedConnectedPeerIds: () => [],
    schedule: (slot, work) => owner.scheduleKeyed(`replay:${slot}`, work),
    wait: (signal, delay) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    }),
    ...ports,
    reserveFence: (cg, peer) => {
      const lease = ports.reserveFence(cg, peer);
      return lease === null ? null : { isCurrent: () => lease.isCurrent(), release: () => lease.release(),
        replay: signal => { lease.admit(); return ports.replay(cg, lease, signal); } };
    },
  }, debounceMs, maxPeers);
}

