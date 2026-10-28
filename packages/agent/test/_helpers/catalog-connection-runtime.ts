import { afterEach, vi } from 'vitest';
import { Rfc64CatalogReplayConnectionRuntimeV1, type Rfc64CatalogReplayConnectionRuntimePortsV1 } from '../../src/rfc64/catalog-replay-connection-runtime-v1.js';
import { Rfc64BackgroundWorkDispatcherV1 } from '../../src/rfc64/background-work-dispatcher-v1.js';
export const owners: Rfc64BackgroundWorkDispatcherV1[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.closeAndDrain()));
  vi.useRealTimers();
});

export function makeRuntime(ports: Omit<Rfc64CatalogReplayConnectionRuntimePortsV1, 'schedule' | 'wait'>
  & Partial<Pick<Rfc64CatalogReplayConnectionRuntimePortsV1, 'schedule' | 'wait'>>,
  debounceMs?: number, maxPeers?: number): Rfc64CatalogReplayConnectionRuntimeV1 {
  const owner = new Rfc64BackgroundWorkDispatcherV1(); owners.push(owner);
  return new Rfc64CatalogReplayConnectionRuntimeV1({
    schedule: (slot, work) => owner.scheduleKeyed(`replay:${slot}`, work),
    wait: (signal, delay) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    }),
    ...ports,
  }, debounceMs, maxPeers);
}

